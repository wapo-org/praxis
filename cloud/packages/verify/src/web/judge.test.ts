import {describe, expect, it} from 'vitest';
import {actionPlan, seededRandom} from './fuzz.js';
import {describeIssue, SIGNED_OUT_SESSION_PROBE, unexpectedIssues, type BrowserIssue} from './judge.js';

const response = (url: string, status: number): BrowserIssue => ({kind: 'response', method: 'GET', url: `http://127.0.0.1:5240${url}`, status});

describe('browser issue judge', () => {
  it('fails on console errors, page errors and unlisted 4xx/5xx', () => {
    const issues: BrowserIssue[] = [
      {kind: 'console', text: 'TypeError: x is undefined'},
      {kind: 'pageerror', text: 'boom'},
      response('/v1/chats', 500),
      {kind: 'requestfailed', method: 'GET', url: 'http://127.0.0.1:5240/v1/models', text: 'net::ERR_CONNECTION_REFUSED'},
    ];
    expect(unexpectedIssues(issues, []).map(describeIssue)).toEqual([
      'console error: TypeError: x is undefined',
      'page error: boom',
      'HTTP 500 GET /v1/chats',
      'request failed: GET /v1/models (net::ERR_CONNECTION_REFUSED)',
    ]);
  });

  it('allows only the listed path and status', () => {
    const issues = [response('/v1/auth/session', 401), response('/v1/auth/session', 500), response('/v1/auth/session/x', 401)];
    expect(unexpectedIssues(issues, [SIGNED_OUT_SESSION_PROBE]).map(describeIssue)).toEqual(['HTTP 500 GET /v1/auth/session', 'HTTP 401 GET /v1/auth/session/x']);
  });

  it('drops the console echo of a judged response and aborted requests', () => {
    const issues: BrowserIssue[] = [
      {kind: 'console', text: 'Failed to load resource: the server responded with a status of 401 (Unauthorized)'},
      {kind: 'requestfailed', method: 'GET', url: 'http://127.0.0.1:5240/v1/runs/1/events', text: 'net::ERR_ABORTED'},
    ];
    expect(unexpectedIssues(issues, [])).toEqual([]);
  });
});

describe('fuzz plan', () => {
  it('replays the same actions for the same seed and differs across seeds', () => {
    expect(actionPlan(7)).toEqual(actionPlan(7));
    expect(actionPlan(7)).not.toEqual(actionPlan(8));
    const random = seededRandom(1);
    const draws = Array.from({length: 1000}, random);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
  });
});
