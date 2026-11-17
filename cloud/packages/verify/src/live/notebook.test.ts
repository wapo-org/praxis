import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {executeSandboxTool} from '../../../sandbox-tools/src/tools/registry.js';
import {sha256} from '../../../sandbox-tools/src/support.js';
import {loadSuite} from './command.js';
import {ProofSchema} from './proof.js';
import {runSuite} from './runner.js';

const modal = vi.hoisted(() => ({create: vi.fn(), terminate: vi.fn(), wait: vi.fn()}));
vi.mock('modal', () => ({
  ModalClient: class {
    apps = {fromName: async () => ({appId: 'app-notebook-proof'})};
    images = {fromRegistry: () => ({
      dockerfileCommands() {
        return this;
      },
    })};
    sandboxes = {create: modal.create};
  },
}));
vi.mock('../../../sandbox-tools/src/modal/port.js', () => ({
  modalSandboxPort: () => ({exec: async () => ({exitCode: 0})}),
}));
vi.mock('../../../sandbox-tools/src/tools/registry.js', () => ({executeSandboxTool: vi.fn()}));

const directories: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  modal.create.mockResolvedValue({sandboxId: 'sb-notebook-proof', terminate: modal.terminate, wait: modal.wait});
  modal.wait.mockResolvedValue(137);
  vi.mocked(executeSandboxTool).mockImplementation(async (call, _boundary, tools) => {
    const code = call.args && typeof call.args === 'object' && 'code' in call.args ? call.args.code : '';
    const failure = code === 'while True: pass' ? 'timeout' : String(code).startsWith('for i') ? 'budget' : code === 'import os\nos._exit(1)' ? 'upstream' : undefined;
    if (failure) return {ok: false, error: {code: failure, message: 'cell failed', remediation: 'retry'}, untrustedSource: true, taint: {tainted: true}};
    if (String(code).startsWith('from IPython.display')) {
      for (const [name, mediaType, content] of [['0.png', 'image/png', 'PNG'], ['1.html', 'text/html', '<b>hello</b>']] as const) {
        const bytes = new TextEncoder().encode(content);
        await tools.exports.put({name, mediaType, bytes, sha256: sha256(bytes)});
      }
    }
    return {ok: true, result: {value: {text: '42', message: code === '1' ? 'variables were lost' : ''}, untrustedSource: true}, taint: {tainted: true}};
  });
});
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});
async function run() {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-notebook-proof-'));
  directories.push(directory);
  return runSuite(await loadSuite('notebook'), {
    env: {PRAXIS_MODAL_NOTEBOOK_CHECK: '1'}, evidence: new Map(), directory,
  });
}

describe('notebook live suite', () => {
  it('records notebook assertions, hashed artifacts and sandbox cleanup in a standard proof', async () => {
    const {proof, path} = await run();
    expect(proof.status).toBe('complete');
    expect(ProofSchema.parse(JSON.parse(readFileSync(path, 'utf8')))).toEqual(proof);
    expect(proof.steps[0]).toMatchObject({status: 'pass', summary: '9 notebook assertions passed; sandbox terminated'});
    expect(proof.steps[0]!.evidence).toHaveLength(3);
    expect(proof.steps[0]!.log).toContain('PRA-105 settled sb-notebook-proof; exit=137');
    expect(modal.create).toHaveBeenCalledTimes(1);
    expect(modal.terminate).toHaveBeenCalledTimes(1);
    expect(modal.wait).toHaveBeenCalledTimes(1);
  });

  it('terminates the sandbox and records a failed proof when an assertion fails', async () => {
    vi.mocked(executeSandboxTool).mockRejectedValueOnce(new Error('notebook unavailable'));
    const {proof} = await run();
    expect(proof.status).toBe('failed');
    expect(proof.steps[0]).toMatchObject({status: 'fail', summary: 'notebook unavailable'});
    expect(modal.terminate).toHaveBeenCalledTimes(1);
    expect(modal.wait).toHaveBeenCalledTimes(1);
  });
});
