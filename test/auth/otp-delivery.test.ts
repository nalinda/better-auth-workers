import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  createAuth,
  type CreateAuthPhoneOptions,
  OTP_DELIVERY_FAILED,
  OTPDeliveryError,
} from '../../src/index';
import { buildEnv, createMockExecutionContext, FakeKV, postJSON } from '../helpers/auth';
import { migratedSqlite } from '../helpers/sqlite';

const API = 'https://auth.example.com/api/auth';
const PHONE = '+15551234567';

// sendOTP records the code it was asked to deliver, then does `behave`.
function recordingSendOTP(behave: () => Promise<void> | void = () => {}) {
  const codes: string[] = [];
  const requests: Array<Request | undefined> = [];
  const sendOTP: CreateAuthPhoneOptions['sendOTP'] = async ({ code }, request) => {
    codes.push(code);
    requests.push(request);
    await behave();
  };
  return { sendOTP, codes, requests };
}

function awaitedAuth(
  sendOTP: CreateAuthPhoneOptions['sendOTP'],
  phone: Partial<CreateAuthPhoneOptions> = {},
  kv: FakeKV = new FakeKV()
) {
  return createAuth(buildEnv({ DB: undefined, AUTH_KV: kv.asBinding() }), {
    phone: { sendOTP, awaitDelivery: true, ...phone },
    betterAuth: { database: migratedSqlite() },
  });
}

// A KV namespace whose deletes are refused, as KV does for a second write
// to one key within a second.
class DeleteRefusingKV extends FakeKV {
  override delete(): Promise<void> {
    return Promise.reject(new Error('KV DELETE failed: 429 Too Many Requests'));
  }
}

const sendOtp = (auth: ReturnType<typeof createAuth>) =>
  auth.handler(postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }));

const verify = (auth: ReturnType<typeof createAuth>, code: string) =>
  auth.handler(postJSON(`${API}/phone-number/verify`, { phoneNumber: PHONE, code }));

