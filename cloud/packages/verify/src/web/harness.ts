import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium, request as playwrightRequest, type Browser, type Page} from '@playwright/test';
import {CAPTURE_VIEWPORT, FLOW_ACTION_TIMEOUT_MS, FLOW_TIMEOUT_MS} from '../constants.js';
import type {WebFlow} from './flow-types.js';
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

async function runFlow(browser: Browser, flow: WebFlow, options: HarnessOptions): Promise<FlowResult> {
  const started = Date.now();
  const context = await browser.newContext({viewport: CAPTURE_VIEWPORT});
  const request = await playwrightRequest.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(FLOW_ACTION_TIMEOUT_MS);
  const issues: BrowserIssue[] = [];
  const notes: string[] = [];
  watch(page, issues);
  let error: string | undefined;
  try {
    await withTimeout(flow.run({page, base: options.base, api: options.api, request, seed: options.seed, note: line => notes.push(line)}), FLOW_TIMEOUT_MS, flow.id);
  } catch (caught) {
    error = caught instanceof Error ? caught.message.split('\n')[0] : String(caught);
  }
  const files = await capture(page, options.directory, flow.id);
  await request.dispose();
  await context.close();
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
  const browser = await chromium.launch({headless: !options.headed});
  const results: FlowResult[] = [];
  try {
    for (const flow of flows) {
      const result = await runFlow(browser, flow, options);
      results.push(result);
      onResult(result);
    }
  } finally {
    await browser.close();
  }
  return results;
}
