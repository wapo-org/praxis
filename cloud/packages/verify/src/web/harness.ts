import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium, request as playwrightRequest, type Browser, type Page} from '@playwright/test';
import {CAPTURE_VIEWPORT, FLOW_ACTION_TIMEOUT_MS, FLOW_TIMEOUT_MS} from '../constants.js';
import type {WebFlow} from './flow-types.js';
import {createTestAccount} from './auth-account.js';
import {createAuthChallengeBudget} from './auth-budget.js';
import {openSignedInPage, readSessionState, signIn, type SessionState} from './session.js';
import {accessibilitySnapshot, screenshotEvidence} from './evidence.js';
import {describeIssue, unexpectedIssues, type BrowserIssue} from './judge.js';

export interface FlowResult {
  id: string;
  /** What the flow proves, so run.json reads without the source. */
  title: string;
  ok: boolean;
  ms: number;
  error?: string;
  unexpected: string[];
  allowed: string[];
  notes: string[];
  artifacts: {screenshot?: string; aria?: string; issues: string};
}

export interface HarnessOptions {
  base: string;
  api: string;
  convexUrl: string;
  seed: number;
  headed: boolean;
  directory: string;
}

function watch(page: Page, issues: BrowserIssue[]): void {
  page.on('console', message => {
    if (message.type() === 'error') issues.push({kind: 'console', text: message.text()});
  });
  page.on('pageerror', error => issues.push({kind: 'pageerror', text: error.message}));
  page.on('response', response => {
    if (response.status() >= 400) issues.push({kind: 'response', method: response.request().method(), url: response.url(), status: response.status()});
  });
  page.on('requestfailed', failed => issues.push({kind: 'requestfailed', method: failed.method(), url: failed.url(), text: failed.failure()?.errorText ?? 'failed'}));
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Evidence is captured even when the flow throws: the failing screen is the most useful artifact. */
async function capture(page: Page, directory: string, id: string): Promise<{screenshot?: string; aria?: string}> {
  const files: {screenshot?: string; aria?: string} = {};
  try {
    files.aria = join(directory, `${id}.aria.yml`);
    writeFileSync(files.aria, await accessibilitySnapshot(page));
  } catch {
    delete files.aria;
  }
  try {
    files.screenshot = (await screenshotEvidence(page, join(directory, `${id}.png`))).path;
  } catch {
    delete files.screenshot;
  }
  return files;
}

interface RunSession {
  budgetDirectory: string;
  state?: SessionState;
}

async function runFlow(browser: Browser, flow: WebFlow, options: HarnessOptions, session: RunSession): Promise<FlowResult> {
  const started = Date.now();
  const storageState = flow.session === 'shared' ? session.state : undefined;
  const context = await browser.newContext({viewport: CAPTURE_VIEWPORT, storageState});
  const request = await playwrightRequest.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(FLOW_ACTION_TIMEOUT_MS);
  const issues: BrowserIssue[] = [];
  const notes: string[] = [];
  watch(page, issues);
  let error: string | undefined;
  let signedIn = false;
  try {
    const run = async () => {
      if (storageState) {
        await openSignedInPage(page, '/', options.base);
      } else if (flow.session) {
        const account = await createTestAccount(options.convexUrl, session.budgetDirectory);
        await signIn(page, options.base, account);
      }
      signedIn = flow.session !== undefined;
      await flow.run({page, api: options.api, request, seed: options.seed, note: line => notes.push(line)});
    };
    await withTimeout(run(), FLOW_TIMEOUT_MS, flow.id);
  } catch (caught) {
    error = caught instanceof Error ? caught.message.split('\n')[0] : String(caught);
  }
  const files = await capture(page, options.directory, flow.id);
  try {
    if (flow.session === 'shared' && signedIn) {
      session.state = await readSessionState(context, options.base);
    }
  } catch (caught) {
    error ??= caught instanceof Error ? caught.message : String(caught);
  } finally {
    await request.dispose();
    await context.close();
  }
  const unexpected = unexpectedIssues(issues, flow.allow).map(describeIssue);
  const allowed = issues.filter(issue => issue.kind === 'response' && !unexpected.includes(describeIssue(issue))).map(describeIssue);
  const issuesFile = join(options.directory, `${flow.id}.issues.json`);
  writeFileSync(issuesFile, `${JSON.stringify({issues, unexpected, allow: flow.allow.map(rule => ({...rule, pattern: rule.pattern.source}))}, null, 2)}\n`);
  return {
    id: flow.id,
    title: flow.title,
    ok: !error && unexpected.length === 0,
    ms: Date.now() - started,
    ...(error ? {error} : {}),
    unexpected,
    allowed,
    notes,
    artifacts: {...files, issues: issuesFile},
  };
}

export async function runFlows(flows: readonly WebFlow[], options: HarnessOptions, onResult: (result: FlowResult) => void): Promise<FlowResult[]> {
  const session = {budgetDirectory: await createAuthChallengeBudget(options.directory)};
  const browser = await chromium.launch({headless: !options.headed});
  const results: FlowResult[] = [];
  try {
    for (const flow of flows) {
      const result = await runFlow(browser, flow, options, session);
      results.push(result);
      onResult(result);
    }
  } finally {
    await browser.close();
  }
  return results;
}