describe('phone.awaitDelivery', () => {
  const originalError = console.error;
  let logged: unknown[][];

  beforeEach(() => {
    logged = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
  });

  afterEach(() => {
    console.error = originalError;
  });

  it('answers only after sendOTP has finished, without waitUntil', async () => {
    let isDelivered = false;
    const { sendOTP } = recordingSendOTP(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      isDelivered = true;
    });
    const { ctx, waitUntil } = createMockExecutionContext();

    const res = await awaitedAuth(sendOTP).handler(
      postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }),
      ctx
    );

    expect(res.status).toBe(200);
    expect(isDelivered).toBe(true);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('turns a failed delivery into 502 OTP_DELIVERY_FAILED and deletes the undelivered code', async () => {
    const { sendOTP, codes } = recordingSendOTP(() => {
      throw new Error('gateway down');
    });
    const auth = awaitedAuth(sendOTP);

    const res = await sendOtp(auth);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: OTP_DELIVERY_FAILED });
    const verified = await verify(auth, codes.join(''));
    expect(verified.status).toBe(400);
    expect(await verified.json()).toMatchObject({ code: 'OTP_NOT_FOUND' });
  });

  it('logs the failure with the code redacted', async () => {
    const { sendOTP, codes } = recordingSendOTP(() => {
      throw new Error(`gateway rejected body {"code":"${codes.at(-1) ?? ''}"}`);
    });

    await sendOtp(awaitedAuth(sendOTP));

    const text = logged.flat().map(String).join('\n');
    expect(text).toContain('gateway rejected body');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(codes.at(-1) ?? 'no code');
  });

  it('logs an error that is a plain object, serialised and with the code redacted', async () => {
    const { sendOTP, codes } = recordingSendOTP(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- an SDK rejecting with a parsed body
      throw { error: 'rejected', body: { code: codes.at(-1) } };
    });

    await sendOtp(awaitedAuth(sendOTP));

    const text = logged.flat().map(String).join('\n');
    expect(text).toContain('rejected');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('[object Object]');
  });

  it("passes an OTPDeliveryError's code, status and retryAfter through", async () => {
    const { sendOTP } = recordingSendOTP(() => {
      throw new OTPDeliveryError('RATE_LIMITED', {
        message: 'Too many codes for this number',
        retryAfter: 60,
      });
    });

    const res = await sendOtp(awaitedAuth(sendOTP));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many codes for this number',
      retryAfter: 60,
    });
    expect(logged).toEqual([]);
  });

  it('uses the status an OTPDeliveryError names, and 502 without retryAfter', async () => {
    const blocked = recordingSendOTP(() => {
      throw new OTPDeliveryError('NUMBER_BLOCKED', { status: 403 });
    });
    const unreachable = recordingSendOTP(() => {
      throw new OTPDeliveryError('CARRIER_UNREACHABLE');
    });

    const blockedRes = await sendOtp(awaitedAuth(blocked.sendOTP));
    const unreachableRes = await sendOtp(awaitedAuth(unreachable.sendOTP));

    expect(blockedRes.status).toBe(403);
    expect(await blockedRes.json()).toMatchObject({ code: 'NUMBER_BLOCKED' });
    expect(blockedRes.headers.get('retry-after')).toBeNull();
    expect(unreachableRes.status).toBe(502);
  });

  it('recognises an OTPDeliveryError from another copy of the package', async () => {
    // Structurally an OTPDeliveryError, but not this copy's class.
    class ForeignOTPDeliveryError extends Error {
      override name = 'OTPDeliveryError';
      code = 'RATE_LIMITED';
      status = 429;
      retryAfter = 30;
    }
    const { sendOTP } = recordingSendOTP(() => {
      throw new ForeignOTPDeliveryError('Slow down');
    });

    const res = await sendOtp(awaitedAuth(sendOTP));

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED', retryAfter: 30 });
  });

  it('deletes the code when sendOTP refuses with an OTPDeliveryError too', async () => {
    const { sendOTP, codes } = recordingSendOTP(() => {
      throw new OTPDeliveryError('NUMBER_BLOCKED', { status: 403 });
    });
    const auth = awaitedAuth(sendOTP);

    await sendOtp(auth);
    const verified = await verify(auth, codes.join(''));

    expect(await verified.json()).toMatchObject({ code: 'OTP_NOT_FOUND' });
  });

  // A double-tapped resend: the first send fails only after the second has
  // stored (and delivered) a newer code, which must survive the first's
  // cleanup.
  it('does not delete a newer code from a resend when an earlier send fails', async () => {
    const { promise: firstMayFail, resolve: letFirstFail } = Promise.withResolvers<void>();
    const codes: string[] = [];
    let sends = 0;
    const sendOTP: CreateAuthPhoneOptions['sendOTP'] = async ({ code }) => {
      sends += 1;
      codes.push(code);
      if (sends === 1) {
        await firstMayFail;
        throw new Error('provider timeout');
      }
    };
    const auth = awaitedAuth(sendOTP);

    const first = sendOtp(auth);
    await Bun.sleep(20);
    const second = await sendOtp(auth);
    letFirstFail();
    const failed = await first;

    expect(second.status).toBe(200);
    expect(failed.status).toBe(502);
    const verified = await verify(auth, codes[1] ?? '');
    expect(verified.status).toBe(200);
  });

  it('still answers 502 OTP_DELIVERY_FAILED when deleting the undelivered code is refused', async () => {
    const { sendOTP } = recordingSendOTP(() => {
      throw new Error('gateway down');
    });

    const res = await sendOtp(awaitedAuth(sendOTP, {}, new DeleteRefusingKV()));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: OTP_DELIVERY_FAILED });
  });

  it('rounds retryAfter up to whole seconds, and drops one that is not a number', async () => {
    const fractional = recordingSendOTP(() => {
      throw new OTPDeliveryError('SLOW_DOWN', { retryAfter: 1.2 });
    });
    const unparsed = recordingSendOTP(() => {
      throw new OTPDeliveryError('SLOW_DOWN', {
        retryAfter: Number('Wed, 21 Oct 2015'),
        status: 429,
      });
    });

    const fractionalRes = await sendOtp(awaitedAuth(fractional.sendOTP));
    const unparsedRes = await sendOtp(awaitedAuth(unparsed.sendOTP));

    expect(fractionalRes.headers.get('retry-after')).toBe('2');
    expect(await fractionalRes.json()).toMatchObject({ retryAfter: 2 });
    expect(unparsedRes.status).toBe(429);
    expect(unparsedRes.headers.get('retry-after')).toBeNull();
    expect(await unparsedRes.json()).not.toHaveProperty('retryAfter');
  });

  it('answers 502 for an OTPDeliveryError with a status it does not support', async () => {
    class ForeignOTPDeliveryError extends Error {
      override name = 'OTPDeliveryError';
      code = 'TEAPOT';
      status = 418;
    }
    const { sendOTP } = recordingSendOTP(() => {
      throw new ForeignOTPDeliveryError('no');
    });

    const res = await sendOtp(awaitedAuth(sendOTP));

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'TEAPOT' });
  });

  it('refuses to start alongside betterAuth.advanced.backgroundTasks', () => {
    expect(() =>
      createAuth(buildEnv(), {
        phone: { sendOTP: () => {}, awaitDelivery: true },
        betterAuth: { advanced: { backgroundTasks: { handler: () => {} } } },
      })
    ).toThrow(/phone.awaitDelivery cannot be combined with betterAuth.advanced.backgroundTasks/);
  });

  it('still verifies a code that was delivered', async () => {
    const { sendOTP, codes } = recordingSendOTP();
    const auth = awaitedAuth(sendOTP);

    await sendOtp(auth);
    const verified = await verify(auth, codes[0] ?? '');

    expect(verified.status).toBe(200);
  });

  it('is not passed on to Better Auth as a plugin option', () => {
    const auth = awaitedAuth(recordingSendOTP().sendOTP);
    const plugin = auth.options.plugins?.find((p) => p.id === 'phone-number');

    expect(plugin?.options).not.toHaveProperty('awaitDelivery');
  });
});

