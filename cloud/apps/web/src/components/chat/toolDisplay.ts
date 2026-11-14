import type { ActiveToolStep } from '../../state/types';

/** WP-K shared contract: the API's human copy for a tool row. Optional; absent on older events. */
export interface ToolDisplay {
  title: string;
  detail?: string;
  connectorId?: string;
  connectorName?: string;
  /** A lucide icon name or a connector favicon URL. */
  icon?: string;
}

export interface ToolRowDisplay {
  title: string;
  detail: string;
  connectorName?: string;
  icon?: string;
  /** The machine name (`mcp__firecrawl__firecrawl_search_bbc9571288db`); shown only in the expanded detail. */
  technical?: string;
}

const HASH = /_[0-9a-f]{8,}$/i;
const META = /^mcp_(call|describe|search)_tools?$/;
const KEY_ARGS = ['query', 'q', 'url', 'urls', 'path', 'file_path', 'command', 'cmd', 'code', 'name', 'title', 'prompt', 'question', 'objective'];

const words = (s: string) => s.replace(/[_./-]+/g, ' ').replace(/\s+/g, ' ').trim();
const capital = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** `mcp__<server>__<tool>_<hash>` → { server, tool } with the hash and the repeated server name dropped. */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!m) return null;
  const server = m[1]!;
  let tool = m[2]!.replace(HASH, '');
  const s = server.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = tool.split(/[_-]+/).filter(Boolean);
  // "firecrawl_search" on the Firecrawl server is "search"; "web_search_exa" on Exa is "web search".
  const kept = parts.filter((p, i) => !(p.toLowerCase() === s && parts.length > 1 && (i === 0 || i === parts.length - 1)));
  tool = kept.join(' ');
  return { server, tool };
}

function serverLabel(server: string, serverName?: string) {
  return serverName?.trim() || capital(words(server));
}

function parseArgs(json: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The one argument that says what the call is about, as plain text. */
export function keyArgument(args: Record<string, unknown>): string {
  for (const k of KEY_ARGS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim() && !v.includes('{{secret:') && !v.includes('mcp__')) {
      return v.trim().replace(/\s+/g, ' ').slice(0, 160);
    }
    if (Array.isArray(v) && typeof v[0] === 'string') return v.join(', ').slice(0, 160);
  }
  const first = Object.values(args).find((v) => typeof v === 'string' && v.trim() && v.length < 200 && !v.includes('{{secret:') && !v.includes('mcp__'));
  return typeof first === 'string' ? first.trim() : '';
}

/** A bare id or hash says nothing to a person: it stays in the detail. */
const plainDetail = (s: string) => (/^[0-9a-f-]{8,}$/i.test(s.trim()) ? '' : s);

