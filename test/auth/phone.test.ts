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
  phone?: {
    sendOTP: (
      args: { phoneNumber: string; code: string },
      request?: Request
    ) => Promise<void> | void;
    otpLength?: number;
    expiresIn?: number;
    allowedAttempts?: number;
    signUpOnVerification?: { getTempEmail: (phoneNumber: string) => string };
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

describe('Phone OTP with user-supplied sendOTP under waitUntil', () => {
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

  describe('Asynchronous delivery under waitUntil', () => {
    it('returns the response before a slow sendOTP resolves and delegates delivery to ctx.waitUntil', async () => {
      const { promise: slowSendPromise, resolve: resolveSlowSend } = Promise.withResolvers<void>();
      let isSendOTPDone = false;
      const sendOTP = mock(async () => {
        await slowSendPromise;
        isSendOTPDone = true;
      });

      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuthInstance(validEnv, {
        ctx,
        phone: { sendOTP },
      });

      const req = new Request('https://auth.example.com/api/auth/phone-number/send-otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: '+15551234567' }),
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
        expect(isSendOTPDone).toBe(false);
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

        resolveSlowSend();
        await Promise.all(promises);
        await handlerPromise;
        expect(isSendOTPDone).toBe(true);
      } finally {
        resolveSlowSend();
      }
    });
  });

  describe('Delivery failure handling', () => {
    it('returns a successful response when sendOTP throws and logs the error to worker logs', async () => {
      const deliveryError = new Error('SMS provider gateway timeout');
      const sendOTP = mock(() => {
        throw deliveryError;
      });

      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuthInstance(validEnv, {
        ctx,
        phone: { sendOTP },
      });

      const capturedLogs: string[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        capturedLogs.push(args.map(String).join(' '));
      };

      try {
        const req = new Request('https://auth.example.com/api/auth/phone-number/send-otp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phoneNumber: '+15551234567' }),
        });

        const res = await auth.handler(req, ctx);

        expect(res.status).toBe(200);

        const responseText = await res.text();
        expect(responseText).not.toContain('SMS provider gateway timeout');

        try {
          await Promise.all(promises);
        } catch {
          // delivery rejections are asserted on separately via captured logs
        }

        const loggedContent = capturedLogs.join('\n');
        expect(loggedContent).toContain('SMS provider gateway timeout');
      } finally {
        console.error = originalConsoleError;
      }
    });
  });

  describe('Log hygiene', () => {
    it('never includes the OTP code string in any captured worker log calls', async () => {
      let sentCode = '';
      const sendOTP = mock(({ code }: { phoneNumber: string; code: string }) => {
        sentCode = code;
      });

      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuthInstance(validEnv, {
        ctx,
        phone: { sendOTP },
      });

      const capturedLogs: string[] = [];
      const pushLog = (...args: unknown[]) => {
        capturedLogs.push(args.map(String).join(' '));
      };

      const originalError = console.error;
      const originalWarn = console.warn;
      const originalInfo = console.info;
      const originalLog = console.log;

      console.error = pushLog;
      console.warn = pushLog;
      console.info = pushLog;
      console.log = pushLog;

      try {
        const req = new Request('https://auth.example.com/api/auth/phone-number/send-otp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phoneNumber: '+15551234567' }),
        });

        const res = await auth.handler(req, ctx);
        expect(res.status).toBe(200);
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1);

        try {
          await Promise.all(promises);
        } catch {
          // delivery rejections are asserted on separately via captured logs
        }

        expect(sentCode).toBeDefined();
        expect(sentCode.length).toBeGreaterThanOrEqual(4);

        const allLogs = capturedLogs.join('\n');
        expect(allLogs).not.toContain(sentCode);
      } finally {
        console.error = originalError;
        console.warn = originalWarn;
        console.info = originalInfo;
        console.log = originalLog;
      }
    });
  });

  describe('E.164 phone number validation', () => {
    it('rejects an invalid phone number before sendOTP is invoked', async () => {
      const sendOTP = mock(() => {});
      const { ctx } = createMockExecutionContext();
      const auth = createAuthInstance(validEnv, {
        ctx,
        phone: { sendOTP },
      });

      const invalidNumbers = [
        '12345',
        '555-0199',
        'not-a-number',
        '+0123456789',
        '+15551234567890123456',
      ];

      for (const phoneNumber of invalidNumbers) {
        const req = new Request('https://auth.example.com/api/auth/phone-number/send-otp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phoneNumber }),
        });

        const res = await auth.handler(req, ctx);
        expect(res.status).toBe(400);
      }

      expect(sendOTP).not.toHaveBeenCalled();
    });
  });

  describe('Option defaults and passthrough', () => {
    it('applies default otpLength, expiresIn, and allowedAttempts to phone plugin options and allows overrides', () => {
      const auth = createAuthInstance(validEnv, {
        phone: {
          sendOTP: async () => {},
        },
      });

      const phonePlugin = auth.options?.plugins?.find((p) => p.id === 'phone-number');
      expect(phonePlugin?.options?.otpLength).toBe(6);
      expect(phonePlugin?.options?.expiresIn).toBe(300);
      expect(phonePlugin?.options?.allowedAttempts).toBe(3);

      const customAuth = createAuthInstance(validEnv, {
        phone: {
          sendOTP: async () => {},
          otpLength: 8,
          expiresIn: 600,
          allowedAttempts: 5,
        },
      });

      const customPlugin = customAuth.options?.plugins?.find((p) => p.id === 'phone-number');
      expect(customPlugin?.options?.otpLength).toBe(8);
      expect(customPlugin?.options?.expiresIn).toBe(600);
      expect(customPlugin?.options?.allowedAttempts).toBe(5);
    });

    it('signs up an unknown phone number on first verification with a placeholder email, overridable', () => {
      const auth = createAuthInstance(validEnv, {
        phone: {
          sendOTP: async () => {},
        },
      });

      const phonePlugin = auth.options?.plugins?.find((p) => p.id === 'phone-number');
      const signUp = phonePlugin?.options?.signUpOnVerification as
        { getTempEmail: (phoneNumber: string) => string } | undefined;
      expect(signUp).toBeDefined();
      expect(signUp?.getTempEmail('+15551234567')).toBe('+15551234567@phone.invalid');

      const customAuth = createAuthInstance(validEnv, {
        phone: {
          sendOTP: async () => {},
          signUpOnVerification: { getTempEmail: (phoneNumber) => `${phoneNumber}@example.com` },
        },
      });
      const customSignUp = customAuth.options?.plugins?.find((p) => p.id === 'phone-number')
        ?.options?.signUpOnVerification as { getTempEmail: (phoneNumber: string) => string };
      expect(customSignUp.getTempEmail('+15551234567')).toBe('+15551234567@example.com');
    });
  });
});
