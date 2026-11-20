import {HEALTH_PATH, HealthSchema} from '@praxis/protocol';
import {defineSuite, type StepContext, type StepOutcome} from '@praxis/verify';

/** Stable `develop` branch aliases of the two Vercel projects; per-deployment URLs change on every push. */
export const PREVIEW_API_URL = 'PRAXIS_PREVIEW_API_URL';
export const PREVIEW_WEB_URL = 'PRAXIS_PREVIEW_WEB_URL';
/** The `praxis-api` Protection Bypass for Automation secret. */
export const PREVIEW_API_BYPASS = 'PRAXIS_PREVIEW_API_BYPASS_SECRET';
export const VERCEL_BYPASS_HEADER = 'x-vercel-protection-bypass';
const PREVIEW_REQUEST_TIMEOUT_MS = 30_000;
/** A chat send starts by creating a chat, so this is the first preflight a browser makes. */
const PREFLIGHT_PATH = '/v1/chats';

function previewOrigin(context: StepContext, name: string): string {
  const url = new URL(context.config(name));
  if (url.protocol !== 'https:') throw new Error(`${name} must be an https origin`);
  return url.origin;
}

async function checkHealth(context: StepContext): Promise<StepOutcome> {
  const response = await fetch(previewOrigin(context, PREVIEW_API_URL) + HEALTH_PATH, {
    headers: {[VERCEL_BYPASS_HEADER]: context.secret(PREVIEW_API_BYPASS).reveal()},
    redirect: 'manual',
    signal: AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
  });
  context.log(`GET ${HEALTH_PATH} → ${response.status}`);
  if (response.status !== 200) {
    return {status: 'fail', summary: `expected 200, got ${response.status} (3xx/401: bypass rejected; 500: the API refused to start)`};
  }
  const health = HealthSchema.safeParse(await response.json().catch(() => undefined));
  if (!health.success) return {status: 'fail', summary: 'the /health body violates the protocol'};
  if (health.data.mode !== 'production') return {status: 'fail', summary: `mode is ${health.data.mode}, expected production`};
  return {status: 'pass', summary: 'mode production'};
}

/** Browsers send preflights without the bypass cookie, so this passes only with the project's OPTIONS allowlist. */
async function checkPreflight(context: StepContext): Promise<StepOutcome> {
  const web = previewOrigin(context, PREVIEW_WEB_URL);
  const response = await fetch(previewOrigin(context, PREVIEW_API_URL) + PREFLIGHT_PATH, {
    method: 'OPTIONS',
    headers: {origin: web, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type'},
    redirect: 'manual',
    signal: AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
  });
  const allowed = response.headers.get('access-control-allow-origin');
  const credentials = response.headers.get('access-control-allow-credentials');
  context.log(`OPTIONS ${PREFLIGHT_PATH} → ${response.status}, origin allowed ${allowed === web}, credentials ${credentials}`);
  if (!response.ok) return {status: 'fail', summary: `preflight answered ${response.status}`};
  if (allowed !== web) return {status: 'fail', summary: 'the web alias is not in the API preview PRAXIS_WEB_ORIGINS'};
  if (credentials !== 'true') return {status: 'fail', summary: 'credentialed requests are not allowed'};
  return {status: 'pass', summary: 'preflight from the web alias allowed with credentials'};
}

export default defineSuite({
  id: 'preview-env',
  issue: 'PRA-160',
  title: 'PRA-135 develop preview serves real data',
  steps: [
    {
      id: 'api-health', kind: 'auto',
      checklist: '`GET <api preview>/health` with the Vercel bypass header returns 200 and `{"mode":"production"}`.',
      needs: {secrets: [PREVIEW_API_BYPASS], config: [PREVIEW_API_URL]},
      run: checkHealth,
    },
    {
      id: 'web-cors', kind: 'auto',
      checklist: 'A CORS preflight from the `develop` web alias passes Vercel protection and is answered for that origin.',
      needs: {config: [PREVIEW_API_URL, PREVIEW_WEB_URL]},
      run: checkPreflight,
    },
    {
      id: 'signed-in-chat', kind: 'manual', needs: {}, evidence: 'file',
      checklist: 'A signed-in `primary` persona sends a chat on the `develop` web preview and gets an answer.',
      instruction: 'Open the develop web alias with the bypass cookie set for both web and API aliases, sign in as the QA profile primary persona, send one short chat and wait for the reply. Attach a screenshot showing the reply, or the reviewer run id that recorded it.',
    },
  ],
});
