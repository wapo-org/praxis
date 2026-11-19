import {execFile} from 'node:child_process';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import {CLOUD_DIR} from '@praxis/verify';
import {SealedSecret} from '@praxis/types';
import {z} from 'zod';

/** Convex Auth sends the sign-up link through the app's mounted Resend component, which keeps each email's body. */
const RESEND_COMPONENT = 'resend';
const EMAIL_SCAN_ROWS_MAX = 50;
const EMAIL_POLL_MS = 2_000;
const EMAIL_WAIT_MS = 45_000;
const CLI_TIMEOUT_MS = 60_000;
const CLI_OUTPUT_BYTES_MAX = 4 << 20;
const CONVEX_CLI = join(CLOUD_DIR, 'node_modules', 'convex', 'bin', 'main.js');

const run = promisify(execFile);
const EmailRow = z.object({_id: z.string(), to: z.union([z.string(), z.array(z.string())])});
const EmailBody = z.object({text: z.string().optional(), html: z.string().optional()}).nullable();

/** Pulls the `code` query parameter out of the first link in an email body that carries one. */
export function emailCodeFrom(body: string): string | null {
  const decoded = body.replaceAll('&amp;', '&');
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    try {
      const code = new URL(match[0]).searchParams.get('code');
      if (code) return code;
    } catch {
      continue;
    }
  }
  return null;
}

/** Recipient fields compare case-insensitively, as Convex Auth normalizes addresses. */
export function isRecipient(to: string | readonly string[], email: string): boolean {
  const wanted = email.toLowerCase();
  const list = typeof to === 'string' ? [to] : to;
  return list.some(address => address.toLowerCase().includes(wanted));
}

/** A deploy key names its deployment before `|`; reading another deployment's mailbox would prove nothing. */
export function deployKeyMatches(deployKey: string, convexUrl: string): boolean {
  const name = deployKey.split('|')[0]?.split(':').at(-1);
  return !!name && new URL(convexUrl).hostname.split('.')[0] === name;
}

/** The HTTP API ignores `componentPath` for system table reads, so component data goes through the Convex CLI. */
async function convexCli(deployKey: SealedSecret, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {...process.env, CONVEX_DEPLOY_KEY: deployKey.reveal()};
  delete env.CONVEX_DEPLOYMENT;
  try {
    const {stdout} = await run(process.execPath, [CONVEX_CLI, ...args], {
      cwd: CLOUD_DIR, env, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_OUTPUT_BYTES_MAX,
    });
    return stdout;
  } catch (error) {
    throw new Error(`convex ${args[0]} --component ${RESEND_COMPONENT} failed`, {cause: error});
  }
}

async function latestEmailId(deployKey: SealedSecret, email: string): Promise<string | null> {
  const stdout = await convexCli(deployKey, [
    'data', '--component', RESEND_COMPONENT, 'emails', '--format', 'jsonl', '--limit', String(EMAIL_SCAN_ROWS_MAX),
  ]);
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const row = EmailRow.safeParse(JSON.parse(line));
    if (row.success && isRecipient(row.data.to, email)) return row.data._id;
  }
  return null;
}

/** Reads the one-time sign-up code with the deployment admin key; the code never leaves a `SealedSecret`. */
export async function readSignUpCode(convexUrl: string, deployKey: SealedSecret, email: string): Promise<SealedSecret> {
  if (!deployKeyMatches(deployKey.reveal(), convexUrl)) throw new Error('The deploy key belongs to another deployment');
  const deadline = Date.now() + EMAIL_WAIT_MS;
  for (;;) {
    const emailId = await latestEmailId(deployKey, email);
    if (emailId) {
      const stdout = await convexCli(deployKey, ['run', '--component', RESEND_COMPONENT, 'lib:get', JSON.stringify({emailId})]);
      const body = EmailBody.parse(JSON.parse(stdout));
      const code = emailCodeFrom(body?.text ?? '') ?? emailCodeFrom(body?.html ?? '');
      if (code) return SealedSecret.of(code);
    }
    if (Date.now() >= deadline) throw new Error('No sign-up email with a code reached the deployment mailbox');
    await sleep(EMAIL_POLL_MS);
  }
}