describe('phone.beforeSendOTP', () => {
  it('refuses before a code is made, so the code already sent stays valid', async () => {
    const { sendOTP, codes } = recordingSendOTP();
    let isLimited = false;
    const auth = awaitedAuth(sendOTP, {
      beforeSendOTP: () => {
        if (isLimited) throw new OTPDeliveryError('OTP_RESEND_LIMITED', { retryAfter: 900 });
      },
    });

    await sendOtp(auth);
    isLimited = true;
    const refused = await sendOtp(auth);

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('900');
    expect(await refused.json()).toMatchObject({ code: 'OTP_RESEND_LIMITED', retryAfter: 900 });
    expect(codes).toHaveLength(1);
    const verified = await verify(auth, codes[0] ?? '');
    expect(verified.status).toBe(200);
  });

  it('receives the phone number and the request', async () => {
    const beforeSendOTP = mock((_args: { phoneNumber: string }, _request?: Request) => {});
    const auth = awaitedAuth(recordingSendOTP().sendOTP, { beforeSendOTP });

    await sendOtp(auth);

    expect(beforeSendOTP.mock.calls[0]?.[0]).toEqual({ phoneNumber: PHONE });
    expect(beforeSendOTP.mock.calls[0]?.[1]).toBeInstanceOf(Request);
  });

  it('answers 502 OTP_DELIVERY_FAILED for any other error, and sends nothing', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const { sendOTP, codes } = recordingSendOTP();
      const auth = awaitedAuth(sendOTP, {
        beforeSendOTP: () => {
          throw new Error('allowance service down');
        },
      });

      const res = await sendOtp(auth);

      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: OTP_DELIVERY_FAILED });
      expect(codes).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  // A per-number limit must not be keyed on junk the endpoint then refuses.
  it('is not called for a number the endpoint will refuse', async () => {
    const beforeSendOTP = mock(() => {});
    const auth = awaitedAuth(recordingSendOTP().sendOTP, { beforeSendOTP });

    const res = await auth.handler(
      postJSON(`${API}/phone-number/send-otp`, { phoneNumber: '0771234567' })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_PHONE_NUMBER' });
    expect(beforeSendOTP).not.toHaveBeenCalled();
  });

  it('passes an APIError it throws through as its own response', async () => {
    const { APIError } = await import('better-auth/api');
    const auth = awaitedAuth(recordingSendOTP().sendOTP, {
      beforeSendOTP: () => {
        throw new APIError('FORBIDDEN', { code: 'NUMBER_NOT_ALLOWED', message: 'No' });
      },
    });

    const res = await sendOtp(auth);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'NUMBER_NOT_ALLOWED' });
  });

  // Test mode sends nothing; the check may call a service not there locally.
  it('is not called in test mode', async () => {
    const beforeSendOTP = mock(() => {});
    const auth = createAuth(
      buildEnv({ AUTH_BASE_URL: 'http://localhost:8787', AUTH_KV: new FakeKV().asBinding() }),
      { phone: { sendOTP: () => {}, beforeSendOTP }, testMode: { otpCode: '123456' } }
    );

    const res = await auth.handler(
      postJSON('http://localhost:8787/api/auth/phone-number/send-otp', { phoneNumber: PHONE })
    );

    expect(res.status).toBe(200);
    expect(beforeSendOTP).not.toHaveBeenCalled();
  });

  // The localhost guard runs first, so a request from elsewhere never
  // reaches the consumer's per-number check.
  it('is not reached by a request test mode refuses', async () => {
    const beforeSendOTP = mock(() => {});
    const auth = createAuth(
      buildEnv({ AUTH_BASE_URL: 'http://localhost:8787', AUTH_KV: new FakeKV().asBinding() }),
      {
        phone: { sendOTP: () => {}, beforeSendOTP },
        google: true,
        testMode: { google: true },
      }
    );

    const res = await auth.handler(
      postJSON('https://evil.example.com/api/auth/phone-number/send-otp', { phoneNumber: PHONE })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TEST_MODE_LOCALHOST_ONLY' });
    expect(beforeSendOTP).not.toHaveBeenCalled();
  });

  // Only Better Auth's limiter's 429s gain RATE_LIMITED; a consumer's own
  // 429 without a code is theirs.
  it('passes a codeless 429 APIError through without adding RATE_LIMITED', async () => {
    const { APIError } = await import('better-auth/api');
    const auth = awaitedAuth(recordingSendOTP().sendOTP, {
      beforeSendOTP: () => {
        throw new APIError('TOO_MANY_REQUESTS', { message: 'Slow down' });
      },
    });

    const res = await sendOtp(auth);

    expect(res.status).toBe(429);
    expect(await res.json()).not.toHaveProperty('code');
  });

  it('works without awaitDelivery too', async () => {
    const auth = createAuth(buildEnv({ AUTH_KV: new FakeKV().asBinding() }), {
      phone: {
        sendOTP: () => {},
        beforeSendOTP: () => {
          throw new OTPDeliveryError('OTP_RESEND_LIMITED', { retryAfter: 60 });
        },
      },
    });

    const res = await sendOtp(auth);

    expect(res.status).toBe(429);
  });

  it('is not passed on to Better Auth as a plugin option', () => {
    const auth = awaitedAuth(recordingSendOTP().sendOTP, { beforeSendOTP: () => {} });
    const plugin = auth.options.plugins?.find((p) => p.id === 'phone-number');

    expect(plugin?.options).not.toHaveProperty('beforeSendOTP');
  });
});

