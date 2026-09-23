import type { PhoneNumberOptions } from 'better-auth/plugins';
import { phoneNumber } from 'better-auth/plugins';

import type { ContextRef } from '../../shared/non-blocking';
import type { CreateAuthPhoneOptions } from '../types';
import { deliverNonBlocking } from './delivery';

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
  const phonePluginOptions: PhoneNumberOptions = {
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 3,
    phoneNumberValidator: isValidE164,
    signUpOnVerification: SIGN_UP_ON_VERIFICATION,
    ...withoutUndefined(phoneOpts),
    sendOTP: (data, ctx) => {
      const req = ctx?.request;
      deliverNonBlocking(() => phoneOpts.sendOTP(data, req), req, ctxRef, [data.code]);
    },
    ...(testModeOtpCode !== undefined && testModeOTP(testModeOtpCode)),
  };
  return phoneNumber(phonePluginOptions);
}
