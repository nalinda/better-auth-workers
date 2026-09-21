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
// the auth Worker can check the signature. The bearer plugin is held to the
// same rule (see auth/plugins/index.ts), so no route anywhere accepts a bare
// token as a credential.
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

// The bearer plugin is configured with `requireSignature`, so the only
// credential it accepts is the signed `<token>.<signature>` value — the
// same form the cookie is held to. A dotless header value is the bare
// session token, which the auth Worker refuses; rejecting it here too means
// neither caller below can use one as a cache lookup key, so a bare token
// cannot be served from — or recorded into — an entry. A client may send
// the signed value URL-encoded (its base64 signature carries `=`); the
// credential is normalised to the decoded form, so the same credential is
// recognised however a client encodes it. This is the one place the
// `Authorization` header is parsed: the session client and the auth
// Worker's invalidation hook both go through it.
export function bearerCredentialFromHeader(header: string | null | undefined): string | undefined {
  if (!header) return;
  // Split on the first space only and trim what follows, matching Better
  // Auth's own `slice(7).trim()` parser: `header.split(' ', 2)` would
  // instead split on every space in the header before truncating to two
  // elements, so a double space between the scheme and the token (or any
  // extra whitespace) silently produced an empty token.
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) return;
  const scheme = header.slice(0, spaceIndex);
  if (scheme.toLowerCase() !== 'bearer') return;
  const token = header.slice(spaceIndex + 1).trim();
  if (!token) return;
  const decoded = token.includes('%') ? decodeSafely(token) : token;
  return decoded && decoded.includes('.') ? decoded : undefined;
}

function decodeSafely(token: string): string | undefined {
  try {
    return decodeURIComponent(token);
  } catch {
    return;
  }
}

export function sessionCredentialFromAuthorizationHeader(request: Request): string | undefined {
  return bearerCredentialFromHeader(request.headers.get('authorization'));
}
