import {ModalClient} from 'modal';
import {approvalKey, argsHash, issueApproval, type BoundaryContext} from '@praxis/agent';
import {SealedSecret} from '@praxis/types';
import {defineSuite, type StepContext, type StepOutcome} from '@praxis/verify';
import {MemoryExportSink} from '../../packages/sandbox-tools/src/fake.js';
import {modalSandboxPort} from '../../packages/sandbox-tools/src/modal/port.js';
import {sandboxNotebookImage} from '../../packages/sandbox-tools/src/modal/image.js';
import {executeSandboxTool} from '../../packages/sandbox-tools/src/tools/registry.js';

const APP_NAME = 'praxis-pra105-notebook-check';
const ROOT = '/workspace/chats/notebook-check';
const SANDBOX_TIMEOUT_MS = 180_000;
const EXEC_TIMEOUT_MS = 10_000;
const CELL_TIMEOUT_MS = 5_000;
const INTERRUPT_TIMEOUT_MS = 300;
const OPT_IN = 'PRAXIS_MODAL_NOTEBOOK_CHECK';

async function checkNotebook(context: StepContext): Promise<StepOutcome> {
  if (context.config(OPT_IN) !== '1') return {status: 'fail', summary: `Set ${OPT_IN}=1 to authorize one Modal sandbox boot.`};
  const log = (message: string) => context.log(`PRA-105 ${message}`);
  const checks: string[] = [];
  const modal = new ModalClient();
  const app = await modal.apps.fromName(APP_NAME, {createIfMissing: true});
  const image = sandboxNotebookImage(modal);
  log('one notebook sandbox boot requested');
  const sandbox = await modal.sandboxes.create(app, image, {
    cpu: 0.25, memoryMiB: 512, timeoutMs: SANDBOX_TIMEOUT_MS, tags: {wp: 'PRA-105'},
  });
  try {
    log(`created ${sandbox.sandboxId}`);
    const port = modalSandboxPort(sandbox);
    const mkdir = await port.exec({argv: ['mkdir', '-p', ROOT], cwd: '/', timeoutMs: EXEC_TIMEOUT_MS});
    if (mkdir.exitCode !== 0) throw new Error('could not create notebook workspace');
    const exports = new MemoryExportSink();
    const tools = {port, root: ROOT, exports};
    const boundary: BoundaryContext = {
      mode: 'build', runId: 'smoke', toolCallId: 'cell', taint: {tainted: false}, nowMs: Date.now,
      key: await approvalKey(SealedSecret.of('notebook-smoke-only-key-32-bytes!!')), replay: {consume: async () => true},
    };
    async function cell(code: string, timeout_ms = CELL_TIMEOUT_MS) {
      const call = {tool: 'notebook_run', args: {code, timeout_ms}};
      const receipt = await issueApproval(boundary.key, {
        runId: boundary.runId, toolCallId: boundary.toolCallId, tool: call.tool, argsHash: await argsHash(call.args),
      }, Date.now() + SANDBOX_TIMEOUT_MS, crypto.randomUUID());
      return executeSandboxTool(call, boundary, tools, receipt);
    }
    function assert(condition: unknown, name: string) {
      if (!condition) throw new Error(name);
      checks.push(name);
      log(`OK ${name}`);
    }
    assert((await cell('value = 42')).ok, 'define variable');
    const read = await cell('value');
    assert(read.ok && JSON.stringify(read.result.value).includes('42'), 'state across calls');
    const rich = await cell("from IPython.display import display, HTML, Image\nimport base64\ndisplay(HTML('<b>hello</b>'))\ndisplay(Image(data=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRz8AAAAASUVORK5CYII=')))");
    assert(rich.ok && exports.items.length === 2 && exports.items.every(item => item.sha256.length === 64), 'PNG/HTML exported with hashes');
    const timeout = await cell('while True: pass', INTERRUPT_TIMEOUT_MS);
    assert(!timeout.ok && timeout.error.code === 'timeout', 'timeout interrupts');
    const retained = await cell('value');
    assert(retained.ok && JSON.stringify(retained.result.value).includes('42'), 'variables survive interrupt');
    const budget = await cell("for i in range(33): display(HTML('<b>budget</b>'))");
    assert(!budget.ok && budget.error.code === 'budget', 'artifact count budget interrupts and drains');
    const afterBudget = await cell('value');
    assert(afterBudget.ok && JSON.stringify(afterBudget.result.value).includes('42'), 'variables survive artifact budget');
    const dead = await cell('import os\nos._exit(1)');
    assert(!dead.ok, 'dead kernel returns ToolError');
    for (const item of exports.items) context.attach(item.name, item.bytes);
    const restart = await cell('1');
    assert(restart.ok && JSON.stringify(restart.result.value).includes('variables were lost'), 'restart reports variable loss');
  } finally {
    await sandbox.terminate();
    log(`terminated ${sandbox.sandboxId}`);
    const exitCode = await sandbox.wait();
    log(`settled ${sandbox.sandboxId}; exit=${exitCode}`);
  }

  context.attach('checks.json', JSON.stringify({checks}));
  return {status: 'pass', summary: `${checks.length} notebook assertions passed; sandbox terminated`};
}

export default defineSuite({
  id: 'notebook',
  issue: 'PRA-105',
  title: 'Persistent Jupyter notebook on the shared Modal image',
  steps: [{
    id: 'kernel-lifecycle',
    kind: 'auto',
    checklist: 'Retain variables, export PNG/HTML with SHA-256, interrupt timeouts and artifact budgets, and report variable loss on restart.',
    needs: {config: [OPT_IN]},
    run: checkNotebook,
  }],
});
