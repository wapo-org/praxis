/** Everything the browser reported while a flow ran; a flow fails on any issue its allowlist does not name. */
export type BrowserIssue =
  | {kind: 'console'; text: string}
  | {kind: 'pageerror'; text: string}
  | {kind: 'response'; method: string; url: string; status: number}
  | {kind: 'requestfailed'; method: string; url: string; text: string};

export interface AllowedIssue {
  kind: 'response' | 'console';
  /** Matched against the URL path (response) or message text (console). */
  pattern: RegExp;
  status?: number;
  /** Why this flow expects it; printed next to the allowance in the run report. */
  reason: string;
}

/** Chrome echoes every 4xx/5xx as a console error; the response itself is judged, so the echo is noise. */
const RESOURCE_ECHO = /^Failed to load resource: the server responded with a status of \d{3}/;
/** Navigation and cancelled SSE streams abort requests by design. */
const ABORTED = /net::ERR_ABORTED/;


function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function allowed(issue: BrowserIssue, allow: readonly AllowedIssue[]): boolean {
  if (issue.kind === 'response') {
    const path = pathOf(issue.url);
    return allow.some(rule => rule.kind === 'response' && rule.pattern.test(path) && (rule.status === undefined || rule.status === issue.status));
  }
  if (issue.kind === 'console') return allow.some(rule => rule.kind === 'console' && rule.pattern.test(issue.text));
  return false;
}

export function unexpectedIssues(issues: readonly BrowserIssue[], allow: readonly AllowedIssue[]): BrowserIssue[] {
  return issues.filter(issue => {
    if (issue.kind === 'console' && RESOURCE_ECHO.test(issue.text)) return false;
    if (issue.kind === 'requestfailed' && ABORTED.test(issue.text)) return false;
    return !allowed(issue, allow);
  });
}

export function describeIssue(issue: BrowserIssue): string {
  switch (issue.kind) {
    case 'console':
      return `console error: ${issue.text}`;
    case 'pageerror':
      return `page error: ${issue.text}`;
    case 'response':
      return `HTTP ${issue.status} ${issue.method} ${pathOf(issue.url)}`;
    case 'requestfailed':
      return `request failed: ${issue.method} ${pathOf(issue.url)} (${issue.text})`;
  }
}
