// Thrown by a consumer's `sendOTP` (with `phone.awaitDelivery`) to refuse a
// code with a code of its own, such as a per-number limit enforced by the
// messaging service. The client gets `{ code, message, retryAfter? }` with
// this status, and a `Retry-After` header when `retryAfter` is set.
export type OTPDeliveryErrorStatus = 400 | 403 | 429 | 502 | 503;

export interface OTPDeliveryErrorOptions {
  message?: string;
  // Seconds until the caller may ask again.
  retryAfter?: number;
  // Defaults to 429 when `retryAfter` is set, otherwise 502.
  status?: OTPDeliveryErrorStatus;
}

export class OTPDeliveryError extends Error {
  readonly code: string;
  readonly retryAfter: number | undefined;
  readonly status: OTPDeliveryErrorStatus;

  constructor(code: string, options: OTPDeliveryErrorOptions = {}) {
    super(options.message ?? code);
    this.name = 'OTPDeliveryError';
    this.code = code;
    this.retryAfter = options.retryAfter;
    this.status = options.status ?? (options.retryAfter === undefined ? 502 : 429);
  }
}

// Any other failure of an awaited `sendOTP`.
export const OTP_DELIVERY_FAILED = 'OTP_DELIVERY_FAILED';
