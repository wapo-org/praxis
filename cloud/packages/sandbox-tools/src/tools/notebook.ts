import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ToolBoundaryError, toolError} from '@praxis/agent';
import {NOTEBOOK_DRIVER} from '../notebook-driver.js';
import {capOutput, containedPath, fail, stripAnsi} from '../support.js';
import {NOTEBOOK_ARTIFACTS_MAX, NOTEBOOK_EXEC_ALLOWANCE_MS, SHELL_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS} from '../constants.js';
import type {SandboxToolContext} from './context.js';
import {exportFile} from './files.js';

export const NOTEBOOK_STATE_DIR = '/var/lib/praxis/notebook';
export const NOTEBOOK_DRIVER_PATH = `${NOTEBOOK_STATE_DIR}/driver.py`;
export const NOTEBOOK_CODE_MAX = 1_048_576;
const NOTEBOOK_INSTALL_AND_RUN = 'mv "$1" "$2" && exec python3 "$2" submit "$3" "$4"';
const NOTEBOOK_OUTPUT_REMEDIATION = 'Correct the rich output and retry; the cell was interrupted and drained to idle before returning.';
const NOTEBOOK_TIMEOUT_REMEDIATION = 'Reduce the cell work or increase timeout_ms; the interrupted kernel retains its variables.';

export const NotebookInputSchema = z.object({
  code: z.string().min(1).max(NOTEBOOK_CODE_MAX),
  timeout_ms: z.number().int().positive().max(SHELL_TIMEOUT_MAX_MS).default(SHELL_TIMEOUT_DEFAULT_MS),
}).strict();

const ReplySchema = z.discriminatedUnion('status', [
  z.object({status: z.literal('ok'), text: z.string(), truncated: z.boolean(), artifacts: z.array(z.string()).max(NOTEBOOK_ARTIFACTS_MAX), restarted: z.boolean(), message: z.string()}),
  z.object({status: z.enum(['timeout', 'conflict', 'upstream', 'execution', 'budget', 'output-error']), message: z.string()}),
]);

export async function notebookRun(context: SandboxToolContext, raw: unknown) {
  try {
    const input = NotebookInputSchema.parse(raw);
    const {path: root} = await containedPath(context.port, context.root, '.');
    const requestPath = `${NOTEBOOK_STATE_DIR}/${randomUUID()}.request`;
    await context.port.writeFile(`${requestPath}.py`, new TextEncoder().encode(NOTEBOOK_DRIVER));
    await context.port.writeFile(requestPath, new TextEncoder().encode(JSON.stringify({...input, root})));
    const result = await context.port.exec({
      argv: ['sh', '-c', NOTEBOOK_INSTALL_AND_RUN, 'praxis-notebook', `${requestPath}.py`, NOTEBOOK_DRIVER_PATH, NOTEBOOK_STATE_DIR, requestPath],
      cwd: root, timeoutMs: input.timeout_ms + NOTEBOOK_EXEC_ALLOWANCE_MS,
    });
    if (result.timedOut || result.exitCode !== 0) fail('upstream', 'Notebook driver unavailable; retry or recreate the sandbox.');
    const reply = ReplySchema.parse(JSON.parse(result.stdout));
    if (reply.status !== 'ok') {
      const message = capOutput(stripAnsi(reply.message)).text;
      if (reply.status === 'timeout') throw new ToolBoundaryError({...toolError('timeout', message), remediation: NOTEBOOK_TIMEOUT_REMEDIATION});
      if (reply.status === 'output-error') throw new ToolBoundaryError({...toolError('upstream', message), remediation: NOTEBOOK_OUTPUT_REMEDIATION});
      fail(reply.status === 'execution' ? 'upstream' : reply.status, message);
    }
    const artifacts = [];
    for (const path of reply.artifacts) artifacts.push(await exportFile(context, {path}));
    const text = capOutput(stripAnsi(reply.text));
    return {text: text.text, truncated: reply.truncated || text.truncated, artifacts, restarted: reply.restarted,
      message: reply.message};
  } catch (error) {
    if (error instanceof ToolBoundaryError) throw error;
    if (error instanceof z.ZodError) fail('schema', 'Invalid notebook input or driver response; check code and timeout_ms.');
    fail('upstream', 'Notebook execution or artifact export failed; retry or recreate the sandbox.');
  }
}
