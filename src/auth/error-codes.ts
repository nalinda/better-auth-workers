import type { HandlerHost } from '../shared/handler-host';
import type { WaitUntilContext } from '../types';
import type { CreateAuthOptions } from './types';

const RATE_LIMITED = 'RATE_LIMITED';
const INTERNAL_ERROR = 'INTERNAL_ERROR';

// Every error the auth Worker answers carries a stable `code` for the UI to
// translate, and two kinds of Better Auth response don't, so they gain one
// here; everything else passes through untouched.

// The rate limiter answers 429 with only a `message` (and an `X-Retry-After`
// header). Only the limiter's own 429s are touched, told apart by that
// header; a 429 that already has a code (an OTPDeliveryError's) or one a
// consumer raised passes through.
async function withRateLimitCode(response: Response): Promise<Response> {
  if (response.status !== 429 || !response.headers.has('x-retry-after')) return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (typeof body !== 'object' || body === null || 'code' in body) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return Response.json(
    { code: RATE_LIMITED, ...body },
    { status: 429, statusText: response.statusText, headers }
  );
}

// An unexpected failure (a database or KV error Better Auth didn't catch)
// answers 500 with an empty body, which a UI calling `res.json()` can't
// parse, or escapes the handler altogether (a KV error in the rate limiter
// throws before any endpoint runs). Both become a JSON 500 with
// `code: 'INTERNAL_ERROR'`. A 5xx with a body of its own (Better Auth's
// FAILED_TO_* codes, an OTPDeliveryError's 502) is left as it is.
function internalError(status = 500, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return Response.json(
    { code: INTERNAL_ERROR, message: 'Internal error' },
    { status, statusText: init.statusText, headers }
  );
}

async function withInternalErrorCode(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const text = await response.clone().text();
  if (text.length > 0) return response;
  return internalError(response.status, response);
}

// A consumer who set `betterAuth.onAPIError.throw` wants unexpected errors
// thrown to their own handling (an error tracker, say), so those still are.
export function withErrorCodes(instance: HandlerHost, options?: CreateAuthOptions): void {
  const originalHandler = instance.handler.bind(instance);
  const shouldRethrow = options?.betterAuth?.onAPIError?.throw === true;
  instance.handler = async (request: Request, ctx?: WaitUntilContext) => {
    let response: Response;
    try {
      response = await originalHandler(request, ctx);
    } catch (error) {
      if (shouldRethrow) throw error;
      console.error('better-auth-workers: unhandled error in the auth handler', error);
      return internalError();
    }
    return withInternalErrorCode(await withRateLimitCode(response));
  };
}
