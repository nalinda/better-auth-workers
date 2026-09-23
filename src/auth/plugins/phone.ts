import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { createSessionStore, expireCookie } from 'better-auth/cookies';
import type { PhoneNumberOptions } from 'better-auth/plugins';
import { phoneNumber } from 'better-auth/plugins';

import type { ContextRef } from '../../shared/non-blocking';
import {
  OTP_DELIVERY_FAILED,
  OTPDeliveryError,
  type OTPDeliveryErrorStatus,
} from '../otp-delivery-error';
import type { CreateAuthPhoneOptions } from '../types';
import { deliverNonBlocking, redactSecrets } from './delivery';

type SendOTP = NonNullable<PhoneNumberOptions['sendOTP']>;
type AfterHooks = Pick<NonNullable<BetterAuthPlugin['hooks']>, 'after'>;
type SendOTPData = Parameters<SendOTP>[0];
type SendOTPContext = Parameters<SendOTP>[1];

const STATUS_NAMES = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  429: 'TOO_MANY_REQUESTS',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
} as const satisfies Record<OTPDeliveryErrorStatus, string>;

// `instanceof` alone would miss an OTPDeliveryError from a second copy of
// the package in the consumer's tree.
function isOTPDeliveryError(error: unknown): error is OTPDeliveryError {
  return (
    error instanceof OTPDeliveryError ||
    (error instanceof Error &&
      error.name === 'OTPDeliveryError' &&
      typeof (error as Partial<OTPDeliveryError>).code === 'string')
  );
}

// Whole seconds, or nothing: a NaN or negative value (a parsed HTTP-date
// `Retry-After`, say) would otherwise reach the client as `Retry-After: NaN`.
function retryAfterSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : undefined;
}

// Checked at runtime too: an OTPDeliveryError from JavaScript or another
// copy of the package can carry any status.
function statusName(status: unknown): (typeof STATUS_NAMES)[OTPDeliveryErrorStatus] {
  return Object.hasOwn(STATUS_NAMES, String(status))
    ? STATUS_NAMES[status as OTPDeliveryErrorStatus]
    : 'BAD_GATEWAY';
}

function deliveryFailure(error: unknown): APIError {
  if (isOTPDeliveryError(error)) {
    const retryAfter = retryAfterSeconds(error.retryAfter);
    return new APIError(
      statusName(error.status),
      { code: error.code, message: error.message, ...(retryAfter !== undefined && { retryAfter }) },
      retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) }
    );
  }
  return new APIError('BAD_GATEWAY', {
    code: OTP_DELIVERY_FAILED,
    message: 'The code could not be delivered',
  });
}

// An Error, a string or any other object is handed to redactSecrets as is
// (it serialises objects before redacting); only primitives are stringified.
function logRedacted(error: unknown, code: string): void {
  const loggable = typeof error === 'object' && error !== null ? error : String(error);
  console.error(redactSecrets(loggable, [code]));
}

// `awaitDelivery`: the response waits for `sendOTP`, and a failure becomes
// the response. Better Auth stored the code as a new verification row before
// `sendOTP` ran; it was never delivered, so that row is deleted rather than
// left to be guessed. Only that row, by id: a newer row from a racing resend
// is on its way to the user, and an older row from an earlier send (the
// user's previous, still valid code) becomes the current one again. The
// delete is best-effort, so a database error can't replace the delivery
// error the client needs. A refusal the consumer raised on purpose
// (OTPDeliveryError) is not logged; anything else is, with the code redacted.
async function deleteUndeliveredCode(ctx: SendOTPContext, data: SendOTPData): Promise<void> {
  if (!ctx) return;
  // The newest row for the number; the stored value is `<code>:<attempts>`.
  const stored = await ctx.context.internalAdapter.findVerificationValue(data.phoneNumber);
  if (!stored?.value.startsWith(`${data.code}:`)) return;
  await ctx.context.adapter.delete({
    model: 'verification',
    where: [{ field: 'id', value: stored.id }],
  });
}

async function deliverAwaited(
  send: () => Promise<void> | void,
  data: SendOTPData,
  ctx: SendOTPContext
): Promise<void> {
  try {
    await send();
  } catch (error) {
    try {
      await deleteUndeliveredCode(ctx, data);
    } catch (cleanupError) {
      logRedacted(cleanupError, data.code);
    }
    if (!isOTPDeliveryError(error)) logRedacted(error, data.code);
    throw deliveryFailure(error);
  }
}

interface HookMatchContext {
  path?: string;
  body?: unknown;
}

