import { describe, expect, it } from 'bun:test';

import { bearerCredentialFromHeader } from '../../src/shared/credentials';

describe('bearerCredentialFromHeader', () => {
  it('extracts the token from a well-formed header', () => {
    expect(bearerCredentialFromHeader('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(bearerCredentialFromHeader('bearer abc123')).toBe('abc123');
  });

  it('tolerates extra whitespace between the scheme and the token', () => {
    // A naive `header.split(' ', 2)` splits on every space before
    // truncating to two elements, so a double space here would previously
    // yield an empty token and the credential would be dropped entirely.
    expect(bearerCredentialFromHeader('Bearer  abc123')).toBe('abc123');
    expect(bearerCredentialFromHeader('Bearer   abc123')).toBe('abc123');
  });

  it('decodes a URL-encoded signed-cookie-style token', () => {
    expect(bearerCredentialFromHeader('Bearer abc%3Ddef')).toBe('abc=def');
  });

  it('returns undefined for a missing, empty, or malformed header', () => {
    expect(bearerCredentialFromHeader(null)).toBeUndefined();
    expect(bearerCredentialFromHeader(undefined)).toBeUndefined();
    expect(bearerCredentialFromHeader('')).toBeUndefined();
    expect(bearerCredentialFromHeader('Bearer')).toBeUndefined();
    expect(bearerCredentialFromHeader('Bearer ')).toBeUndefined();
    expect(bearerCredentialFromHeader('Basic abc123')).toBeUndefined();
  });
});
