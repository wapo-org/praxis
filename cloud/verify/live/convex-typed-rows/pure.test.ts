import {ConvexError} from 'convex/values';
import {describe, expect, it} from 'vitest';
import {textMessage} from './api.js';
import {contiguous, errorText, foreignReadCheck, rejectedCheck, settle, stepResult, AUTH_REQUIRED} from './checks.js';
import {emailCodeFrom, isRecipient} from './mailbox.js';
import {liveOwnerEmail, newRunId} from './owners.js';

describe('owner addresses', () => {
  it('builds a unique Resend test-inbox address per run and label', () => {
    const runId = newRunId(new Date('2026-11-19T10:11:12.345Z'));
    expect(runId).toMatch(/^20261119t101112-[0-9a-f]{6}$/);
    expect(liveOwnerEmail(runId, 'a')).toBe(`delivered+live-pra127-${runId}-a@resend.dev`);
    expect(liveOwnerEmail(runId, 'a')).not.toBe(liveOwnerEmail(runId, 'b'));
  });

  it('refuses tokens that would break the address', () => {
    expect(() => liveOwnerEmail('Run 1', 'a')).toThrow(/lowercase/);
    expect(() => liveOwnerEmail('run', 'ab')).toThrow(/lowercase/);
  });
});

describe('sign-up email parsing', () => {
  it('reads the code from a text link', () => {
    expect(emailCodeFrom('Confirm:\nhttps://praxis.example/validate?code=abc123&x=1\nThanks')).toBe('abc123');
  });

  it('reads the code from an html link with escaped ampersands', () => {
    expect(emailCodeFrom('<a href="https://praxis.example/validate?x=1&amp;code=zz9">go</a>')).toBe('zz9');
  });

  it('returns null when no link carries a code', () => {
    expect(emailCodeFrom('https://praxis.example/help and no code')).toBeNull();
  });

  it('matches recipients case-insensitively in either field shape', () => {
    expect(isRecipient('Name <Delivered+X@resend.dev>', 'delivered+x@resend.dev')).toBe(true);
    expect(isRecipient(['other@resend.dev'], 'delivered+x@resend.dev')).toBe(false);
  });
});

describe('isolation checks', () => {
  it('accepts null, false, an empty page and the unavailable error', async () => {
    expect(foreignReadCheck('null', await settle(Promise.resolve(null))).ok).toBe(true);
    expect(foreignReadCheck('false', await settle(Promise.resolve(false))).ok).toBe(true);
    expect(foreignReadCheck('page', await settle(Promise.resolve({messages: [], cursor: 0, hasMore: false}))).ok).toBe(true);
    expect(foreignReadCheck('error', await settle(Promise.reject(new ConvexError('Run or chat unavailable')))).ok).toBe(true);
  });

  it('fails when a foreign row comes back or an unrelated error hides the answer', async () => {
    const leaked = foreignReadCheck('row', await settle(Promise.resolve({type: 'chat', id: 'x'})));
    expect(leaked).toEqual({name: 'row', ok: false, observed: 'returned the other owner\'s row'});
    expect(foreignReadCheck('page', await settle(Promise.resolve({messages: [{}]}))).ok).toBe(false);
    expect(foreignReadCheck('boom', await settle(Promise.reject(new Error('network down')))).ok).toBe(false);
  });

  it('requires the exact rejection for anonymous calls', async () => {
    expect(rejectedCheck('anon', await settle(Promise.reject(new ConvexError(AUTH_REQUIRED))), AUTH_REQUIRED).ok).toBe(true);
    expect(rejectedCheck('anon', await settle(Promise.resolve(null)), AUTH_REQUIRED).ok).toBe(false);
    expect(rejectedCheck('anon', await settle(Promise.reject(new Error('Account unavailable'))), AUTH_REQUIRED).ok).toBe(false);
  });

  it('prefers ConvexError data over the wrapped server message', () => {
    expect(errorText(new ConvexError('Chat ID unavailable'))).toBe('Chat ID unavailable');
    expect(errorText('plain')).toBe('plain');
  });
});

describe('step results', () => {
  it('passes only when every check passes', () => {
    expect(stepResult('s', 'line', [{name: 'x', ok: true, observed: ''}]).status).toBe('pass');
    const failed = stepResult('s', 'line', [{name: 'x', ok: true, observed: ''}, {name: 'y', ok: false, observed: ''}]);
    expect(failed).toMatchObject({status: 'fail', summary: 'failed: y'});
    expect(stepResult('s', 'line', []).status).toBe('fail');
  });

  it('checks sequences are contiguous', () => {
    expect(contiguous([4, 5, 6])).toBe(true);
    expect(contiguous([4, 6])).toBe(false);
    expect(contiguous([4, 4])).toBe(false);
    expect(contiguous([1, undefined])).toBe(false);
    expect(contiguous([])).toBe(false);
  });

  it('builds protocol-valid text messages', () => {
    const message = textMessage('chat', 'm1', 'user', 'hi', new Date('2026-11-19T00:00:00.000Z'));
    expect(message).toMatchObject({type: 'message', chatId: 'chat', parts: [{type: 'text', text: 'hi'}], createdAt: '2026-11-19T00:00:00.000Z'});
  });
});
