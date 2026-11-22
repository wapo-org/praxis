import {describe, expect, it} from 'vitest';
import {approvalKey, argsHash, issueApproval, type BoundaryContext} from '@praxis/agent';
import {SealedSecret} from '@praxis/types';
import {FakeSandboxPort, MemoryExportSink} from './fake.js';
import {sha256} from './support.js';
import {notebookRun} from './tools/notebook.js';
import {executeSandboxTool, sandboxToolClassifier} from './tools/registry.js';

const ROOT = '/workspace/chats/notebook';
const ok = {status: 'ok', text: '', truncated: false, artifacts: [], restarted: false, message: ''};
async function receipt(b: BoundaryContext, call: {tool: string; args: {code: string}}) {
  return issueApproval(b.key, {runId: b.runId, toolCallId: b.toolCallId, tool: call.tool, argsHash: await argsHash(call.args)}, 10000, 'notebook-cell');
}
async function boundary(): Promise<BoundaryContext> {
  return {mode: 'build', runId: 'run', toolCallId: 'cell', taint: {tainted: false}, nowMs: () => 1000,
    key: await approvalKey(SealedSecret.of('k'.repeat(32))), replay: {consume: async () => true}};
}
function setup(reply: unknown = ok) {
  const port = new FakeSandboxPort().on(() => ({stdout: JSON.stringify(reply)}));
  const exports = new MemoryExportSink();
  return {port, exports, context: {port, root: ROOT, exports}};
}
async function runError(reply: unknown) {
  const {context} = setup(reply);
  const b = await boundary();
  const call = {tool: 'notebook_run', args: {code: 'value'}};
  return executeSandboxTool(call, b, context, await receipt(b, call));
}

