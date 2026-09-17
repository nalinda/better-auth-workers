import { type AuthEnv, createAuth } from 'better-auth-workers';
import { Hono } from 'hono';
import pg from 'pg';

type Env = AuthEnv;

const app = new Hono<{ Bindings: Env }>();

app.on(['GET', 'POST'], '/auth/*', (c) => {
  const hasGoogle = Boolean(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
  const auth = createAuth(c.env, {
    basePath: '/auth',
    // The Worker imports the pg driver itself so the bundler includes it.
    database: c.env.HYPERDRIVE ? { hyperdrive: c.env.HYPERDRIVE, pg } : { d1: c.env.DB },
    kv: c.env.AUTH_KV,
    phone: {
      sendOTP: ({ phoneNumber, code }) => {
        // [local use only - not for production]
        // This console-logging sendOTP is for local development only, do not use in production.
        console.log(`[local use only - not for production] OTP for ${phoneNumber}: ${code}`);
      },
    },
    magicLink: {
      sendMagicLink: ({ email, url }) => {
        // [local use only - not for production]
        // Logs the link instead of emailing it; open it from the terminal to sign in.
        console.log(`[local use only - not for production] Magic link for ${email}: ${url}`);
      },
    },
    google: hasGoogle ? true : undefined,
    bearer: true,
    // Sign-in methods this deployment accepts; any other method's routes
    // answer 403, whether or not that method's plugin is configured.
    allowedMethods: hasGoogle ? ['phone', 'magic-link', 'google'] : ['phone', 'magic-link'],
  });

  // The request's ExecutionContext goes with every call: the instance is
  // memoised, so delivery scheduled through waitUntil (OTP, magic link)
  // must run on this request's context, not the one that built it.
  return auth.handler(c.req.raw, c.executionCtx);
});

export default app;
