import {DEFAULT_API_PORT, DEFAULT_WEB_PORT} from './constants.js';

export const USAGE = `praxis-verify <command> [options]   (from cloud/: npm run verify -- <command>)

  gate  [--only a,b] [--json]                   the AGENTS.md verification list, one line per step
  web   [--flows a,b] [--ports web,api] [--base URL --api URL] [--seed n] [--headed] [--json]
                                                Playwright flows with snapshots, screenshots, error checks
  api   [--port n | --api URL] [--json]         local API smoke (bootstrap, SSE, approvals, replay)
  ios   [--simulator udid|name] [--skip-tests] [--json]   xcodebuild unit tests + launch screenshot (macOS)
  map   --check                                 feature map ↔ implemented flows, checks and suites
  live  <suite> [--evidence step=path|url]… [--only a,b] [--json]
  live  --list                                  live-check suites and their steps

Exit codes: 0 ok, 1 failed, 2 usage, 3 live suite incomplete (skipped or pending steps).`;

export const list = (value: string | undefined) => value?.split(',').map(item => item.trim()).filter(Boolean);

export function parsePorts(value: string | undefined): {web: number; api: number} {
  if (!value) return {web: DEFAULT_WEB_PORT, api: DEFAULT_API_PORT};
  const [web, api] = value.split(',').map(part => Number(part.trim()));
  const valid = (port: number | undefined): port is number => Number.isInteger(port) && port! > 0 && port! < 65536;
  if (!valid(web) || !valid(api) || web === api) throw new UsageError(`--ports expects two different ports as web,api; got ${value}`);
  return {web, api};
}

export class UsageError extends Error {}
