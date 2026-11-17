import {accessibilitySnapshot, screenshotEvidence} from '@praxis/verify';
import type {Locator, Page} from '@playwright/test';
import {annotateSnapshot, parseTarget} from './refs.js';
import {attach, closeSession, openSession, readSession, resolveRef, writeSession, type Session} from './session.js';

/** One user-visible step: long enough for a real page, short enough that a broken selector fails fast. */
export const ACTION_TIMEOUT_MS = 10_000;
export const NAVIGATION_TIMEOUT_MS = 30_000;

export type CommandResult = Record<string, unknown>;

function locate(page: Page, session: Session, argument: string): Locator {
  const target = parseTarget(argument);
  if (target.kind === 'role') return page.getByRole(target.role as Parameters<Page['getByRole']>[0], {name: target.name, exact: true}).first();
  const ref = resolveRef(session, target.ref);
  return page.getByRole(ref.role as Parameters<Page['getByRole']>[0], {name: ref.name, exact: true}).nth(ref.nth);
}

async function withPage(file: string, work: (page: Page, session: Session) => Promise<CommandResult>): Promise<CommandResult> {
  const session = readSession(file);
  const {browser, page} = await attach(session);
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  try {
    return await work(page, session);
  } finally {
    // A CDP attachment only disconnects; the session's Chromium keeps running for the next command.
    await browser.close();
  }
}

/** Every command prints one JSON object; an action is followed by the URL it ended on, nothing inferred. */
export async function runCommand(file: string, command: string, args: readonly string[], options: {headed: boolean}): Promise<CommandResult> {
  switch (command) {
    case 'open': {
      const session = await openSession(file, options.headed);
      return {ok: true, pid: session.pid, port: session.port};
    }
    case 'close':
      await closeSession(file);
      return {ok: true};
    case 'goto':
      return withPage(file, async page => {
        const response = await page.goto(required(args[0], 'goto <url>'), {timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'load'});
        return {ok: true, url: page.url(), status: response?.status() ?? null, title: await page.title()};
      });
    case 'snapshot':
      return withPage(file, async (page, session) => {
        const {text, refs} = annotateSnapshot(await accessibilitySnapshot(page, ACTION_TIMEOUT_MS));
        writeSession(file, {...session, refs});
        return {ok: true, url: page.url(), snapshot: text, refs: Object.keys(refs).length};
      });
    case 'click':
      return withPage(file, async (page, session) => {
        await locate(page, session, required(args[0], 'click <ref|role:name>')).click();
        return {ok: true, url: page.url()};
      });
    case 'type':
      return withPage(file, async (page, session) => {
        await locate(page, session, required(args[0], 'type <ref|role:name> <text>')).fill(required(args[1], 'type <ref|role:name> <text>'));
        return {ok: true, url: page.url()};
      });
    case 'wait-for':
      return withPage(file, async (page, session) => {
        await locate(page, session, required(args[0], 'wait-for <role:name>')).waitFor({state: 'visible'});
        return {ok: true, url: page.url()};
      });
    case 'screenshot':
      return withPage(file, async page => ({ok: true, ...(await screenshotEvidence(page, required(args[0], 'screenshot <file.png>'), ACTION_TIMEOUT_MS))}));
    default:
      throw new Error(`unknown command ${command}`);
  }
}

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value === '') throw new Error(`usage: praxis-browser ${usage}`);
  return value;
}
