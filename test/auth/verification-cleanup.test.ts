import { APIError } from 'better-auth/api';
import { describe, expect, it, mock } from 'bun:test';

import { buildVerificationCleanup } from '../../src/auth/verification-cleanup';
import { buildEnv } from '../helpers/auth';

const MAGIC_LINK = { magicLink: { sendMagicLink: () => {} } };

function context(
  path: string,
  {
    deleteMany = mock(() => Promise.resolve()),
    returned,
  }: { deleteMany?: ReturnType<typeof mock>; returned?: unknown } = {}
) {
  return { ctx: { path, context: { returned, adapter: { deleteMany } } }, deleteMany };
}

// Each test uses a fresh env, so its sweep interval starts unspent.
describe('sweeping expired verification rows after a magic link is sent', () => {
  it('deletes rows past their expiry', async () => {
    const cleanup = buildVerificationCleanup(MAGIC_LINK, buildEnv());
    const { ctx, deleteMany } = context('/sign-in/magic-link');

    await cleanup?.(ctx);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const [input] = deleteMany.mock.calls[0] as unknown as [
      { model: string; where: Array<{ field: string; value: Date; operator: string }> },
    ];
    expect(input.model).toBe('verification');
    expect(input.where).toHaveLength(1);
    expect(input.where[0]?.field).toBe('expiresAt');
    expect(input.where[0]?.operator).toBe('lt');
    expect(Math.abs((input.where[0]?.value.getTime() ?? 0) - Date.now())).toBeLessThan(1000);
  });

  it('sweeps at most once per interval for one Worker env', async () => {
    const env = buildEnv();
    const first = context('/sign-in/magic-link');
    const second = context('/sign-in/magic-link');

    await buildVerificationCleanup(MAGIC_LINK, env)?.(first.ctx);
    await buildVerificationCleanup(MAGIC_LINK, env)?.(second.ctx);

    expect(first.deleteMany).toHaveBeenCalledTimes(1);
    expect(second.deleteMany).not.toHaveBeenCalled();
  });

  it('runs only after a magic-link send that succeeded', async () => {
    const cleanup = buildVerificationCleanup(MAGIC_LINK, buildEnv());
    const otherRoute = context('/phone-number/send-otp');
    const refused = context('/sign-in/magic-link', {
      returned: new APIError('BAD_REQUEST', { message: 'Invalid email' }),
    });

    await cleanup?.(otherRoute.ctx);
    await cleanup?.(refused.ctx);

    expect(otherRoute.deleteMany).not.toHaveBeenCalled();
    expect(refused.deleteMany).not.toHaveBeenCalled();
  });

  it('is not installed without magic link, whose flows sweep on lookup', () => {
    expect(buildVerificationCleanup({ phone: { sendOTP: () => {} } }, buildEnv())).toBeUndefined();
  });

  it("respects Better Auth's verification.disableCleanup", () => {
    expect(
      buildVerificationCleanup(
        { ...MAGIC_LINK, betterAuth: { verification: { disableCleanup: true } } },
        buildEnv()
      )
    ).toBeUndefined();
  });

  it('still sweeps, unthrottled, for a caller that passed no env', async () => {
    const cleanup = buildVerificationCleanup(MAGIC_LINK, undefined as never);
    const { ctx, deleteMany } = context('/sign-in/magic-link');

    await cleanup?.(ctx);

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it('logs a failed sweep instead of failing the request', async () => {
    const cleanup = buildVerificationCleanup(MAGIC_LINK, buildEnv());
    const { ctx } = context('/sign-in/magic-link', {
      deleteMany: mock(() => Promise.reject(new Error('db down'))),
    });
    const originalError = console.error;
    const logged = mock(() => {});
    console.error = logged;
    try {
      await cleanup?.(ctx);
    } finally {
      console.error = originalError;
    }

    expect(logged).toHaveBeenCalledTimes(1);
  });
});
