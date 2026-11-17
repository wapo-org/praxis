import {posix} from 'node:path';
import {z} from 'zod';
import type {ToolCapability} from '@praxis/protocol';
import {containedPath, fail, sha256, withWorkspaceLock} from '../support.js';
import {exportFile} from './files.js';
import type {SandboxToolContext} from './context.js';

export const BROWSER_DESCRIPTION = 'Control the sandbox browser with deterministic accessibility refs; screenshots export a hashed PNG artifact.';
export const BROWSER_TIMEOUT_MS = 45_000;
export const BROWSER_OUTPUT_MAX_BYTES = 65_536;
export const BROWSER_SESSION_PATH = '.praxis/browser/session.json';
export const BROWSER_SCREENSHOT_PATH = 'browser-screenshot.png';
const TARGET_MAX = 1_024;
const TEXT_MAX = 16_384;
const target = z.string().min(1).max(TARGET_MAX).regex(/^(e\d+|[a-z]+:.+)$/);
const publicUrl = z.url().max(8_192).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Use an HTTPS URL without credentials.');
export const BrowserInputSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('open')}).strict(),
  z.object({action: z.literal('close')}).strict(),
  z.object({action: z.literal('snapshot')}).strict(),
  z.object({action: z.literal('goto'), url: publicUrl}).strict(),
  z.object({action: z.literal('click'), target}).strict(),
  z.object({action: z.literal('type'), target, text: z.string().min(1).max(TEXT_MAX)}).strict(),
  z.object({action: z.literal('wait-for'), target}).strict(),
  z.object({action: z.literal('screenshot')}).strict(),
]);
export type BrowserInput = z.infer<typeof BrowserInputSchema>;
const BrowserResultSchema = z.object({ok: z.literal(true)}).catchall(z.json());
const ScreenshotResultSchema = z.object({path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative()});

export function browserCapabilities(input: BrowserInput): readonly ToolCapability[] {
  switch (input.action) {
    case 'snapshot':
    case 'wait-for': return ['read'];
    case 'screenshot': return ['read', 'write'];
    case 'open':
    case 'close': return ['exec'];
    case 'goto':
    case 'click':
    case 'type': return ['read', 'write', 'external-egress'];
  }
}

async function browserLocked(context: SandboxToolContext, input: BrowserInput) {
  if (!context.browserNetworkRestricted) fail('policy-denied', 'Browser requires a sandbox with public-only network egress.');
  const {path: session} = await containedPath(context.port, context.root, BROWSER_SESSION_PATH);
  const {path: screenshot} = await containedPath(context.port, context.root, BROWSER_SCREENSHOT_PATH);
  const args: string[] = [];
  switch (input.action) {
    case 'goto': args.push(input.url); break;
    case 'click':
    case 'wait-for': args.push(input.target); break;
    case 'type': args.push(input.target, input.text); break;
    case 'screenshot': args.push(screenshot); break;
  }
  const result = await context.port.exec({argv: ['praxis-browser', '--session', session, '--', input.action, ...args], cwd: context.root, timeoutMs: BROWSER_TIMEOUT_MS});
  if (result.timedOut) fail('timeout', 'Browser action exceeded its deadline; close the session before retrying.');
  if (result.exitCode !== 0) fail('upstream', 'Browser action failed; refresh the snapshot or reopen the session.');
  if (Buffer.byteLength(result.stdout) > BROWSER_OUTPUT_MAX_BYTES) fail('budget', 'Browser output exceeds the snapshot budget.');
  const output = BrowserResultSchema.parse(JSON.parse(result.stdout));
  if (input.action !== 'screenshot') return output;
  const proof = ScreenshotResultSchema.parse(output);
  if (proof.path !== screenshot) fail('schema', 'Browser returned an unexpected screenshot path.');
  const bytes = await context.port.readFile(screenshot);
  if (sha256(bytes) !== proof.sha256 || bytes.length !== proof.bytes) fail('conflict', 'Screenshot changed before export.');
  const artifact = await exportFile(context, {path: posix.relative(context.root, screenshot)});
  if (artifact.sha256 !== proof.sha256 || artifact.bytes !== proof.bytes) fail('conflict', 'Screenshot changed before export.');
  return {ok: true, artifact};
}

export async function browser(context: SandboxToolContext, raw: unknown) {
  const input = BrowserInputSchema.parse(raw);
  return withWorkspaceLock(context.port, context.root, () => browserLocked(context, input));
}
