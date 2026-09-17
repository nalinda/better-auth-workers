export type AuthEnv = Record<string, string | KVNamespace | Hyperdrive | D1Database | Fetcher>;

export interface AuthInstance {
  handler: (request: Request) => Promise<Response>;
}

export function createAuth(): AuthInstance {
  return {
    handler: () => Promise.resolve(new Response(null, { status: 404 })),
  };
}
