import type { Hono, Context } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { AccountDeleteSchema } from '@praxis/protocol';
import { ApiError } from './service.js';
export interface AccountDeletion {
  confirm?(
    request: Request,
    password?: string,
  ): Promise<{ userId: string; sessionId: string } | null>;
  purge(userId: string, sessionId: string): Promise<void>;
}
export function registerAccountDeletion(
  app: Hono<any>,
  options: {
    config?: AccountDeletion;
    local: boolean;
    devTokens: Map<string, string>;
    devCreated: Map<string, number>;
    limited: (key: string) => Promise<void>;
    hasLimiter: boolean;
    parse: (c: Context) => Promise<import('zod').infer<typeof AccountDeleteSchema>>;
  },
) {
  const attempts = new Map<string, { count: number; until: number }>();
  app.delete('/v1/account', async (c) => {
    const userId = c.get('userId') as string;
    const input = await options.parse(c);
    if (options.hasLimiter) await options.limited(`account-delete:${userId}`);
    {
      // Also bound recovery attempts while owner Redis writes are frozen.
      const prior = attempts.get(userId),
        value =
          prior && prior.until > Date.now() ? prior : { count: 0, until: Date.now() + 3600000 };
      value.count++;
      attempts.set(userId, value);
      if (value.count > 5)
        throw new ApiError(429, 'rate_limited', 'Too many account deletion attempts');
    }
    if (!options.config)
      throw new ApiError(503, 'deletion_unavailable', 'Account deletion is not configured');
    let confirmed: { userId: string; sessionId: string } | null = null;
    if (options.local) {
      const token =
          c.req.header('authorization')?.replace(/^Bearer /i, '') ?? getCookie(c, 'praxis_session'),
        age = Date.now() - (token ? (options.devCreated.get(token) ?? 0) : 0);
      if (token && age >= 0 && age < 300000) confirmed = { userId, sessionId: token };
    } else confirmed = (await options.config.confirm?.(c.req.raw, input.password)) ?? null;
    if (!confirmed || confirmed.userId !== userId)
      throw new ApiError(
        403,
        'confirmation_required',
        'Confirm your current password or sign in again',
      );
    await options.config.purge(userId, confirmed.sessionId);
    for (const [token, user] of options.devTokens)
      if (user === userId) {
        options.devTokens.delete(token);
        options.devCreated.delete(token);
      }
    attempts.delete(userId);
    deleteCookie(c, 'praxis_session', { path: '/' });
    c.header('Cache-Control', 'no-store');
    return c.json({ type: 'account.deleted' });
  });
}
