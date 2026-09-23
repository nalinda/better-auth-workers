import { type AuthEnv, createAuth, type CreateAuthOptions } from 'better-auth-workers';
import { createAuthAdmin } from 'better-auth-workers/admin';
import { Hono } from 'hono';
import pg from 'pg';

type Env = AuthEnv;

// One set of options for every way into the auth instance: the HTTP routes
// below and the AuthAdmin RPC entrypoint.
function authOptions(env: Env): CreateAuthOptions {
  const hasGoogle = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return {
    basePath: '/auth',
    // The Worker imports the pg driver itself so the bundler includes it.
    database: env.HYPERDRIVE ? { hyperdrive: env.HYPERDRIVE, pg } : { d1: env.DB },
    kv: env.AUTH_KV,
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
  };
}

const app = new Hono<{ Bindings: Env }>();

app.on(['GET', 'POST'], '/auth/*', (c) => {
  const auth = createAuth(c.env, authOptions(c.env));

  // The request's ExecutionContext goes with every call: the instance may
  // be memoised (D1 only; Hyperdrive rebuilds it per request), so delivery
  // scheduled through waitUntil (OTP, magic link) must run on this
  // request's context, not the one that built it.
  return auth.handler(c.req.raw, c.executionCtx);
});

// Ban and unban over RPC, for Workers bound to this entrypoint
// (`entrypoint: 'AuthAdmin'` in their service binding). Nothing reaches it
// over HTTP.
export const AuthAdmin = createAuthAdmin(authOptions);

export default app;
