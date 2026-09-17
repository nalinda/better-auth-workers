import { type AuthEnv, createAuth } from 'better-auth-workers';
import { Hono } from 'hono';

type Env = AuthEnv;

const app = new Hono<{ Bindings: Env }>();

app.on(['GET', 'POST'], '/auth/*', (c) => {
  const auth = createAuth(c.env, {
    basePath: '/auth',
    database: c.env.HYPERDRIVE ? { hyperdrive: c.env.HYPERDRIVE } : { d1: c.env.DB },
    kv: c.env.AUTH_KV,
    ctx: c.executionCtx,
    phone: {
      sendOTP: ({ phoneNumber, code }) => {
        // [local use only - not for production]
        // This console-logging sendOTP is for local development only, do not use in production.
        console.log(`[local use only - not for production] OTP for ${phoneNumber}: ${code}`);
      },
    },
    google: c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET ? true : undefined,
    bearer: true,
  });

  return auth.handler(c.req.raw);
});

export default app;
