import { beforeEach, describe, expect, it, mock } from 'bun:test';

import { type AuthEnv, createAuth } from '../../src/index';
import { buildEnv, createMockExecutionContext } from '../helpers/auth';

describe('Magic link sign-in with user-supplied sendMagicLink under waitUntil', () => {
  let validEnv: AuthEnv;

  beforeEach(() => {
    validEnv = buildEnv();
  });

  describe('Plugin wiring', () => {
    it('configures the magic-link plugin when magicLink options are supplied', () => {
      const auth = createAuth(validEnv, {
        magicLink: { sendMagicLink: async () => {} },
      });

      const magicLinkPlugin = auth.options.plugins?.find((p) => p.id === 'magic-link');
      expect(magicLinkPlugin).toBeDefined();
    });

    it('does not configure the magic-link plugin when magicLink options are absent', () => {
      const auth = createAuth(validEnv, {});

      const magicLinkPlugin = auth.options.plugins?.find((p) => p.id === 'magic-link');
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

      const { ctx, waitUntil, promises } = createMockExecutionContext();
      const auth = createAuth(validEnv, {
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
        expect(waitUntil).toHaveBeenCalledTimes(1);

        resolveSlowSend();
        await Promise.all(promises);
        await handlerPromise;
        expect(isSendDone).toBe(true);
      } finally {
        resolveSlowSend();
      }
    });
  });

  describe('Log hygiene', () => {
    it('never logs the magic-link token or URL, even when the delivery error echoes them', async () => {
      let sentUrl = '';
      let sentToken = '';
      const sendMagicLink = mock(({ url, token }: { url: string; token: string }) => {
        sentUrl = url;
        sentToken = token;
        throw new Error(`gateway rejected request body: {"link":"${url}","token":"${token}"}`);
      });

      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuth(validEnv, { ctx, magicLink: { sendMagicLink } });

      const capturedLogs: string[] = [];
      const pushLog = (...args: unknown[]) => {
        capturedLogs.push(args.map(String).join(' '));
      };
      const originalError = console.error;
      const originalLog = console.log;
      console.error = pushLog;
      console.log = pushLog;

      try {
        const res = await auth.handler(
          new Request('https://auth.example.com/api/auth/sign-in/magic-link', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'user@example.com' }),
          }),
          ctx
        );
        expect(res.status).toBe(200);
        await Promise.all(promises);

        expect(sentToken.length).toBeGreaterThan(0);
        const allLogs = capturedLogs.join('\n');
        expect(allLogs).toContain('gateway rejected request body');
        expect(allLogs).not.toContain(sentToken);
        expect(allLogs).not.toContain(sentUrl);
      } finally {
        console.error = originalError;
        console.log = originalLog;
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
      const auth = createAuth(validEnv, {
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