function urlHost(args: Record<string, unknown>): string {
  const rawUrl = typeof args.url === 'string' ? args.url : Array.isArray(args.urls) && typeof args.urls[0] === 'string' ? args.urls[0] : '';
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** Strip machine prefixes, hex hashes, and long numeric ids from any user-facing label. */
export function humanLabel(value: string): string {
  return value
    .replace(/mcp__([^_].*?)__([^\s]+)/gi, (full, server: string) => {
      const parsed = parseMcpName(full);
      return parsed ? `${serverLabel(parsed.server)} ${parsed.tool}` : `${serverLabel(server)}`;
    })
    .replace(/_[0-9a-f]{8,}\b/gi, '')
    .replace(/[0-9]{9,}/g, '')
    .replace(/__/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanMcpAction(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  serverName?: string,
  technical?: string,
): ToolRowDisplay {
  const connector = serverLabel(server, serverName);
  if (/search/.test(tool)) {
    return { title: 'Searching the web', detail: plainDetail(keyArgument(args)), connectorName: connector, technical };
  }
  if (/scrape|fetch|browse|crawl/.test(tool)) {
    const host = urlHost(args);
    return {
      title: host ? `Reading ${host}` : 'Reading the web',
      detail: host ? '' : plainDetail(keyArgument(args)),
      connectorName: connector,
      technical,
    };
  }
  return { title: `${connector} · ${tool}`, detail: plainDetail(keyArgument(args)), connectorName: connector, technical };
}

function readDisplay(step: ActiveToolStep): ToolDisplay | undefined {
  const d = (step.activity as { display?: unknown }).display;
  if (!d || typeof d !== 'object') return undefined;
  const title = (d as ToolDisplay).title;
  return typeof title === 'string' && title.trim() ? (d as ToolDisplay) : undefined;
}

/** Human title and detail for a tool row: K1's `display` when present, else our own humaniser. */
export function toolDisplay(step: ActiveToolStep): ToolRowDisplay {
  const result = resolveToolDisplay(step);
  return {
    ...result,
    title: humanLabel(result.title),
    detail: humanLabel(result.detail),
  };
}

function resolveToolDisplay(step: ActiveToolStep): ToolRowDisplay {
  const activity = step.activity as ActiveToolStep['activity'] & { originalName?: string };
  const raw = activity.name;
  const technical = activity.originalName || raw;
  const display = readDisplay(step);
  const args = parseArgs(step.argumentsJson);
  const serverName = activity.source?.serverName;
  // The catalogue meta-tools get a generic display ("Call connector tool"); name the tool they act on instead.
  const metaTarget = META.test(raw) && typeof args.tool === 'string' && parseMcpName(args.tool) ? args.tool : '';
  const mcp = parseMcpName(raw);
  if (mcp) {
    const human = humanMcpAction(mcp.server, mcp.tool, args, serverName, technical);
    return {
      ...human,
      ...(display?.icon ? { icon: display.icon } : {}),
      ...(display?.connectorName ? { connectorName: display.connectorName } : {}),
    };
  }
  if (display && !metaTarget) {
    return {
      title: display.title,
      detail: display.detail ?? '',
      connectorName: display.connectorName,
      icon: display.icon,
      technical: technical !== display.title ? technical : undefined,
    };
  }
  // The catalogue meta-tools: name the tool they act on, not themselves.
  const meta = META.exec(raw);
  if (meta) {
    const target = typeof args.tool === 'string' ? args.tool : typeof args.name === 'string' ? args.name : '';
    const inner = target ? parseMcpName(target) : null;
    const innerArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? (args.arguments as Record<string, unknown>) : {};
    if (meta[1] === 'call') {
      if (inner) return humanMcpAction(inner.server, inner.tool, innerArgs, undefined, target || raw);
      const innerTitle = target ? capital(words(target.replace(HASH, ''))) : '';
      return { title: innerTitle || 'Connector tool', detail: plainDetail(keyArgument(innerArgs)), technical: target || raw };
    }
    if (meta[1] === 'describe') {
      const innerTitle = inner ? `${serverLabel(inner.server)} · ${inner.tool}` : target ? capital(words(target.replace(HASH, ''))) : '';
      return { title: innerTitle ? `Look up ${innerTitle}` : 'Look up a tool', detail: '', icon: 'book-open', connectorName: inner ? serverLabel(inner.server) : undefined, technical: target || raw };
    }
    return { title: 'Find tools', detail: plainDetail(keyArgument(args)), technical: raw };
  }
  // `mcp_<server>_<tool>` (one underscore): the server is the first word.
  const single = /^mcp_([a-z0-9]+)_(.+)$/i.exec(raw);
  if (single && !META.test(raw)) {
    const server = serverLabel(single[1]!, serverName);
    return { title: `${server} · ${words(single[2]!.replace(HASH, ''))}`, detail: plainDetail(keyArgument(args)), connectorName: server, technical };
  }
  const human = capital(words(raw.replace(HASH, '')));
  const candidate = step.running ? activity.presentation?.runningTitle : activity.presentation?.finishedTitle;
  const cleanCandidate =
    candidate &&
    candidate !== raw &&
    candidate !== `Running ${raw}` &&
    !/mcp__|_[0-9a-f]{8,}|[0-9]{9,}/i.test(candidate)
      ? candidate
      : human;
  const cleanTitle = cleanCandidate.replace(HASH, '').replace(/\s[0-9a-f]{8,}(?=\s|$)/gi, '');
  const argDetail = keyArgument(args);
  const detail = argDetail === raw || argDetail === cleanTitle ? '' : argDetail;
  return { title: cleanTitle, detail: plainDetail(detail), technical: technical !== cleanTitle ? technical : undefined };
}
