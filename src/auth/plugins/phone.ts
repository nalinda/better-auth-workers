import type { PhoneNumberOptions } from 'better-auth/plugins';
import { phoneNumber } from 'better-auth/plugins';

import { getExecutionContext, runNonBlocking } from '../../shared/non-blocking';
import type { ExecutionContext } from '../../types';
import type { CreateAuthPhoneOptions } from '../options';

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

function isValidE164(phoneNumber: string): boolean {
  return E164_REGEX.test(phoneNumber);
}

export function buildPhonePlugin(
  phoneOpts?: CreateAuthPhoneOptions,
  optionsCtx?: ExecutionContext
) {
  if (!phoneOpts) return;
  const phonePluginOptions: PhoneNumberOptions = {
    otpLength: 6,
    expiresIn: 300,
    allowedAttempts: 3,
    phoneNumberValidator: isValidE164,
    ...phoneOpts,
    sendOTP: (data, ctx) => {
      if (!isValidE164(data.phoneNumber)) {
        return;
      }
      const req = ctx?.request;
      const execCtx = getExecutionContext(req, optionsCtx);
      runNonBlocking(
        async () => {
          await phoneOpts.sendOTP(data, req);
        },
        execCtx,
        (error) => {
          if (error instanceof Error) {
            if (data.code && error.message.includes(data.code)) {
              console.error(new Error(error.message.replaceAll(data.code, '[REDACTED]')));
              return;
            }
            console.error(error);
            return;
          }
          if (typeof error === 'string') {
            console.error(data.code ? error.replaceAll(data.code, '[REDACTED]') : error);
            return;
          }
          console.error(error);
        }
      );
    },
  };
  return phoneNumber(phonePluginOptions);
}
