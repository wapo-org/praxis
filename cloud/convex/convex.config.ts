import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import auth from '@convex-dev/auth/convex.config.js';
import password from '@convex-dev/auth/components/password/convex.config.js';
import email from '@convex-dev/auth/components/email/convex.config.js';
import google from '@convex-dev/auth/components/google/convex.config.js';
import resend from '@convex-dev/resend/convex.config.js';
import workflow from '@convex-dev/workflow/convex.config.js';
import agent from '@convex-dev/agent/convex.config.js';
import { AUTH_ENV, AUTH_PATHS } from './authConstants.js';

const app = defineApp({
  env: Object.fromEntries(Object.values(AUTH_ENV).map(key => [key, v.string()])),
});
app.use(auth);
app.use(password);
app.use(email);
app.use(resend);
app.use(google, {
  httpPrefix: AUTH_PATHS.google,
  env: { CLIENT_ID: app.env[AUTH_ENV.googleId], CLIENT_SECRET: app.env[AUTH_ENV.googleSecret] },
});
app.use(workflow);
app.use(agent);
export default app;
