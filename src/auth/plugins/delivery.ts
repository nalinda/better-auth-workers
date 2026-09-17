import { type ContextRef, getExecutionContext, runNonBlocking } from '../../shared/non-blocking';

// Runs a consumer's delivery callback (sendOTP, sendMagicLink) off the
// response path, on the request's ExecutionContext, and reports a failure
// to the Worker's logs with the secret it was delivering redacted: an SMS
// or email gateway error routinely echoes the request body, and the OTP
// code or magic-link token must not end up in the logs that way.
export function deliverNonBlocking(
  send: () => Promise<void> | void,
  request: Request | undefined,
  ctxRef: ContextRef,
  secrets: string[]
): void {
  runNonBlocking(send, getExecutionContext(request, ctxRef.current), (error) => {
    console.error(redactSecrets(error, secrets));
  });
}

function redact(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

// Errors and strings are redacted; any other thrown value is logged as is,
// the same way the phone path always handled it.
function redactSecrets(error: Error | string | object, secrets: string[]): unknown {
  if (error instanceof Error) {
    const message = redact(error.message, secrets);
    return message === error.message ? error : new Error(message);
  }
  if (typeof error === 'string') return redact(error, secrets);
  return error;
}
