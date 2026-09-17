import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { requireSession } from '../../src/client';
import type { SessionClient, SessionData } from '../../src/session/types';

function makeSession(overrides: Partial<SessionData['user']> = {}): SessionData {
  return {
    session: {
      id: 'session-1',
      token: 'tok_1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    user: { id: 'user-1', email: 'alice@example.com', role: 'member', ...overrides },
  };
}

function clientReturning(session: SessionData | null): SessionClient {
  return { get: () => Promise.resolve(session) };
}

// The README's shape: an app with its own bindings and a per-request
// `sessions` variable, with the middleware typed against it — no casts.
// `bun run ts-check` compiles this, so a regression in how the middleware
// composes with a typed app turns this file red at compile time.
type AppEnv = {
  Bindings: { AUTH: Fetcher; AUTH_KV: KVNamespace };
  Variables: { sessions: SessionClient; session: SessionData };
};

function buildApp(client: SessionClient, canAccess?: (session: SessionData) => boolean) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('sessions', client);
    await next();
  });
  app.get(
    '/protected',
    (c, next) =>
      requireSession<AppEnv>({ client: c.get('sessions'), predicate: canAccess })(c, next),
    (c) => c.json({ userId: c.get('session').user.id })
  );
  // The direct form, for a client that is not read off the context.
  app.get('/direct', requireSession({ client, predicate: canAccess }), (c) =>
    c.json({ userId: c.get('session').user.id })
  );
  return app;
}

describe('Hono stays an optional peer dependency of ./client', () => {
  it('only type-imports hono, so importing ./client for createSessionClient never needs hono at runtime', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo-relative path, see file header
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, '../../src/session/require-session.ts'),
      'utf8'
    );
    const honoImports = source.match(/^import[^\n]*from ['"]hono['"];?$/gm) ?? [];

    expect(honoImports.length).toBeGreaterThan(0);
    for (const line of honoImports) {
      expect(line.startsWith('import type ')).toBe(true);
    }
  });
});

describe('requireSession Hono middleware', () => {
  it('returns 401 and does not reach the handler when there is no session', async () => {
    const app = buildApp(clientReturning(null));

    const response = await app.request('/protected');

    expect(response.status).toBe(401);
  });

  it('reads the session from the configured client and exposes it to the handler as c.var.session', async () => {
    const session = makeSession();
    const app = buildApp(clientReturning(session));

    const response = await app.request('/protected');
    const body = (await response.json()) as { userId: string };

    expect(response.status).toBe(200);
    expect(body.userId).toBe('user-1');
  });

  it('returns 403 and does not reach the handler when the predicate rejects the session', async () => {
    const session = makeSession({ role: 'member' });
    const app = buildApp(clientReturning(session), (s) => s.user.role === 'admin');

    const response = await app.request('/protected');

    expect(response.status).toBe(403);
  });

  it('reaches the handler when the predicate accepts the session', async () => {
    const session = makeSession({ role: 'admin' });
    const app = buildApp(clientReturning(session), (s) => s.user.role === 'admin');

    const response = await app.request('/protected');
    const body = (await response.json()) as { userId: string };

    expect(response.status).toBe(200);
    expect(body.userId).toBe('user-1');
  });

  it('works as a directly mounted middleware on an app with bindings and other variables', async () => {
    const app = buildApp(clientReturning(makeSession()));

    const ok = await app.request('/direct');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { userId: string }).userId).toBe('user-1');

    const denied = await buildApp(clientReturning(null)).request('/direct');
    expect(denied.status).toBe(401);
  });
});