describe('notebook_run', () => {
  it('requires approval for arbitrary Python and taints successful results', async () => {
    const {port, context} = setup();
    const b = await boundary();
    const call = {tool: 'notebook_run', args: {code: 'value = 42'}};
    expect(sandboxToolClassifier.classify(call)).toMatchObject({decision: 'approve', capabilities: ['exec', 'read']});
    expect(await executeSandboxTool(call, b, context)).toMatchObject({
      ok: false, untrustedSource: false, taint: {tainted: false}, error: {code: 'approval-required'},
    });
    expect(port.calls).toHaveLength(0);
    const result = await executeSandboxTool(call, b, context, await receipt(b, call));
    expect(result).toMatchObject({ok: true, taint: {tainted: true}});
  });

  it('taints workspace text in a failed cell and blocks the subsequent unapproved write', async () => {
    const code = "raise ValueError(open('untrusted.txt').read())";
    const untrusted = 'workspace-controlled instructions';
    const port = new FakeSandboxPort().writeText(`${ROOT}/untrusted.txt`, untrusted);
    port.on(request => {
      const input = JSON.parse(port.readText(request.argv[7]!)!);
      expect(input.code).toBe(code);
      return {stdout: JSON.stringify({status: 'execution', message: `ValueError: ${port.readText(`${ROOT}/untrusted.txt`)}`})};
    });
    const context = {port, root: ROOT, exports: new MemoryExportSink()};
    const b = await boundary();
    const call = {tool: 'notebook_run', args: {code}};
    const failed = await executeSandboxTool(call, b, context, await receipt(b, call));
    expect(failed).toMatchObject({
      ok: false, untrustedSource: true, taint: {tainted: true},
      error: {code: 'upstream', message: `ValueError: ${untrusted}`, remediation: expect.any(String)},
    });
    if (failed.ok) throw new Error('Expected the notebook cell to fail.');
    const write = await executeSandboxTool({tool: 'edit_file', args: {
      path: 'after-error.txt', old_text: '', new_text: 'unapproved write',
    }}, {...b, toolCallId: 'after-error', taint: failed.taint}, context);
    expect(write).toMatchObject({ok: false, error: {code: 'taint-blocked'}});
    expect(port.readText(`${ROOT}/after-error.txt`)).toBeUndefined();
    expect(port.calls).toHaveLength(1);
  });

  it('sends successive cells through the same sandbox driver and reports lost variables on restart', async () => {
    const port = new FakeSandboxPort();
    let value: number | undefined;
    let restarted = false;
    port.on(request => {
      const input = JSON.parse(port.readText(request.argv[7]!)!);
      if (input.code === 'value = 42') value = 42;
      return {stdout: JSON.stringify({...ok, text: String(value), restarted, message: restarted ? 'variables were lost' : ''})};
    });
    const context = {port, root: ROOT, exports: new MemoryExportSink()};
    await notebookRun(context, {code: 'value = 42'});
    expect(await notebookRun(context, {code: 'value'})).toMatchObject({text: '42', restarted: false});
    restarted = true;
    value = undefined;
    expect(await notebookRun(context, {code: 'value'})).toMatchObject({message: 'variables were lost', restarted: true});
    expect(new Set(port.calls.map(call => call.argv[6])).size).toBe(1);
  });

  it('exports PNG and HTML with refs and sha256 and caps ANSI text', async () => {
    const png = `${ROOT}/notebook-1/0.png`;
    const html = `${ROOT}/notebook-1/1.html`;
    const {port, context, exports} = setup({...ok, text: '\u001b[31m' + 'x'.repeat(40000), artifacts: [png, html]});
    port.writeText(png, 'PNG').writeText(html, '<p>hello</p>');
    const result = await notebookRun(context, {code: 'display(plot)'});
    expect(result).toMatchObject({truncated: true, artifacts: [
      {ref: 'export-1', mediaType: 'image/png', sha256: sha256('PNG')},
      {ref: 'export-2', mediaType: 'text/html', sha256: sha256('<p>hello</p>')},
    ]});
    expect(result.text).not.toContain('\u001b');
    expect(exports.items).toHaveLength(2);
  });

  it.each(['timeout', 'conflict', 'upstream', 'execution', 'budget'])('returns %s failures with remediations', async status => {
    expect(await runError({status, message: 'cell failed'})).toMatchObject({ok: false, error: {
      code: status === 'execution' ? 'upstream' : status, remediation: expect.any(String),
    }});
  });

  it('explains interrupted and drained output failures in the remediation', async () => {
    expect(await runError({status: 'output-error', message: 'Malformed PNG.'})).toMatchObject({
      ok: false, error: {code: 'upstream', remediation: expect.stringContaining('interrupted and drained to idle')},
    });
  });

  it('reports variable loss when a timeout requires stopping an unresponsive kernel', async () => {
    expect(await runError({status: 'timeout-reset', message: 'Kernel stopped; variables were lost'})).toMatchObject({
      ok: false, error: {code: 'timeout', remediation: expect.stringContaining('variables were lost')},
    });
  });

  it('returns a remediation when workspace setup fails without dispatching code', async () => {
    expect(await runError({status: 'setup-error', message: 'Workspace setup failed.'})).toMatchObject({
      ok: false, error: {code: 'upstream', remediation: expect.stringContaining('no user cell was dispatched')},
    });
  });

  it('rejects malformed replies, transport failures and escaped artifacts with remediations', async () => {
    expect(await runError({status: 'ok'})).toMatchObject({ok: false, error: {code: 'schema', remediation: expect.any(String)}});
    expect(await runError({...ok, artifacts: ['/etc/passwd']})).toMatchObject({ok: false, error: {code: 'path-traversal'}});
    const {context} = setup();
    context.port.exec = async () => { throw new Error('offline'); };
    await expect(notebookRun(context, {code: '1'})).rejects.toMatchObject({detail: {code: 'upstream', remediation: expect.any(String)}});
    await expect(notebookRun(context, {code: '', timeout_ms: 0})).rejects.toMatchObject({detail: {code: 'schema'}});
  });

});
