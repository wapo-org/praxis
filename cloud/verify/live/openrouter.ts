import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelKeySchema, ModelListItemSchema, PageSchema, type Message} from '@praxis/protocol';
import {z} from 'zod';
import {CLOUD_DIR, HOSTED_API_URL, chatMessages, defineSuite, expectOk, hosted, hostedTurn, replyText, runCommand, withHosted, type HostedResult, type HostedTurn, type StepContext, type StepOutcome} from '@praxis/verify';

/** A funded key on the live-check account; every auto step that needs a working model reads it. */
const LIVE_KEY = 'OPENROUTER_LIVE_KEY';
const REVOKED_KEY = 'OPENROUTER_REVOKED_KEY';
const ZERO_CREDIT_KEY = 'OPENROUTER_ZERO_CREDIT_KEY';
const SMOKE_KEY = 'SMOKE_OPENROUTER_KEY';
const WEB_URL = 'PRAXIS_LIVE_WEB_URL';
const CONVEX_URL = 'CONVEX_URL';
const SMOKE_EMAIL = 'SMOKE_ACCOUNT_EMAIL';
const SMOKE_PASSWORD = 'SMOKE_ACCOUNT_PASSWORD';
/** A Claude model with tools and reasoning in the curated list; change it here when the curated list moves. */
const CLAUDE_MODEL = 'anthropic/claude-sonnet-5.5';
const TOOL_PROMPT = 'You must call the JavaScript tool to compute 6 * 7; do not answer from memory. Then answer with the number only.';
const MODEL_KEY_PATH = '/v1/model-key';

async function connect(context: StepContext, secretName: string) {
  return hosted(context, MODEL_KEY_PATH, ModelKeySchema, {method: 'paste', apiKey: context.secret(secretName).reveal()});
}

function expectRejected(result: HostedResult<unknown>, quoting?: RegExp): StepOutcome {
  if (result.ok) return {status: 'fail', summary: `expected 400 model_key_rejected, the key was accepted (HTTP ${result.status})`};
  const ok = result.status === 400 && result.error.code === 'model_key_rejected' && (!quoting || quoting.test(result.error.message));
  return ok ? {status: 'pass', summary: result.error.message} : {status: 'fail', summary: `expected 400 model_key_rejected${quoting ? ' quoting OpenRouter' : ''}, got ${result.status} ${result.error.code}`};
}

/** Tool, reasoning and the persisted reasoning part that the next turn replays; each is observed, not inferred from the answer. */
function toolTurnProblems(turn: HostedTurn): string[] {
  const problems: string[] = [];
  if (turn.run.status !== 'completed') problems.push(`run ended ${turn.run.status} ${turn.run.errorCode ?? ''}`.trim());
  if (!turn.tools.some(tool => tool.completion?.status === 'succeeded')) problems.push('no tool call succeeded');
  if (!turn.blocks.some(block => block.type === 'reasoning')) problems.push('no reasoning block');
  if (!replyText(turn).includes('42')) problems.push(`answer lacks 42: "${replyText(turn).slice(0, 80)}"`);
  return problems;
}

const ReasoningDetails = z.object({reasoning_details: z.array(z.object({type: z.string(), signature: z.string().optional(), data: z.string().optional()}).loose())}).loose();

/** The next turn replays `raw.data.reasoning_details` (agent wire.ts); Anthropic accepts back only signed or encrypted entries. */
function replaysSignedReasoning(message: Message): boolean {
  const raw = ReasoningDetails.safeParse(message.raw?.data);
  if (!raw.success) return false;
  return raw.data.reasoning_details.some(detail => (detail.type === 'reasoning.text' && !!detail.signature) || (detail.type === 'reasoning.encrypted' && !!detail.data));
}

