import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { createAuth } from '../../src/index';

function createMockD1() {
  return {
    prepare: mock(() => ({
      bind: mock(() => ({
        all: mock(() => Promise.resolve({ results: [], meta: { changes: 0 } })),
        first: mock(() => Promise.resolve(null)),
        run: mock(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
      })),
    })),
    batch: mock(() => Promise.resolve([])),
    exec: mock(() => Promise.resolve({ count: 0, duration: 0 })),
  };
}

function createMockExecutionContext() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: mock((promise: Promise<unknown>) => {
        promises.push(promise);
      }),
      passThroughOnException: mock(() => {}),
    },
    promises,
  };
}

interface CreateAuthOptions {
  basePath?: string;
  baseURL?: string;
  secret?: string;
  database?: unknown;
  ctx?: {
    waitUntil: (promise: Promise<unknown>) => void;
    passThroughOnException?: () => void;
  };
  magicLink?: {
    sendMagicLink: (
      args: { email: string; url: string; token: string },
      request?: Request
    ) => Promise<void> | void;
    expiresIn?: number;
    disableSignUp?: boolean;
  };
  [key: string]: unknown;
}

interface AuthInstanceLike {
  handler: (
    req: Request,
    ctx?: { waitUntil: (promise: Promise<unknown>) => void }
  ) => Promise<Response>;
  options?: {
    plugins?: Array<{
      id: string;
      options?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const createAuthInstance = (
  env: Record<string, unknown>,
  options?: CreateAuthOptions
): AuthInstanceLike =>
  (
    createAuth as unknown as (e: Record<string, unknown>, o?: CreateAuthOptions) => AuthInstanceLike
  )(env, options);

describe('Magic link sign-in with user-supplied sendMagicLink under waitUntil', () => {
  const validSecret = 'test-secret-at-least-32-chars-long-1234567890';
  const validBaseUrl = 'https://auth.example.com';
  let validEnv: Record<string, unknown>;

  beforeEach(() => {
    validEnv = {
      AUTH_BASE_URL: validBaseUrl,
      BETTER_AUTH_SECRET: validSecret,
      DB: createMockD1(),
    };
  });

  describe('Plugin wiring', () => {
    it('configures the magic-link plugin when magicLink options are supplied', () => {
      const auth = createAuthInstance(validEnv, {
        magicLink: { sendMagicLink: async () => {} },
      });

      const magicLinkPlugin = auth.options?.plugins?.find((p) => p.id === 'magic-link');
      expect(magicLinkPlugin).toBeDefined();
    });

    it('does not configure the magic-link plugin when magicLink options are absent', () => {
      const auth = createAuthInstance(validEnv, {});

      const magicLinkPlugin = auth.options?.plugins?.find((p) => p.id === 'magic-link');
      expect(magicLinkPlugin).toBeUndefined();
    });
  });

  describe('Asynchronous delivery under waitUntil', () => {
    it('returns the response before a slow sendMagicLink resolves and delegates delivery to ctx.waitUntil', async () => {
      const { promise: slowSendPromise, resolve: resolveSlowSend } = Promise.withResolvers<void>();
      let isSendDone = false;
      const sendMagicLink = mock(async () => {
        await slowSendPromise;
        isSendDone = true;
      });

      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuthInstance(validEnv, {
        ctx,
        magicLink: { sendMagicLink },
      });

      const req = new Request('https://auth.example.com/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' }),
      });

      let isHandlerCompleted = false;
      let response: Response | undefined;

      const handlerPromise = (async () => {
        const res = await auth.handler(req, ctx);
        isHandlerCompleted = true;
        response = res;
        return res;
      })();

      try {
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(isHandlerCompleted).toBe(true);
        expect(response?.status).toBe(200);
        expect(isSendDone).toBe(false);
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

        resolveSlowSend();
        await Promise.all(promises);
        await handlerPromise;
        expect(isSendDone).toBe(true);
      } finally {
        resolveSlowSend();
      }
    });
  });

  describe('Delivery failure handling', () => {
    it('returns a successful response when sendMagicLink throws and logs the error to worker logs', async () => {
      const deliveryError = new Error('Email provider gateway timeout');
      const sendMagicLink = mock(() => {
        throw deliveryError;
      });

      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuthInstance(validEnv, {
        ctx,
        magicLink: { sendMagicLink },
      });

      const capturedLogs: string[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        capturedLogs.push(args.map(String).join(' '));
      };

      try {
        const req = new Request('https://auth.example.com/api/auth/sign-in/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'user@example.com' }),
        });

        const res = await auth.handler(req, ctx);

        expect(res.status).toBe(200);

        const responseText = await res.text();
        expect(responseText).not.toContain('Email provider gateway timeout');

        try {
          await Promise.all(promises);
        } catch {
          // delivery rejections are asserted on separately via captured logs
        }

        const loggedContent = capturedLogs.join('\n');
        expect(loggedContent).toContain('Email provider gateway timeout');
      } finally {
        console.error = originalConsoleError;
      }
    });
  });
});
