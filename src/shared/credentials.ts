export const DEFAULT_COOKIE_NAME = 'better-auth.session_token';

function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name && key !== `__Secure-${name}`) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
}

// Better Auth signs cookies as `<token>.<signature>`; the session is keyed by the bare token.
export function sessionTokenFromCookie(request: Request, cookieName: string): string | undefined {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return;
  const signed = readCookie(cookieHeader, cookieName);
  if (!signed) return;
  const [token] = signed.split('.', 1);
  return token || undefined;
}

// The bearer plugin sends the bare (unsigned) token, unlike the cookie.
export function sessionTokenFromAuthorizationHeader(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return;
  const [scheme, token] = header.split(' ', 2);
  if (!scheme || scheme.toLowerCase() !== 'bearer') return;
  return token || undefined;
}
