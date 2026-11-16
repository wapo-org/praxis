import {executeBoundary, shellPolicy, ToolBoundaryError, toolError, type BoundaryContext, type GateResult, type ToolClassification, type ToolClassifier} from '@praxis/agent';
import type {JsonValue, ToolCapability, ToolInvocation} from '@praxis/protocol';
import {z} from 'zod';
import type {SandboxToolContext} from './context.js';
import {editFile, EditFileInputSchema, exportFile, ExportFileInputSchema, readFile, ReadFileInputSchema} from './files.js';
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

/** The simplified Modal v1 tool set (PRA-77): no tmux, no notebook, no AST editor yet. */
export const SANDBOX_TOOLS: readonly SandboxToolDefinition[] = [
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
    input: EditFileInputSchema, capabilities: ['write'], untrustedSource: false, run: editFile,
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

/** PRA-76 classification: shell commands go through its AST policy; everything else by its declared capabilities. */
export const sandboxToolClassifier: ToolClassifier = {
  classify(call: ToolInvocation): ToolClassification | undefined {
    const tool = byName.get(call.tool);
    if (!tool) return undefined;
    const parsed = tool.input.safeParse(call.args);
    if (!parsed.success) return {capabilities: tool.capabilities, decision: 'deny', untrustedSource: tool.untrustedSource};
    const decision = tool.name === 'shell' ? shellPolicy(ShellInputSchema.parse(call.args).command) : 'allow';
    return {capabilities: tool.capabilities, decision, untrustedSource: tool.untrustedSource};
  },
};

/** The only way to run a sandbox tool: PRA-76's gate (policy, mode, approval receipt, taint), then the tool. */
export async function executeSandboxTool(call: ToolInvocation, boundary: BoundaryContext, context: SandboxToolContext, receipt?: unknown): Promise<GateResult> {
  try {
    return await executeBoundary(call, boundary, sandboxToolClassifier, async accepted => {
      const tool = byName.get(accepted.tool);
      if (!tool) throw new ToolBoundaryError(toolError('schema', `Unknown sandbox tool ${accepted.tool}.`));
      return JSON.parse(JSON.stringify(await tool.run(context, accepted.args))) as JsonValue;
    }, receipt);
  } catch (error) {
    if (error instanceof ToolBoundaryError) return {ok: false, error: error.detail};
    if (error instanceof z.ZodError) return {ok: false, error: toolError('schema', error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))};
    // A port failure (Modal unreachable, sandbox gone) still reaches the model as a ToolError with remediation.
    return {ok: false, error: toolError('upstream', `Sandbox call failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500))};
  }
}
