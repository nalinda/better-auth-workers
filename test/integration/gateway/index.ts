import type { AuthAdminRpc } from '../../../src/client';

interface Env {
  AUTH: Fetcher;
  // The auth Worker's AuthAdmin entrypoint, over RPC.
  AUTH_ADMIN: AuthAdminRpc;
  API: Fetcher;
}

const counters = { authCalls: 0 };

async function adminCall(pathname: string, request: Request, env: Env): Promise<Response> {
  const { userId }: { userId: string } = await request.json();
  const result =
    pathname === '/__gateway/ban'
      ? await env.AUTH_ADMIN.banUser(userId, { reason: 'integration test' })
      : await env.AUTH_ADMIN.unbanUser(userId);
  return Response.json(result);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (pathname === '/__gateway/auth-calls') {
      return Response.json({ count: counters.authCalls });
    }
    // Test-only: drive the AuthAdmin entrypoint as another Worker would.
    if (pathname === '/__gateway/ban' || pathname === '/__gateway/unban') {
      return adminCall(pathname, request, env);
    }
    // The auth wrapper's own counters; reading them is not an auth call.
    if (pathname.startsWith('/__auth/')) {
      return env.AUTH.fetch(request);
    }
    if (pathname === '/auth' || pathname.startsWith('/auth/')) {
      counters.authCalls += 1;
      return env.AUTH.fetch(request);
    }
    return env.API.fetch(request);
  },
};
