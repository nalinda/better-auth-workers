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

// The bearer plugin sends the bare (unsigned) token, unlike the cookie.
export function sessionCredentialFromAuthorizationHeader(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return;
  const [scheme, token] = header.split(' ', 2);
  if (!scheme || scheme.toLowerCase() !== 'bearer') return;
  return token || undefined;
}
