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

function buildApp(client: SessionClient, canAccess?: (session: SessionData) => boolean) {
  const app = new Hono<{ Variables: { session: SessionData } }>();
  app.get('/protected', requireSession({ client, predicate: canAccess }), (c) =>
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
});
