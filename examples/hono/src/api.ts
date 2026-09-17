import {
  createSessionClient,
  requireSession,
  type SessionClient,
  type SessionData,
} from 'better-auth-workers/client';
import { Hono } from 'hono';

interface Env {
  // Service binding pointing to the auth Worker
  AUTH: Fetcher;
  AUTH_KV: KVNamespace;
}

type AppEnv = {
  Bindings: Env;
  Variables: { sessions: SessionClient; session: SessionData };
};

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const sessions = createSessionClient({
    auth: c.env.AUTH,
    kv: c.env.AUTH_KV,
    basePath: '/auth',
  });
  c.set('sessions', sessions);
  await next();
});

app.get(
  '/me',
  (c, next) => requireSession<AppEnv>({ client: c.get('sessions') })(c, next),
  (c) => c.json(c.get('session').user)
);

export default app;