export default defineSuite({
  id: 'openrouter',
  issue: 'PRA-89',
  title: 'PRA-59 OpenRouter key, runs and catalogue on a real account',
  steps: [
    {
      id: 'pkce-hosted',
      kind: 'manual',
      checklist: 'PKCE on the hosted web origin: Connect → OpenRouter → /settings/openrouter/callback; the card shows masked key, label and credit.',
      needs: {},
      instruction: 'On the hosted web app, Settings → Models → Connect OpenRouter, finish the OpenRouter sign-in, and screenshot the connected card.',
      evidence: 'file',
    },
    {
      id: 'reject-foreign-key',
      kind: 'auto',
      checklist: 'Paste a non-OpenRouter key: model_key_rejected.',
      needs: withHosted(),
      async run(context) {
        return expectRejected(await hosted(context, MODEL_KEY_PATH, ModelKeySchema, {method: 'paste', apiKey: `gsk_${'0'.repeat(40)}`}));
      },
    },
    {
      id: 'reject-revoked-key',
      kind: 'auto',
      checklist: 'Paste a revoked key: model_key_rejected with OpenRouter\'s text.',
      needs: withHosted({secrets: [REVOKED_KEY]}),
      async run(context) {
        return expectRejected(await connect(context, REVOKED_KEY), /OpenRouter said:/);
      },
    },
    {
      id: 'paste-key',
      kind: 'auto',
      checklist: 'Paste a real key and it connects.',
      needs: withHosted({secrets: [LIVE_KEY]}),
      async run(context) {
        expectOk(await connect(context, LIVE_KEY), 'connecting the live key');
        const stored = expectOk(await hosted(context, MODEL_KEY_PATH, ModelKeySchema), 'reading the stored key');
        context.attach('model-key.json', JSON.stringify(stored, null, 2));
        return stored.lastError ? {status: 'fail', summary: `stored key is flagged: ${stored.lastError}`} : {status: 'pass', summary: `connected as ${stored.maskedKey}`};
      },
    },
    {
      id: 'chat-turn',
      kind: 'auto',
      checklist: 'A real chat turn on the default model.',
      needs: withHosted({secrets: [LIVE_KEY]}),
      async run(context) {
        const turn = await hostedTurn(context, {text: 'Reply with the single word: pong'});
        context.state.set('defaultRun', JSON.stringify({id: turn.run.id, cost: turn.usage?.cost ?? null}));
        const text = replyText(turn);
        return turn.run.status === 'completed' && text.trim() ? {status: 'pass', summary: `run ${turn.run.id} completed: "${text.slice(0, 80)}"`} : {status: 'fail', summary: `run ${turn.run.id} ended ${turn.run.status} ${turn.run.errorCode ?? ''}`};
      },
    },
    {
      id: 'usage-cost',
      kind: 'auto',
      checklist: 'usage.cost appears on the run snapshot.',
      needs: withHosted({secrets: [LIVE_KEY]}),
      async run(context) {
        const recorded = context.state.get('defaultRun');
        if (!recorded) return {status: 'fail', summary: 'chat-turn did not record a run; run it first'};
        const {id, cost} = JSON.parse(recorded) as {id: string; cost: number | null};
        return typeof cost === 'number' ? {status: 'pass', summary: `run ${id} cost ${cost}`} : {status: 'fail', summary: `run ${id} snapshot has no usage.cost`};
      },
    },
    {
      id: 'tools-reasoning',
      kind: 'auto',
      checklist: 'A turn with tools plus a reasoning effort on a Claude model, and reasoning replay across turns.',
      needs: withHosted({secrets: [LIVE_KEY]}),
      async run(context) {
        const first = await hostedTurn(context, {text: TOOL_PROMPT, modelId: CLAUDE_MODEL, effort: 'high'});
        const problems = toolTurnProblems(first);
        if (problems.length) return {status: 'fail', summary: `tool turn ${first.run.id}: ${problems.join('; ')}`};
        const stored = (await chatMessages(context, first.chatId)).filter(message => message.role === 'assistant' && message.runId === first.run.id);
        if (!stored.some(replaysSignedReasoning)) return {status: 'fail', summary: `run ${first.run.id} stored no signed reasoning_details, so nothing can be replayed`};
        const second = await hostedTurn(context, {text: 'Which number did you compute? Answer with the number only.', chatId: first.chatId});
        const replayed = second.run.status === 'completed' && replyText(second).includes('42');
        return replayed ? {status: 'pass', summary: `tool + reasoning turn ${first.run.id}, signed reasoning_details stored, follow-up ${second.run.id} completed on ${CLAUDE_MODEL}`} : {status: 'fail', summary: `follow-up with replayed reasoning ended ${second.run.status} ${second.run.errorCode ?? ''}`};
      },
    },
    {
      id: 'revoked-at-openrouter',
      kind: 'manual',
      checklist: 'Revoke the key at OpenRouter, then send: the run ends with model_key_invalid and the card shows "Needs attention".',
      needs: {},
      instruction: 'Revoke the connected key in the OpenRouter dashboard, send a message on the hosted app, and screenshot the failed turn plus the Settings card.',
      evidence: 'file',
    },
    {
      id: 'zero-credit',
      kind: 'auto',
      checklist: 'A zero-credit key ends the run with model_credit_exhausted (402).',
      needs: withHosted({secrets: [ZERO_CREDIT_KEY, LIVE_KEY]}),
      async run(context) {
        expectOk(await connect(context, ZERO_CREDIT_KEY), 'connecting the zero-credit key');
        try {
          const turn = await hostedTurn(context, {text: 'Reply with the single word: pong'});
          return turn.run.errorCode === 'model_credit_exhausted' ? {status: 'pass', summary: `run ${turn.run.id} ended model_credit_exhausted`} : {status: 'fail', summary: `run ${turn.run.id} ended ${turn.run.status} ${turn.run.errorCode ?? ''}`};
        } finally {
          await connect(context, LIVE_KEY);
        }
      },
    },
    {
      id: 'catalogue',
      kind: 'auto',
      checklist: 'The catalogue loads in production through the guarded fetch and the Upstash cache.',
      needs: withHosted(),
      async run(context) {
        const page = expectOk(await hosted(context, '/v1/models?limit=5', PageSchema(ModelListItemSchema)), 'listing models');
        return page.items.length ? {status: 'pass', summary: `catalogue served ${page.items.length} models on the first page`} : {status: 'fail', summary: 'catalogue answered with no models'};
      },
    },
    {
      id: 'catalogue-last-good',
      kind: 'manual',
      checklist: 'The catalogue serves the last good copy when a fetch fails.',
      needs: {},
      instruction: 'With a cached catalogue in Upstash, make the OpenRouter fetch fail (test deployment, blocked egress) and attach the /v1/models response plus the warning log.',
      evidence: 'file',
    },
    {
      id: 'smoke-remote',
      kind: 'auto',
      checklist: 'Hosted smoke passes with a disposable verified Convex Auth account and an OpenRouter key.',
      needs: {secrets: [SMOKE_KEY, SMOKE_EMAIL, SMOKE_PASSWORD], config: [HOSTED_API_URL, WEB_URL, CONVEX_URL]},
      async run(context) {
        // Keep smoke credentials outside the proof directory.
        const directory = mkdtempSync(join(tmpdir(), 'praxis-verify-'));
        const envFile = join(directory, '.env.smoke');
        try {
          const entries = [
            [CONVEX_URL, context.config(CONVEX_URL)],
            ...[SMOKE_KEY, SMOKE_EMAIL, SMOKE_PASSWORD].map(key => [key, context.secret(key).reveal()]),
          ];
          if (entries.some(([, value]) => /[\r\n]/.test(value!))) throw Error('Smoke settings must be single-line');
          writeFileSync(envFile, entries.map(([key, value]) => `${key}="${value}"\n`).join(''), {mode: 0o600});
          const result = await runCommand('node', ['scripts/smoke-remote.mjs', context.config(HOSTED_API_URL), context.config(WEB_URL), '--with-llm', '--env', envFile], {cwd: CLOUD_DIR});
          context.attach('smoke-remote.log', result.output);
          return result.code === 0 ? {status: 'pass', summary: 'smoke-remote --with-llm passed'} : {status: 'fail', summary: `smoke-remote exited ${result.code}`};
        } finally {
          rmSync(directory, {recursive: true, force: true});
        }
      },
    },
    {
      id: 'key-never-leaks',
      kind: 'manual',
      checklist: 'The key never appears in Vercel logs, Upstash values or PostHog events (spot check).',
      needs: {},
      instruction: 'Search Vercel logs, Upstash values and PostHog events for the key prefix and last characters; attach the empty search results.',
      evidence: 'file',
    },
  ],
});
