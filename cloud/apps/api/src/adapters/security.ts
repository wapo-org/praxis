import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

/**
 * Egress policy for user-supplied URLs (MCP servers, providers, skill registries, tool fetches).
 * Production denies loopback, private, link-local, metadata, CGNAT, multicast, documentation and
 * IPv6 ULA/transition ranges, resolves DNS once, pins the connection to the validated addresses
 * (no rebinding), and re-validates every redirect hop.
 */
export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface EgressPolicy {
  /** Local development/tests: allow loopback/private destinations and plain HTTP. */
  allowLocal?: boolean;
  /** Allow plain HTTP to public destinations (default false). */
  allowHttp?: boolean;
  /** DNS resolver override (tests). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Address filter override (tests). Defaults to `isPublicAddress` unless `allowLocal`. */
  isAllowedAddress?: (address: string) => boolean;
}

export interface SafeFetchOptions extends EgressPolicy {
  /** Maximum response body bytes (default 10 MiB). Exceeding it errors the body stream. */
  maxBytes?: number;
  /** Total time budget per request, including redirects and body (default 30 s). */
  timeoutMs?: number;
  /** Maximum redirect hops (default 5). */
  maxRedirects?: number;
}

export class EgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

const v4 = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);

function inV4(ip: string, base: string, bits: number) {
  const size = 2 ** (32 - bits);
  return Math.floor(v4(ip) / size) === Math.floor(v4(base) / size);
}

function v6(ip: string): bigint {
  const [left, right] = ip.toLowerCase().split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const parts = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return parts.reduce((n, p) => (n << 16n) + BigInt(`0x${p || '0'}`), 0n);
}

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 3], // multicast, reserved, broadcast
];

/** Conservative public-unicast check. IPv6 must be global unicast (2000::/3) outside transition/doc ranges. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.some(([base, bits]) => inV4(address, base, bits));
  // Mapped/embedded IPv4 forms and zone ids are rejected outright.
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const n = v6(address);
  const prefix = (base: string, bits: number) => n >> BigInt(128 - bits) === v6(base) >> BigInt(128 - bits);
  return (
    prefix('2000::', 3) &&
    !prefix('2001::', 23) && // IETF protocol assignments incl. Teredo
    !prefix('2001:db8::', 32) && // documentation
    !prefix('2002::', 16) && // 6to4
    !prefix('3fff::', 20) // documentation
  );
}

const BLOCKED_HOST = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;

function normalizeHost(hostname: string) {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function parse(input: string | URL, policy: EgressPolicy) {
  let url: URL;
  try {
    url = new URL(z.string().min(1).max(8192).parse(String(input)));
  } catch {
    throw new EgressError('Invalid URL');
  }
  const httpOk = policy.allowLocal || policy.allowHttp;
  if (url.protocol !== 'https:' && !(httpOk && url.protocol === 'http:')) {
    throw new EgressError('Egress requires an HTTPS URL');
  }
  if (url.username || url.password) throw new EgressError('URLs with credentials are not allowed');
  const hostname = normalizeHost(url.hostname);
  if (!hostname) throw new EgressError('Invalid URL');
  if (!policy.allowLocal && (BLOCKED_HOST.test(hostname) || !hostname.includes('.') && !isIP(hostname))) {
    throw new EgressError('Private egress destination');
  }
  return { url, hostname };
}

async function resolveAndCheck(input: string | URL, policy: EgressPolicy) {
  const { url, hostname } = parse(input, policy);
  const allowed = policy.isAllowedAddress ?? (policy.allowLocal ? () => true : isPublicAddress);
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await (policy.resolve ?? ((h) => lookup(h, { all: true, verbatim: true })))(hostname).catch(() => {
        throw new EgressError('Destination did not resolve');
      });
  if (!addresses.length) throw new EgressError('Destination did not resolve');
  // Every resolved address must be allowed, or a rebinding resolver could pick the private one.
  if (addresses.some((a) => isIP(a.address) !== a.family || !allowed(a.address))) {
    throw new EgressError('Private egress destination');
  }
  return { url, hostname, addresses };
}

/** Validates a URL for egress and returns it parsed. Throws `EgressError` on any violation. */
export async function assertPublicUrl(input: string | URL, policy: EgressPolicy = {}): Promise<URL> {
  return (await resolveAndCheck(input, policy)).url;
}

/** Dialer that only connects to the already validated addresses; TLS SNI and Host keep the hostname. */
function pinnedAgent(hostname: string, addresses: ResolvedAddress[]) {
  return new Agent({
    connect: {
      lookup: (host, opts, callback) => {
        if (normalizeHost(host) !== hostname) {
          callback(new EgressError('Egress host changed'), '', 0);
          return;
        }
        if (opts.all) {
          (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, addresses);
          return;
        }
        const a = addresses.find((x) => !opts.family || x.family === opts.family) ?? addresses[0]!;
        callback(null, a.address, a.family);
      },
    },
  });
}

function limitBody(body: ReadableStream<Uint8Array>, maxBytes: number, done: () => void) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new EgressError('Response body too large'));
          done();
          return;
        }
        controller.enqueue(chunk);
      },
      flush() {
        done();
      },
    }),
  );
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'api-key'];

/**
 * `fetch` with the egress policy applied to the first hop and every redirect.
 * Cross-origin redirects drop credential headers; 301/302/303 become GET without a body.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): typeof fetch {
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 5;

  return async (input, init) => {
    const original = new Request(input, init);
    const signals = [AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [original.signal])];
    const signal = AbortSignal.any(signals);
    let method = original.method;
    let headers = new Headers(original.headers);
    // Buffer the request body once so 307/308 can replay it.
    let body: ArrayBuffer | undefined =
      method === 'GET' || method === 'HEAD' ? undefined : await original.arrayBuffer();
    let target = original.url;

    for (let hop = 0; ; hop++) {
      const { url, hostname, addresses } = await resolveAndCheck(target, options);
      const agent = pinnedAgent(hostname, addresses);
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          void agent.close().catch(() => {});
        }
      };
      let response;
      try {
        response = await undiciFetch(url, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal,
          dispatcher: agent,
        } as never);
      } catch (e) {
        close();
        if (signal.aborted) throw new EgressError('Egress request timed out or was aborted');
        throw e;
      }

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        close();
        if (hop >= maxRedirects) throw new EgressError('Too many redirects');
        const next = new URL(location, url);
        if (next.origin !== url.origin) for (const h of SENSITIVE_HEADERS) headers.delete(h);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'HEAD')) {
          method = method === 'HEAD' ? 'HEAD' : 'GET';
          body = undefined;
          headers = new Headers(headers);
          headers.delete('content-type');
          headers.delete('content-length');
        }
        target = next.href;
        continue;
      }

      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > maxBytes) {
        await response.body?.cancel().catch(() => {});
        close();
        throw new EgressError('Response body too large');
      }
      const nullBody = response.status === 204 || response.status === 304 || method === 'HEAD' || !response.body;
      if (nullBody) close();
      const out = new Response(
        nullBody ? null : limitBody(response.body as ReadableStream<Uint8Array>, maxBytes, close),
        { status: response.status, statusText: response.statusText, headers: response.headers as unknown as Headers },
      );
      Object.defineProperty(out, 'url', { value: url.href });
      return out;
    }
  };
}
