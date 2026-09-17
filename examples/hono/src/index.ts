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
    ctx: c.executionCtx,
    phone: {
      sendOTP: ({ phoneNumber, code }) => {
        // [local use only - not for production]
        // This console-logging sendOTP is for local development only, do not use in production.
        console.log(`[local use only - not for production] OTP for ${phoneNumber}: ${code}`);
      },
    },
    google: hasGoogle ? true : undefined,
    bearer: true,
    // Sign-in methods this deployment accepts; anything else is refused with
    // 403 rather than reaching the (still mounted) plugin route.
    allowedMethods: hasGoogle ? ['phone', 'google'] : ['phone'],
    betterAuth: {
      advanced: {
        // This Worker serves non-browser clients (phone OTP + bearer) that
        // send no Origin header. Better Auth's CSRF check refuses any
        // cookie-bearing POST without one, so it is disabled here. Keep it
        // on for a Worker whose clients are browsers.
        disableCSRFCheck: true,
      },
    },
  });

  return auth.handler(c.req.raw);
});

export default app;
