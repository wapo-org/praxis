import {classifyHttp, CredentialSignalError, withCredential} from '@praxis/credentials';
import {ToolBoundaryError} from '@praxis/agent';
import {WEB_TOOL_LIMITS, type JsonObject} from '@praxis/protocol';
import {readLimited} from '../tools/http.js';
import {WEB_PROVIDERS, WEB_TEXT} from './constants.js';
import type {WebPorts, WebSpendInput} from './ports.js';

export async function webRequest(ports: WebPorts, service: keyof typeof WEB_PROVIDERS, body: JsonObject, signal: AbortSignal, input: WebSpendInput) {
  const config = WEB_PROVIDERS[service];
  return withCredential(ports.pools[service], ports.cooldowns, async credential => {
    if (!await ports.accounting.admitAttempt(input)) throw new ToolBoundaryError({code: 'budget', message: WEB_TEXT.budget, remediation: WEB_TEXT.budgetRemediation});
    const response = await ports.fetch(config.endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: {'content-type': 'application/json', [config.header]: service === 'firecrawl' ? `Bearer ${credential.reveal()}` : credential.reveal()},
      body: JSON.stringify(body),
    });
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
}
