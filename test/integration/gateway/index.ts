interface Env {
  AUTH: Fetcher;
  API: Fetcher;
}

const counters = { authCalls: 0 };

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const { pathname } = new URL(request.url);
    if (pathname === '/__gateway/auth-calls') {
      return Response.json({ count: counters.authCalls });
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
