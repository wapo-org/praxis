import {ToolErrorSchema, type ToolError, type ToolErrorCode} from '@praxis/protocol';

export const TOOL_REMEDIATION: Record<ToolErrorCode, string> = {
  upstream: 'Check the service connection and retry when it is available.',
  schema: 'Correct the arguments to match the tool schema, then retry.',
  'path-traversal': 'Use a path inside the permitted workspace.',
  'taint-blocked': 'Request approval for this exact call after reading untrusted content.',
  'policy-denied': 'Choose a permitted action; approval cannot override a policy denial.',
  'approval-required': 'Request fresh user approval for this exact tool call and arguments.',
  budget: 'Reduce the request or ask the user to increase the budget.',
  'upstream-firewall': 'Inspect the upstream refusal and use a permitted request; do not bypass the firewall.',
  'not-found': 'Check the path or id (list the directory or jobs first), then retry.',
  conflict: 'Re-read the current state, then retry with an edit that matches it exactly.',
  timeout: 'Run it in the background and poll with wait_for_job, or narrow the work.',
  'connection-required': 'Ask the user to connect the app with the inline connect button, then retry.',
};
export function toolError(code: ToolErrorCode, message: string): ToolError {
  return ToolErrorSchema.parse({code, message, remediation: TOOL_REMEDIATION[code]});
}

export class ToolBoundaryError extends Error {
  constructor(readonly detail: ToolError) {
    super(detail.message);
    this.name = 'ToolBoundaryError';
  }
}
