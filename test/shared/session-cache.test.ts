import { serializeSignedCookie } from 'better-call';
import { describe, expect, it } from 'bun:test';

import { sessionCacheKey, sessionCacheKeysFor } from '../../src/shared/session-cache';
import { VALID_SECRET } from '../helpers/auth';

const TOKEN = 'session-token-abc123';

// The signed-cookie cache key is rebuilt from the token with the same
// algorithm better-call uses to sign the cookie. If a better-auth /
// better-call bump changes that format, the auth Worker would stop clearing
// the entries cookie-carrying requests create; this pins the two together.
describe('signed-cookie cache key mirrors better-call’s cookie signature', () => {
  it('produces exactly the value better-call puts in the session cookie', async () => {
    const serialized = await serializeSignedCookie(
      'better-auth.session_token',
      TOKEN,
      VALID_SECRET
    );
    const [pair] = serialized.split(';', 1);
    const cookieValue = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
    expect(cookieValue.startsWith(`${TOKEN}.`)).toBe(true);

    const keys = await sessionCacheKeysFor(TOKEN, VALID_SECRET);

    expect(keys).toEqual([sessionCacheKey(TOKEN), sessionCacheKey(cookieValue)]);
  });

  it('changes with the secret, so a key cannot be derived without it', async () => {
    const [, withSecret] = await sessionCacheKeysFor(TOKEN, VALID_SECRET);
    const [, withOther] = await sessionCacheKeysFor(TOKEN, 'another-secret-at-least-32-chars-long');
    expect(withSecret).not.toBe(withOther);
  });
});
