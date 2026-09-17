import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { type AuthEnv, createAuth } from '../../src/index';
import { buildEnv, createMockExecutionContext } from '../helpers/auth';

const sendOtpRequest = () =>
  new Request('https://auth.example.com/api/auth/phone-number/send-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: '+15551234567' }),
  });

describe('Phone OTP with user-supplied sendOTP under waitUntil', () => {
  let validEnv: AuthEnv;

  beforeEach(() => {
    validEnv = buildEnv();
  });

  describe('Asynchronous delivery under waitUntil', () => {
    it('returns the response before a slow sendOTP resolves and delegates delivery to ctx.waitUntil', async () => {
      const { promise: slowSendPromise, resolve: resolveSlowSend } = Promise.withResolvers<void>();
      let isSendOTPDone = false;
      const sendOTP = mock(async () => {
        await slowSendPromise;
        isSendOTPDone = true;
      });

      const { ctx, waitUntil, promises } = createMockExecutionContext();
      const auth = createAuth(validEnv, {
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
        expect(waitUntil).toHaveBeenCalledTimes(1);

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
      const auth = createAuth(validEnv, {
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

      const { ctx, waitUntil, promises } = createMockExecutionContext();
      const auth = createAuth(validEnv, {
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
        expect(waitUntil).toHaveBeenCalledTimes(1);

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

  describe('Delivery without an ExecutionContext', () => {
    it('warns once per instance that delivery may be cancelled, and still responds', async () => {
      const sendOTP = mock(() => {});
      const auth = createAuth(validEnv, { phone: { sendOTP } });

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        // Neither handler(request, ctx) nor options.ctx: nothing to waitUntil on.
        const first = await auth.handler(sendOtpRequest());
        const second = await auth.handler(sendOtpRequest());
        expect([first.status, second.status]).toEqual([200, 200]);
      } finally {
        console.warn = originalWarn;
      }

      expect(sendOTP).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/without an ExecutionContext/);
      expect(warnings[0]).toMatch(/auth\.handler\(request, ctx\)/);
    });

    it('does not warn when the context comes from handler(request, ctx)', async () => {
      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuth(validEnv, { phone: { sendOTP: () => {} } });
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        const res = await auth.handler(
          new Request('https://auth.example.com/api/auth/phone-number/send-otp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phoneNumber: '+15551234567' }),
          }),
          ctx
        );
        expect(res.status).toBe(200);
        await Promise.all(promises);
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings).toHaveLength(0);
    });
  });

  describe('Log hygiene for non-Error rejections', () => {
    it('redacts the code from a plain-object rejection before logging it', async () => {
      let sentCode = '';
      const sendOTP = mock(({ code }: { phoneNumber: string; code: string }) => {
        sentCode = code;
        // An SDK rejecting with a parsed error response that echoes the request.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection is the case under test
        return Promise.reject({ status: 502, request: { text: `Your code is ${code}` } });
      });
      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuth(validEnv, { ctx, phone: { sendOTP } });

      const capturedLogs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        capturedLogs.push(args.map(String).join(' '));
      };
      try {
        const res = await auth.handler(
          new Request('https://auth.example.com/api/auth/phone-number/send-otp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phoneNumber: '+15551234567' }),
          }),
          ctx
        );
        expect(res.status).toBe(200);
        await Promise.all(promises);

        expect(sentCode.length).toBeGreaterThan(0);
        const allLogs = capturedLogs.join('\n');
        expect(allLogs).toContain('502');
        expect(allLogs).toContain('[REDACTED]');
        expect(allLogs).not.toContain(sentCode);
      } finally {
        console.error = originalError;
      }
    });
  });

  describe('E.164 phone number validation', () => {
    it('rejects an invalid phone number before sendOTP is invoked', async () => {
      const sendOTP = mock(() => {});
      const { ctx } = createMockExecutionContext();
      const auth = createAuth(validEnv, {
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
      const auth = createAuth(validEnv, {
        phone: {
          sendOTP: async () => {},
        },
      });

      const phonePlugin = auth.options.plugins?.find((p) => p.id === 'phone-number');
      expect(phonePlugin?.options?.otpLength).toBe(6);
      expect(phonePlugin?.options?.expiresIn).toBe(300);
      expect(phonePlugin?.options?.allowedAttempts).toBe(3);

      const customAuth = createAuth(validEnv, {
        phone: {
          sendOTP: async () => {},
          otpLength: 8,
          expiresIn: 600,
          allowedAttempts: 5,
        },
      });

      const customPlugin = customAuth.options.plugins?.find((p) => p.id === 'phone-number');
      expect(customPlugin?.options?.otpLength).toBe(8);
      expect(customPlugin?.options?.expiresIn).toBe(600);
      expect(customPlugin?.options?.allowedAttempts).toBe(5);
    });

    it('treats a key set to undefined like an omitted key, keeping the package default', () => {
      const auth = createAuth(validEnv, {
        phone: {
          sendOTP: async () => {},
          otpLength: undefined,
          signUpOnVerification: undefined,
        },
      });

      const phonePlugin = auth.options.plugins?.find((p) => p.id === 'phone-number');
      expect(phonePlugin?.options?.otpLength).toBe(6);
      const signUp = phonePlugin?.options?.signUpOnVerification as
        { getTempEmail: (phoneNumber: string) => string } | undefined;
      expect(signUp?.getTempEmail('+15551234567')).toBe('+15551234567@phone.invalid');
    });

    it('signs up an unknown phone number on first verification with a placeholder email, overridable', () => {
      const auth = createAuth(validEnv, {
        phone: {
          sendOTP: async () => {},
        },
      });

      const phonePlugin = auth.options.plugins?.find((p) => p.id === 'phone-number');
      const signUp = phonePlugin?.options?.signUpOnVerification as
        { getTempEmail: (phoneNumber: string) => string } | undefined;
      expect(signUp).toBeDefined();
      expect(signUp?.getTempEmail('+15551234567')).toBe('+15551234567@phone.invalid');

      const customAuth = createAuth(validEnv, {
        phone: {
          sendOTP: async () => {},
          signUpOnVerification: { getTempEmail: (phoneNumber) => `${phoneNumber}@example.com` },
        },
      });
      const customSignUp = customAuth.options.plugins?.find((p) => p.id === 'phone-number')?.options
        ?.signUpOnVerification as { getTempEmail: (phoneNumber: string) => string };
      expect(customSignUp.getTempEmail('+15551234567')).toBe('+15551234567@example.com');
    });
  });
});
