import {classifyHttp, CredentialSignalError, withCredential} from '@praxis/credentials';
import {ToolBoundaryError} from '@praxis/agent';
import {WEB_TOOL_LIMITS, type JsonObject, type WebSpendCall} from '@praxis/protocol';
import {readLimited} from '../tools/http.js';
import {WEB_PROVIDERS, WEB_TEXT} from './constants.js';
import type {WebPorts} from './ports.js';

/** What reached the provider: a 2xx bills, a request without any response may have billed. */
export interface WebDispatch {
  billed: boolean;
  uncertain: boolean;
  slot: number;
}
export const newDispatch = (): WebDispatch => ({billed: false, uncertain: false, slot: 0});

export async function webRequest(ports: WebPorts, service: keyof typeof WEB_PROVIDERS, body: JsonObject, signal: AbortSignal,
  call: WebSpendCall, dispatch: WebDispatch): Promise<unknown> {
  const config = WEB_PROVIDERS[service];
  const result = await withCredential(ports.pools[service], ports.cooldowns, async (credential, slot) => {
    if (!await ports.accounting.admitAttempt(call)) throw new ToolBoundaryError({code: 'budget', message: WEB_TEXT.budget, remediation: WEB_TEXT.budgetRemediation});
    dispatch.uncertain = true;
    const response = await ports.fetch(config.endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: {'content-type': 'application/json', [config.header]: service === 'firecrawl' ? `Bearer ${credential.reveal()}` : credential.reveal()},
      body: JSON.stringify(body),
    });
    dispatch.uncertain = false;
    if (response.ok) Object.assign(dispatch, {billed: true, slot});
    const classification = classifyHttp(response.status, response.headers);
    if (classification.kind !== 'ok') {
      await response.body?.cancel();
      throw new CredentialSignalError(classification);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ToolBoundaryError({code: 'upstream', message: WEB_TEXT.readFailed, remediation: WEB_TEXT.readRemediation});
    }
    return JSON.parse(new TextDecoder().decode(await readLimited(response.body, WEB_TOOL_LIMITS.RESPONSE_BYTES_MAX))) as unknown;
  }, {log: ports.log});
  return result.value;
}