describe('without awaitDelivery', () => {
  it('still answers 200 when delivery fails, as before', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      const { sendOTP } = recordingSendOTP(() => {
        throw new OTPDeliveryError('RATE_LIMITED', { retryAfter: 60 });
      });
      const { ctx, promises } = createMockExecutionContext();
      const auth = createAuth(buildEnv(), { phone: { sendOTP } });

      const res = await auth.handler(
        postJSON(`${API}/phone-number/send-otp`, { phoneNumber: PHONE }),
        ctx
      );
      await Promise.allSettled(promises);

      expect(res.status).toBe(200);
    } finally {
      console.error = originalError;
    }
  });
});

// The supported way to send codes in the user's language: the client sets a
// header on its sendOtp call, and sendOTP reads it from the request.
describe('locale for sendOTP', () => {
  it('hands sendOTP the original request, headers included', async () => {
    const send = mock((_args: { code: string }, _request?: Request) => {});
    const auth = createAuth(buildEnv({ AUTH_KV: new FakeKV().asBinding() }), {
      phone: { sendOTP: send, awaitDelivery: true },
    });

    await auth.handler(
      new Request(`${API}/phone-number/send-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-locale': 'si' },
        body: JSON.stringify({ phoneNumber: PHONE }),
      })
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]?.headers.get('x-locale')).toBe('si');
  });
});
