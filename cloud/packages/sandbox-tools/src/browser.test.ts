import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {JsonValue} from '@praxis/protocol';
import {SealedSecret} from '@praxis/types';
import {approvalKey, type BoundaryContext} from '@praxis/agent';
import {FakeSandboxPort, MemoryExportSink} from './fake.js';
import {sha256} from './support.js';
import {browser, BrowserInputSchema, BROWSER_OUTPUT_MAX_BYTES} from './tools/browser.js';
import {executeSandboxTool, sandboxToolClassifier} from './tools/registry.js';
import {browserSandboxOptions} from './modal/browser-network.js';
const ROOT = '/workspace/chats/browser';
const PNG = new Uint8Array([137, 80, 78, 71]);
function setup() {
  const port = new FakeSandboxPort();
  const exports = new MemoryExportSink();
  return {port, exports, context: {port, exports, root: ROOT, browserNetworkRestricted: true}};
}
async function boundary(tainted = false): Promise<BoundaryContext> {
  return {mode: 'build', runId: 'run', toolCallId: 'call', taint: {tainted}, nowMs: () => 1_000, key: await approvalKey(SealedSecret.of('k'.repeat(32))), replay: {consume: async () => true}};
}

describe('browser over SandboxPort', () => {
  it('replays the fixture sign-in flow as argv without shell interpolation', async () => {
    const {port, context} = setup();
    const fixture = readFileSync(new URL('../../browser-cli/fixtures/login.html', import.meta.url), 'utf8');
    expect(fixture).toContain('Sign in');
    port.writeText(`${ROOT}/login.html`, fixture);
    let typed = false;
    let signedIn = false;
    port.on(({argv}) => {
      const action = argv[4];
      if (action === 'type') typed = argv[5] === 'textbox:Email' && argv[6] === 'a@example.test; $(echo secret)';
      if (action === 'click') signedIn = typed && argv[5] === 'button:Sign in';
      if (action === 'wait-for') expect(signedIn).toBe(true);
      const output = action === 'snapshot' ? {ok: true, snapshot: signedIn ? 'heading "Welcome"' : 'button "Sign in" [ref=e1]'} : {ok: true};
      return {stdout: JSON.stringify(output)};
    });
    for (const args of [
      {action: 'open'}, {action: 'goto', url: 'https://fixture.example.test/login'}, {action: 'snapshot'},
      {action: 'type', target: 'textbox:Email', text: 'a@example.test; $(echo secret)'},
      {action: 'click', target: 'button:Sign in'}, {action: 'wait-for', target: 'heading:Welcome'}, {action: 'close'},
    ]) await browser(context, args);
    expect(port.calls.every(call => call.argv[0] === 'praxis-browser' && call.cwd === ROOT && call.argv[2] === `${ROOT}/.praxis/browser/session.json`)).toBe(true);
  });

  it('exports the screenshot bytes and verifies their proof hash', async () => {
    const {port, context, exports} = setup();
    const path = `${ROOT}/browser-screenshot.png`;
    port.files.set(path, PNG);
    port.on(() => ({stdout: JSON.stringify({ok: true, path, bytes: PNG.length, sha256: sha256(PNG)})}));
    expect(await browser(context, {action: 'screenshot'})).toMatchObject({artifact: {ref: 'export-1', sha256: sha256(PNG), mediaType: 'image/png'}});
    expect(exports.items[0]?.bytes).toEqual(PNG);
    port.on(() => undefined);
    port.files.set(path, new Uint8Array([1]));
    await expect(browser(context, {action: 'screenshot'})).rejects.toThrow(/changed/);
  });

  it('fails closed on unrestricted egress, invalid output, timeout and oversized snapshots', async () => {
    const {port, context} = setup();
    await expect(browser({...context, browserNetworkRestricted: false}, {action: 'open'})).rejects.toThrow(/public-only/);
    expect(port.calls).toHaveLength(0);
    for (const result of [{timedOut: true}, {exitCode: 1}, {stdout: 'bad json'}, {stdout: '{"ok":false}'}, {stdout: 'x'.repeat(BROWSER_OUTPUT_MAX_BYTES + 1)}]) {
      const f = setup();
      f.port.on(() => result);
      await expect(browser(f.context, {action: 'snapshot'})).rejects.toThrow();
    }
  });

  it('refuses session and screenshot symlinks outside the chat', async () => {
    for (const path of ['.praxis', 'browser-screenshot.png']) {
      const {port, context} = setup();
      port.link(`${ROOT}/${path}`, '/etc');
      await expect(browser(context, {action: 'open'})).rejects.toThrow(/outside/);
      expect(port.calls).toHaveLength(0);
    }
  });

  it('taints reads and requires approval for navigation and actions', async () => {
    const {port, context} = setup();
    port.on(() => ({stdout: '{"ok":true,"snapshot":"untrusted"}'}));
    expect(await executeSandboxTool({tool: 'browser', args: {action: 'snapshot'}}, await boundary(), context)).toMatchObject({ok: true, taint: {tainted: true}});
    const actions: JsonValue[] = [{action: 'goto', url: 'https://example.com'}, {action: 'click', target: 'e1'}, {action: 'type', target: 'textbox:Email', text: 'hello'}];
    for (const args of actions) {
      expect(await executeSandboxTool({tool: 'browser', args}, await boundary(true), context)).toMatchObject({ok: false});
      expect(sandboxToolClassifier.classify({tool: 'browser', args})?.capabilities).toContain('external-egress');
    }
    expect(port.calls).toHaveLength(1);
    expect(BrowserInputSchema.safeParse({action: 'goto', url: 'file:///etc/passwd'}).success).toBe(false);
  });

  it('allows public IPv4 destinations while excluding private, metadata, special and IPv6 destinations', () => {
    const ranges = browserSandboxOptions().outboundCidrAllowlist;
    const number = (ip: string) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
    const allowed = (ip: string) => ranges.some(cidr => {
      const [base, bits] = cidr.split('/');
      return Math.floor(number(ip) / 2 ** (32 - Number(bits))) === Math.floor(number(base!) / 2 ** (32 - Number(bits)));
    });
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) expect(allowed(ip), ip).toBe(true);
    for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) expect(allowed(ip), ip).toBe(false);
    expect(ranges.every(cidr => !cidr.includes(':'))).toBe(true);
  });
});