// `beforeSendOTP` runs as a before hook on `/phone-number/send-otp`, ahead
// of the code being created, so a refusal leaves the number's earlier code
// (if any) in place and still valid. It only sees numbers the endpoint would
// accept: anything else is left for the endpoint to refuse with
// INVALID_PHONE_NUMBER, so a per-number limit is never keyed on junk. An
// APIError it throws is the consumer's own response and passes through.
function beforeSendOTPHook(beforeSendOTP: NonNullable<CreateAuthPhoneOptions['beforeSendOTP']>) {
  return {
    matcher: (ctx: HookMatchContext) => ctx.path === '/phone-number/send-otp',
    handler: createAuthMiddleware(async (ctx) => {
      const phoneNumber = (ctx.body as { phoneNumber?: unknown } | undefined)?.phoneNumber;
      if (typeof phoneNumber !== 'string' || !isValidE164(phoneNumber)) return;
      try {
        await beforeSendOTP({ phoneNumber }, ctx.request);
      } catch (error) {
        if (isAPIError(error)) throw error;
        if (!isOTPDeliveryError(error)) console.error(error);
        throw deliveryFailure(error);
      }
    }),
  };
}

// A signed-in user who changes their number through `verify` with
// `updatePhoneNumber` gets a new `phoneNumber` / `phoneNumberVerified`, but
// Better Auth leaves the session's cookie cache as it was, so `get-session`
// would go on returning the old user until the cache expires. Expiring it
// (and any chunks a large cache was split into, as sign-out does) makes the
// next `get-session` read the updated session. Only this browser's cookies
// can be reached; the session client's KV entries for every session of the
// user are evicted in session-invalidation.ts.
const expireCookieCacheAfterNumberChange = {
  matcher: (ctx: HookMatchContext) =>
    ctx.path === '/phone-number/verify' &&
    (ctx.body as { updatePhoneNumber?: unknown } | undefined)?.updatePhoneNumber === true,
  handler: createAuthMiddleware((ctx) => {
    if (!isAPIError(ctx.context.returned)) {
      const { sessionData } = ctx.context.authCookies;
      expireCookie(ctx, sessionData);
      const chunks = createSessionStore(sessionData.name, sessionData.attributes, ctx);
      chunks.setCookies(chunks.clean());
    }
    return Promise.resolve();
  }),
};

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

// Phone OTP is a sign-in method here, not just a verification step, so a
// first verify for an unknown number must create the user. Better Auth
// requires an email on every user; `.invalid` is the RFC 2606 reserved TLD,
// so the placeholder can never be delivered to or collide with a real one.
const SIGN_UP_ON_VERIFICATION = {
  getTempEmail: (phoneNumber: string) => `${phoneNumber}@phone.invalid`,
  getTempName: (phoneNumber: string) => phoneNumber,
};

// A key the consumer set to `undefined` (`signUpOnVerification: undefined`,
// say) must fall back to the package default like an omitted key, not
// clobber it — for sign-up that would silently disable user creation on
// first verify and surface only as "user not found".
function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined)
  ) as Partial<T>;
}

function isValidE164(phoneNumber: string): boolean {
  return E164_REGEX.test(phoneNumber);
}

// Test mode: every verification accepts the fixed code, and no code is sent
// at all. The attempt limit and expiry do not apply, since no stored code is
// checked. That requests arrive on localhost is enforced for every route by
// the test-mode plugin (see test-mode.ts).
function testModeOTP(otpCode: string): Pick<PhoneNumberOptions, 'sendOTP' | 'verifyOTP'> {
  return {
    sendOTP: () => {},
    verifyOTP: ({ code }) => code === otpCode,
  };
}

export function buildPhonePlugin(
  phoneOpts: CreateAuthPhoneOptions | undefined,
  ctxRef: ContextRef,
  testModeOtpCode?: string
) {
  if (!phoneOpts) return;
  // `awaitDelivery` and `beforeSendOTP` are this package's, not the plugin's.
  const { awaitDelivery, beforeSendOTP, ...pluginOpts } = phoneOpts;
  const phonePluginOptions: PhoneNumberOptions = {
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 3,
    phoneNumberValidator: isValidE164,
    signUpOnVerification: SIGN_UP_ON_VERIFICATION,
    ...withoutUndefined(pluginOpts),
    sendOTP: (data, ctx) => {
      const req = ctx?.request;
      const send = () => phoneOpts.sendOTP(data, req);
      if (awaitDelivery) return deliverAwaited(send, data, ctx);
      deliverNonBlocking(send, req, ctxRef, [data.code]);
    },
    ...(testModeOtpCode !== undefined && testModeOTP(testModeOtpCode)),
  };
  const plugin = phoneNumber(phonePluginOptions);
  return {
    ...plugin,
    hooks: {
      ...plugin.hooks,
      before: [
        ...plugin.hooks.before,
        // Test mode sends nothing, so there is nothing for a per-number
        // limit to hold back, and its check may call a service that isn't
        // there locally.
        ...(beforeSendOTP && testModeOtpCode === undefined
          ? [beforeSendOTPHook(beforeSendOTP)]
          : []),
      ],
      // The phone plugin declares no after hooks today; any it gains are kept.
      after: [...((plugin.hooks as AfterHooks).after ?? []), expireCookieCacheAfterNumberChange],
    },
  };
}
