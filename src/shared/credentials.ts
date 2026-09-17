export const DEFAULT_COOKIE_NAME = 'better-auth.session_token';

function findCookiePair(
  cookieHeader: string,
  name: string
): { key: string; raw: string } | undefined {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name && key !== `__Secure-${name}`) continue;
    return { key, raw: part.slice(eq + 1).trim() };
  }
}

function readCookie(cookieHeader: string, name: string): string | undefined {
  const pair = findCookiePair(cookieHeader, name);
  if (!pair) return;
  try {
    return decodeURIComponent(pair.raw);
  } catch {
    return pair.raw;
  }
}

// The session-token cookie exactly as the request sent it (`name=value`),
// so the auth Worker can be asked about that one cookie and nothing else —
// in particular not Better Auth's own cookie-cache cookie (`session_data`),
// whose answer would bypass the store the revocation hooks invalidate.
export function sessionCookiePairFrom(request: Request, cookieName: string): string | undefined {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return;
  const pair = findCookiePair(cookieHeader, cookieName);
  return pair ? `${pair.key}=${pair.raw}` : undefined;
}

// Better Auth signs cookies as `<token>.<signature>`. The whole signed value
// is the credential: the bare token is never trusted on its own, since only
// the auth Worker can check the signature.
export function sessionCredentialFromCookie(
  request: Request,
  cookieName: string
): string | undefined {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return;
  const signed = readCookie(cookieHeader, cookieName);
  if (!signed || !signed.includes('.')) return;
  return signed;
}

// The bearer plugin accepts the bare token or the signed cookie value,
// which a client may send URL-encoded (its base64 signature carries `=`).
// The credential is normalised to the decoded form, so the same credential
// is recognised however a client encodes it. This is the one place the
// `Authorization` header is parsed: the session client and the auth
// Worker's invalidation hook both go through it.
export function bearerCredentialFromHeader(header: string | null | undefined): string | undefined {
  if (!header) return;
  const [scheme, token] = header.split(' ', 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return;
  if (!token.includes('%')) return token;
  try {
    return decodeURIComponent(token);
  } catch {
    return;
  }
}

export function sessionCredentialFromAuthorizationHeader(request: Request): string | undefined {
  return bearerCredentialFromHeader(request.headers.get('authorization'));
}
