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

function isValidE164(phoneNumber: string): boolean {
  return E164_REGEX.test(phoneNumber);
}

export function buildPhonePlugin(
  phoneOpts: CreateAuthPhoneOptions | undefined,
  ctxRef: ContextRef
) {
  if (!phoneOpts) return;
  const phonePluginOptions: PhoneNumberOptions = {
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 3,
    phoneNumberValidator: isValidE164,
    signUpOnVerification: SIGN_UP_ON_VERIFICATION,
    ...phoneOpts,
    sendOTP: (data, ctx) => {
      if (!isValidE164(data.phoneNumber)) {
        return;
      }
      const req = ctx?.request;
      deliverNonBlocking(() => phoneOpts.sendOTP(data, req), req, ctxRef, [data.code]);
    },
  };
  return phoneNumber(phonePluginOptions);
}
