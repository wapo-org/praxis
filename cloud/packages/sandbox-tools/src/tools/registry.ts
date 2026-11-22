import {browser, BrowserInputSchema, BROWSER_DESCRIPTION, browserCapabilities} from './browser.js';
import {executeBoundary, shellPolicy, ToolBoundaryError, toolError, type BoundaryContext, type GateResult, type ToolClassification, type ToolClassifier} from '@praxis/agent';
import type {JsonValue, ToolCapability, ToolInvocation} from '@praxis/protocol';
import {posix} from 'node:path';
import {z} from 'zod';
import {WORKSPACE_ROOT} from '../constants.js';
import type {SandboxToolContext} from './context.js';
import {editFile, EditFileInputSchema, exportFile, ExportFileInputSchema, readFile, ReadFileInputSchema} from './files.js';
import {notebookRun, NotebookInputSchema} from './notebook.js';
import {SYMBOL_DESCRIPTION} from '../symbols/constants.js';
import {replaceSymbol, ReplaceSymbolInputSchema} from './symbols.js';
import {shell, ShellInputSchema, waitForJob, WaitForJobInputSchema} from './process.js';

export interface SandboxToolDefinition {
  name: string;
  description: string;
  input: z.ZodType;
  capabilities: readonly ToolCapability[];
  /** Sandbox content may come from the web or user code, so reading it taints the run (PRA-57). */
  untrustedSource: boolean;
  run(context: SandboxToolContext, args: unknown): Promise<unknown>;
}

/** Sandbox tools share one boundary gate and injected ports. */
export const SANDBOX_TOOLS: readonly SandboxToolDefinition[] = [
  {
    name: 'notebook_run',
    description: 'Execute Python on the sandbox kernel; retains variables and exports PNG/HTML artifacts.',
    input: NotebookInputSchema, capabilities: ['exec', 'read'], untrustedSource: true, run: notebookRun,
  },
  {
    name: 'browser', description: BROWSER_DESCRIPTION, input: BrowserInputSchema,
    capabilities: ['read', 'write', 'external-egress'], untrustedSource: true, run: browser,
  },
  {
    name: 'shell',
    description: 'Run a command in the chat workspace. Long work: background=true, then wait_for_job.',
    input: ShellInputSchema, capabilities: ['exec'], untrustedSource: true, run: shell,
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers and its sha256 (pass it to edit_file to detect concurrent changes).',
    input: ReadFileInputSchema, capabilities: ['read'], untrustedSource: true, run: readFile,
  },
  {
    name: 'edit_file',
    description: 'Replace exact text (or create a file with empty old_text); returns the workspace diagnostics for the file.',
    // Diagnostics execute in the workspace and echo workspace content, so the result is untrusted.
    input: EditFileInputSchema, capabilities: ['write', 'exec'], untrustedSource: true, run: editFile,
  },
  {
    name: 'replace_symbol',
    description: SYMBOL_DESCRIPTION,
    input: ReplaceSymbolInputSchema, capabilities: ['write', 'exec'], untrustedSource: true, run: replaceSymbol,
  },
  {
    name: 'export_file',
    description: 'Hand a workspace file to the user as a downloadable artifact.',
    input: ExportFileInputSchema, capabilities: ['read', 'write'], untrustedSource: false, run: exportFile,
  },
  {
    name: 'wait_for_job',
    description: 'Wait up to timeout_ms for a background job and return its status and output so far.',
    input: WaitForJobInputSchema, capabilities: ['read'], untrustedSource: true, run: waitForJob,
  },
];

const byName = new Map(SANDBOX_TOOLS.map(tool => [tool.name, tool]));
/** The classifier only knows the workspace; the tool then enforces the exact chat directory on real paths. */
const CLASSIFIER_ROOT = `${WORKSPACE_ROOT}/chats/root`;

/** Path arguments per tool: an escape from the workspace is denied before any receipt or execution. */
const PATH_ARGUMENTS: Record<string, readonly string[]> = {shell: ['cwd'], read_file: ['path'], edit_file: ['path'], replace_symbol: ['path'], export_file: ['path']};

function lexicallyConfined(tool: string, args: Record<string, unknown>): boolean {
  return (PATH_ARGUMENTS[tool] ?? []).every(key => {
    const value = args[key];
    if (typeof value !== 'string') return true;
    return posix.resolve(CLASSIFIER_ROOT, value).startsWith(`${WORKSPACE_ROOT}/`);
  });
}

/** PRA-76 decision table: `allow` certifies confinement, no network, no secrets; shell takes shellPolicy's decision. */
export const sandboxToolClassifier: ToolClassifier = {
  classify(call: ToolInvocation): ToolClassification | undefined {
    const tool = byName.get(call.tool);
    if (!tool) return undefined;
    const base = {capabilities: tool.capabilities, untrustedSource: tool.untrustedSource};
    const parsed = tool.input.safeParse(call.args);
    if (!parsed.success || !lexicallyConfined(tool.name, parsed.data as Record<string, unknown>)) return {...base, decision: 'deny'};
    if (tool.name === 'browser') return {...base, capabilities: browserCapabilities(BrowserInputSchema.parse(parsed.data)), decision: 'allow'};
    const decision = tool.name === 'notebook_run' ? 'approve' : tool.name === 'shell' ? shellPolicy((parsed.data as {command: string}).command) : 'allow';
    return {...base, decision};
  },
};

/** The only way to run a sandbox tool: PRA-76's gate (policy, mode, approval receipt, taint), then the tool. */
export async function executeSandboxTool(call: ToolInvocation, boundary: BoundaryContext, context: SandboxToolContext, receipt?: unknown): Promise<GateResult> {
  return executeBoundary(call, boundary, sandboxToolClassifier, async accepted => {
    try {
      const tool = byName.get(accepted.tool);
      if (!tool) throw new ToolBoundaryError(toolError('schema', `Unknown sandbox tool ${accepted.tool}.`));
      return JSON.parse(JSON.stringify(await tool.run(context, accepted.args))) as JsonValue;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ToolBoundaryError(toolError('schema', error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')));
      }
      throw error;
    }
  }, receipt);
}
