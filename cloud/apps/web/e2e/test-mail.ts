import { latestEmailLink as readEmail } from '../../../packages/verify/src/web/auth-account.js';
import { stackConvexUrl } from '../../../packages/verify/src/web/browser-setup.js';
export async function latestEmailLink(email: string): Promise<string> {
  return readEmail(stackConvexUrl(), email);
}
