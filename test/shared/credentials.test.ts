import { describe, expect, it } from 'bun:test';

import {
  bearerCredentialFromHeader,
  sessionCredentialFromAuthorizationHeader,
} from '../../src/shared/credentials';

function requestWithAuthorization(value: string): Request {
  return new Request('https://api.example.com/me', { headers: { authorization: value } });
}

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

describe('sessionCredentialFromAuthorizationHeader', () => {
  it('accepts a signed credential, decoded', () => {
    expect(
      sessionCredentialFromAuthorizationHeader(requestWithAuthorization('Bearer tok.c2ln'))
    ).toBe('tok.c2ln');
    expect(
      sessionCredentialFromAuthorizationHeader(requestWithAuthorization('Bearer tok.c2ln%3D'))
    ).toBe('tok.c2ln=');
  });

  it('rejects a bare token, which the auth Worker refuses too', () => {
    expect(
      sessionCredentialFromAuthorizationHeader(requestWithAuthorization('Bearer sess_abc123'))
    ).toBeUndefined();
  });

  it('returns undefined when there is no Authorization header', () => {
    expect(
      sessionCredentialFromAuthorizationHeader(new Request('https://api.example.com/me'))
    ).toBeUndefined();
  });
});
