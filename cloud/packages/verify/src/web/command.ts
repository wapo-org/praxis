import {writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {CLOUD_DIR, PW_CONVEX_URL_ENV} from '../constants.js';
import {artifactDir, gitState, newRunId} from '../run-context.js';
import {selectFlows} from './flows.js';
import {runFlows, type FlowResult} from './harness.js';
import {startLocalStack, type LocalStack} from './servers.js';

export interface WebOptions {
  flows?: string[];
  ports: {web: number; api: number};
  /** Existing servers: verify them instead of starting our own (the Modal reviewer starts its own). */
  base?: string;
  api?: string;
  seed: number;
  headed: boolean;
  json: boolean;
}

export interface WebReport {
  type: 'verify.web';
  runId: string;
  gitSha: string;
  ok: boolean;
  base: string;
  api: string;
  directory: string;
  flows: FlowResult[];
}

function flowLine(result: FlowResult): string {
  const head = `${result.ok ? 'PASS' : 'FAIL'} ${result.id.padEnd(16)} ${`${(result.ms / 1000).toFixed(1)}s`.padStart(6)}`;
  const details = [...(result.error ? [result.error] : []), ...result.unexpected.map(issue => `unexpected ${issue}`)];
  return [head, ...details.map(line => `    | ${line}`)].join('\n');
}

export async function runWeb(options: WebOptions, print: (line: string) => void = line => console.log(line)): Promise<WebReport> {
  const flows = selectFlows(options.flows);
  const runId = newRunId();
  const directory = artifactDir('verify', runId);
  let stack: LocalStack | undefined;
  if (options.base) {
    stack = {base: options.base.replace(/\/$/, ''), api: (options.api ?? options.base).replace(/\/$/, ''), stop: async () => {}};
  } else {
    stack = await startLocalStack(options.ports, directory);
  }
  try {
    const convexUrl = stack.convexUrl ?? process.env[PW_CONVEX_URL_ENV];
    if (!convexUrl) throw new Error(`Existing browser stacks require ${PW_CONVEX_URL_ENV}`);
    const results = await runFlows(flows, {base: stack.base, api: stack.api, convexUrl, seed: options.seed, headed: options.headed, directory}, result => {
      if (!options.json) print(flowLine(result));
    });
    const report: WebReport = {type: 'verify.web', runId, gitSha: gitState().sha, ok: results.every(result => result.ok), base: stack.base, api: stack.api, directory, flows: results};
    writeFileSync(join(directory, 'run.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (options.json) print(JSON.stringify(report));
    else print(`${report.ok ? 'web: ok' : 'web: FAILED'} (${results.filter(result => result.ok).length}/${results.length} flows, artifacts in ${relative(CLOUD_DIR, directory)})`);
    return report;
  } finally {
    await stack.stop();
  }
}
