import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CLOUD_DIR, HOSTED_API_URL, defineSuite, hosted, hostedTurn, replyText, runCommand, withHosted, type ErrorBody, type StepContext} from '@praxis/verify';

/** A funded key on the live-check account; every auto step that needs a working model reads it. */
const LIVE_KEY = 'OPENROUTER_LIVE_KEY';
const REVOKED_KEY = 'OPENROUTER_REVOKED_KEY';
const ZERO_CREDIT_KEY = 'OPENROUTER_ZERO_CREDIT_KEY';
const SMOKE_KEY = 'SMOKE_OPENROUTER_KEY';
const WEB_URL = 'PRAXIS_LIVE_WEB_URL';
/** A Claude model with tools and reasoning in the curated list; change it here when the curated list moves. */
const CLAUDE_MODEL = 'anthropic/claude-sonnet-5.5';
const TOOL_PROMPT = 'Use the JavaScript tool to compute 6 * 7, then answer with the number only.';

async function connect(context: StepContext, secretName: string) {
  return hosted<ErrorBody & {maskedKey?: string}>(context, '/v1/model-key', {method: 'paste', apiKey: context.secret(secretName).reveal()});
}

function rejected(response: {status: number; body: ErrorBody}, expected: string) {
  return response.status === 400 && response.body.code === expected;
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
        const response = await hosted<ErrorBody>(context, '/v1/model-key', {method: 'paste', apiKey: `gsk_${'0'.repeat(40)}`});
        return rejected(response, 'model_key_rejected') ? {status: 'pass', summary: response.body.message ?? 'rejected'} : {status: 'fail', summary: `expected 400 model_key_rejected, got ${response.status} ${response.body.code ?? ''}`};
      },
    },
    {
      id: 'reject-revoked-key',
      kind: 'auto',
      checklist: 'Paste a revoked key: model_key_rejected with OpenRouter\'s text.',
      needs: withHosted({secrets: [REVOKED_KEY]}),
      async run(context) {
        const response = await connect(context, REVOKED_KEY);
        const ok = rejected(response, 'model_key_rejected') && /OpenRouter said:/.test(response.body.message ?? '');
        return ok ? {status: 'pass', summary: response.body.message ?? 'rejected'} : {status: 'fail', summary: `expected model_key_rejected quoting OpenRouter, got ${response.status} ${response.body.code ?? ''}`};
      },
    },
    {
      id: 'paste-key',
      kind: 'auto',
      checklist: 'Paste a real key and it connects.',
      needs: withHosted({secrets: [LIVE_KEY]}),
      async run(context) {
        const response = await connect(context, LIVE_KEY);
        if (response.status !== 200) return {status: 'fail', summary: `connect answered ${response.status} ${response.body.code ?? ''}`};
        const stored = await hosted<{maskedKey?: string; lastError?: string}>(context, '/v1/model-key');
        context.attach('model-key.json', JSON.stringify(stored.body, null, 2));
        return stored.body.maskedKey && !stored.body.lastError ? {status: 'pass', summary: `connected as ${stored.body.maskedKey}`} : {status: 'fail', summary: 'the stored key is missing or flagged'};
      },
    },
    {
      id: 'chat-turn',
      kind: 'auto',
      checklist: 'A real chat turn on the default model.',
      needs: withHosted({secrets: [LIVE_KEY]}),
      async run(context) {
        const run = await hostedTurn(context, {text: 'Reply with the single word: pong'});
        context.state.set('defaultRun', JSON.stringify({id: run.run.id, usage: run.usage ?? null}));
        const text = replyText(run);
        return run.run.status === 'completed' && text.trim() ? {status: 'pass', summary: `run ${run.run.id} completed: "${text.slice(0, 80)}"`} : {status: 'fail', summary: `run ${run.run.id} ended ${run.run.status} ${run.run.errorCode ?? ''}`};
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
        const {id, usage} = JSON.parse(recorded) as {id: string; usage: {cost?: number} | null};
        return typeof usage?.cost === 'number' ? {status: 'pass', summary: `run ${id} cost ${usage.cost}`} : {status: 'fail', summary: `run ${id} snapshot has no usage.cost`};
      },
    },
    {
      id: 'tools-reasoning',
      kind: 'auto',
      checklist: 'A turn with tools plus a reasoning effort on a Claude model, and reasoning replay across turns.',
      needs: withHosted({secrets: [LIVE_KEY]}),
      async run(context) {
        const first = await hostedTurn(context, {text: TOOL_PROMPT, modelId: CLAUDE_MODEL, effort: 'high'});
        if (first.run.status !== 'completed' || !replyText(first).includes('42')) return {status: 'fail', summary: `tool turn ended ${first.run.status} ${first.run.errorCode ?? ''}: "${replyText(first).slice(0, 80)}"`};
        const second = await hostedTurn(context, {text: 'Which number did you compute? Answer with the number only.', chatId: first.chatId});
        const replayed = second.run.status === 'completed' && replyText(second).includes('42');
        return replayed ? {status: 'pass', summary: `tool turn ${first.run.id} and follow-up ${second.run.id} completed on ${CLAUDE_MODEL}`} : {status: 'fail', summary: `follow-up ended ${second.run.status} ${second.run.errorCode ?? ''}`};
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
        const connected = await connect(context, ZERO_CREDIT_KEY);
        if (connected.status !== 200) return {status: 'fail', summary: `zero-credit key did not connect: ${connected.status} ${connected.body.code ?? ''}`};
        try {
          const run = await hostedTurn(context, {text: 'Reply with the single word: pong'});
          return run.run.errorCode === 'model_credit_exhausted' ? {status: 'pass', summary: `run ${run.run.id} ended model_credit_exhausted`} : {status: 'fail', summary: `run ${run.run.id} ended ${run.run.status} ${run.run.errorCode ?? ''}`};
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
        const response = await hosted<{items?: {id: string}[]}>(context, '/v1/models?limit=5');
        const count = response.body.items?.length ?? 0;
        return response.status === 200 && count > 0 ? {status: 'pass', summary: `catalogue served ${count} models on the first page`} : {status: 'fail', summary: `catalogue answered ${response.status} with ${count} models`};
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
      checklist: 'node cloud/scripts/smoke-remote.mjs --with-llm with SMOKE_OPENROUTER_KEY passes.',
      needs: {secrets: [SMOKE_KEY], config: [HOSTED_API_URL, WEB_URL]},
      async run(context) {
        // smoke-remote reads the key from an env file; keep it outside the proof directory and delete it after.
        const directory = mkdtempSync(join(tmpdir(), 'praxis-verify-'));
        const envFile = join(directory, '.env.smoke');
        writeFileSync(envFile, `${SMOKE_KEY}=${context.secret(SMOKE_KEY).reveal()}\n`, {mode: 0o600});
        try {
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
