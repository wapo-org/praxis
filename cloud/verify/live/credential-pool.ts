import {cooldownKey, GROQ_POOL, slotSuffix} from '@praxis/credentials';
import {defineSuite, type StepContext} from '@praxis/verify';
import {z} from 'zod';

const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const VERCEL_API = 'https://api.vercel.com';
const REQUEST_TIMEOUT_MS = 20_000;

/** Upstash answers `{result}` or `{error}`; anything else is a broken reply, not evidence. */
const UpstashReply = z.union([z.object({result: z.unknown()}).strict(), z.object({error: z.string()}).strict()]);
/** Redis TTL: seconds, or -1 (no expiry) / -2 (no key). */
const Ttl = z.number().int().min(-2);
const StoredValue = z.string().nullable();
/** Vercel v9 env listing: `target` is an array of environment names; anything else is a broken reply, not evidence. */
const VercelEnvs = z.object({envs: z.array(z.object({key: z.string(), target: z.array(z.enum(['production', 'preview', 'development'])).optional()}))});

async function upstash<S extends z.ZodType>(context: StepContext, command: string[], schema: S): Promise<z.infer<S>> {
  const response = await fetch(context.config('UPSTASH_REDIS_REST_URL'), {
    method: 'POST',
    headers: {authorization: `Bearer ${context.secret('UPSTASH_REDIS_REST_TOKEN').reveal()}`, 'content-type': 'application/json'},
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Upstash ${command[0]} answered HTTP ${response.status}`);
  const reply = UpstashReply.parse(await response.json());
  if ('error' in reply) throw new Error(`Upstash ${command[0]} failed: ${reply.error}`);
  return schema.parse(reply.result);
}

export default defineSuite({
  id: 'credential-pool',
  issue: 'PRA-69',
  title: 'PRA-61 credential pool on real Groq keys and Upstash',
  steps: [
    {
      id: 'vercel-env',
      kind: 'auto',
      checklist: 'Set GROQ_API_KEY and GROQ_API_KEY_2 (two real Groq keys) in Vercel.',
      needs: {secrets: ['VERCEL_TOKEN'], config: ['VERCEL_PROJECT_ID']},
      async run(context) {
        const project = encodeURIComponent(context.config('VERCEL_PROJECT_ID'));
        const response = await fetch(`${VERCEL_API}/v9/projects/${project}/env`, {
          headers: {authorization: `Bearer ${context.secret('VERCEL_TOKEN').reveal()}`},
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return {status: 'fail', summary: `Vercel env listing answered HTTP ${response.status}`};
        const {envs} = VercelEnvs.parse(await response.json());
        const wanted = [1, 2].map(slot => `${GROQ_POOL.name}${slotSuffix(slot)}`);
        const production = new Set(envs.filter(env => env.target?.includes('production')).map(env => env.key));
        const missing = wanted.filter(name => !production.has(name));
        context.log(`production env names checked: ${wanted.join(', ')}`);
        return missing.length ? {status: 'fail', summary: `missing in Vercel production: ${missing.join(', ')}`} : {status: 'pass', summary: 'both pool slots are set for production'};
      },
    },
    {
      id: 'keys-authenticate',
      kind: 'auto',
      checklist: 'Set GROQ_API_KEY and GROQ_API_KEY_2 (two real Groq keys) in Vercel.',
      needs: {pools: [{...GROQ_POOL, minSlots: 2}]},
      async run(context) {
        const failed: number[] = [];
        for (const {slot, credential} of context.pool(GROQ_POOL.name).slots) {
          const response = await fetch(GROQ_MODELS_URL, {headers: {authorization: `Bearer ${credential.reveal()}`}, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
          context.log(`slot ${slot}: HTTP ${response.status}`);
          if (!response.ok) failed.push(slot);
        }
        return failed.length ? {status: 'fail', summary: `Groq rejected slot(s) ${failed.join(', ')}`} : {status: 'pass', summary: 'every slot authenticates against Groq'};
      },
    },
    {
      id: 'failover',
      kind: 'manual',
      checklist: 'Failover on real keys: slot 1 unavailable, /v1/transcribe succeeds on slot 2, logs show slot numbers only.',
      needs: {},
      instruction: 'Revoke slot 1 (or deploy an invalid GROQ_API_KEY to a test environment), dictate once, then export the Vercel log lines of type "credentials" for that request.',
      evidence: 'file',
    },
    {
      id: 'cooldown',
      kind: 'auto',
      checklist: 'Cool-down in real Upstash: pool:groq:1:cooldown exists with a TTL and holds no key material.',
      needs: {secrets: ['UPSTASH_REDIS_REST_TOKEN'], config: ['UPSTASH_REDIS_REST_URL'], pools: [{...GROQ_POOL, minSlots: 1}]},
      async run(context) {
        const key = cooldownKey(GROQ_POOL.service, 1);
        const ttl = await upstash(context, ['TTL', key], Ttl);
        const value = (await upstash(context, ['GET', key], StoredValue)) ?? '';
        context.log(`${key}: ttl ${ttl}s, ${value.length} bytes`);
        if (ttl <= 0) return {status: 'fail', summary: `${key} has no live TTL (${ttl}); run the failover step first`};
        const leaked = context.pool(GROQ_POOL.name).slots.some(({credential}) => value.includes(credential.reveal()));
        return leaked ? {status: 'fail', summary: `${key} contains key material`} : {status: 'pass', summary: `${key} expires in ${ttl}s and holds no key material`};
      },
    },
    {
      id: 'cooldown-expiry',
      kind: 'manual',
      checklist: 'Slot 1 is used again after the TTL expires.',
      needs: {},
      instruction: 'After the cool-down TTL has passed (and slot 1 is valid again), dictate once and export the "credentials" log line showing slot 1.',
      evidence: 'file',
    },
    {
      id: 'fail-open',
      kind: 'manual',
      checklist: 'Fail-open: with Upstash unreachable (wrong URL in a test environment), transcription still succeeds.',
      needs: {},
      instruction: 'In a test deployment with UPSTASH_REDIS_REST_URL pointing nowhere, dictate once; attach a screen recording or the response log.',
      evidence: 'file',
    },
    {
      id: 'all-cooling',
      kind: 'manual',
      checklist: 'All slots cooling: /v1/transcribe returns 429 or 502 with no upstream call.',
      needs: {},
      instruction: 'Cool down every slot, call /v1/transcribe, and attach the response plus the log showing no Groq request.',
      evidence: 'file',
    },
    {
      id: 'startup-check',
      kind: 'manual',
      checklist: 'Startup check: a half-defined multi-part slot fails the deploy; a numbering gap only logs a warning.',
      needs: {},
      instruction: 'Deploy a preview with a half-defined slot (expect the startup error), then with GROQ_API_KEY_3 but no _2 (expect a startup.warning line); attach both logs.',
      evidence: 'file',
    },
  ],
});
