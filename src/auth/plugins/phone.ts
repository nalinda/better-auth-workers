import type { PhoneNumberOptions } from 'better-auth/plugins';
import { phoneNumber } from 'better-auth/plugins';

import type { CreateAuthPhoneOptions } from '../options';

export function buildPhonePlugin(phoneOpts?: CreateAuthPhoneOptions) {
  if (!phoneOpts) return;
  const phonePluginOptions: PhoneNumberOptions = {
    ...phoneOpts,
    sendOTP: async (data, ctx) => {
      const req = ctx?.request;
      await phoneOpts.sendOTP(data, req);
    },
  };
  return phoneNumber(phonePluginOptions);
}
