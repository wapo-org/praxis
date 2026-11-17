import { latestEmailLink as readEmail } from '../../../packages/verify/src/web/auth-account.js';
export async function latestEmailLink(email: string): Promise<string> {
  const url = process.env.PW_CONVEX_URL;
  if (!url) throw new Error('PW_CONVEX_URL is required for the local test mailbox');
  return readEmail(url, email);
}
