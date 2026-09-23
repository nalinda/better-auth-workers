import {
  type ContextRef,
  getExecutionContext,
  runNonBlocking,
  warnMissingContext,
} from '../../shared/non-blocking';

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
  const ctx = getExecutionContext(request, ctxRef.current);
  if (!ctx) warnMissingContext(ctxRef);
  runNonBlocking(send, ctx, (error) => {
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

// Any rejection value is redacted: an Error by its message, a string as
// is, and anything else (an SDK rejecting with a parsed error response, a
// plain object echoing the request body) by serialising it first, so the
// logged form can never carry the code or link.
export function redactSecrets(error: Error | string | object, secrets: string[]): unknown {
  if (error instanceof Error) {
    const message = redact(error.message, secrets);
    if (message === error.message) return error;
    // Only the message is redacted; the stack and cause stay, since they
    // are what makes a real delivery failure debuggable.
    const redactedError = new Error(message, { cause: error.cause });
    // Carried over onto the error we construct (not mutating a caught one):
    // the original name and the redacted stack.
    Object.defineProperties(redactedError, {
      name: { value: error.name, configurable: true, writable: true },
      ...(error.stack && {
        stack: { value: redact(error.stack, secrets), configurable: true, writable: true },
      }),
    });
    return redactedError;
  }
  if (typeof error === 'string') return redact(error, secrets);
  let serialised: string;
  try {
    serialised = JSON.stringify(error);
  } catch {
    serialised = '[unserialisable delivery error]';
  }
  return redact(serialised, secrets);
}
