import type { ExecutionContext } from '../types';

// The fallback ExecutionContext for an instance (`options.ctx`). It is a
// mutable holder rather than a captured value because the D1 path memoises
// the instance: every later `createAuth` call refreshes `current`, so the
// fallback tracks the latest request instead of the one that built the
// instance. The context passed to `auth.handler(request, ctx)` always wins.
export interface ContextRef {
  current?: ExecutionContext;
  // Set once the missing-context warning has been logged for this instance.
  hasWarnedMissingContext?: boolean;
}

const MISSING_CONTEXT_WARNING =
  'better-auth-workers: delivery (sendOTP / sendMagicLink) was scheduled without an ExecutionContext. Pass the request context as auth.handler(request, ctx) — without it the Workers runtime may cancel delivery once the response is sent, while the response still reports success.';

// A delivery with no context is a misconfiguration, not a quiet fallback:
// the promise is detached and may be cancelled after the response. Logged
// once per instance so a busy Worker is not flooded.
export function warnMissingContext(ctxRef: ContextRef): void {
  if (ctxRef.hasWarnedMissingContext) return;
  ctxRef.hasWarnedMissingContext = true;
  console.warn(MISSING_CONTEXT_WARNING);
}

const requestContextMap = new WeakMap<Request, ExecutionContext>();

function setRequestContext(request: Request, ctx: ExecutionContext): void {
  requestContextMap.set(request, ctx);
}

export function getExecutionContext(
  request?: Request,
  fallback?: ExecutionContext
): ExecutionContext | undefined {
  if (request) {
    const ctx = requestContextMap.get(request);
    if (ctx) return ctx;
  }
  return fallback;
}

export function runNonBlocking(
  task: () => Promise<void> | void,
  ctx?: ExecutionContext,
  onError?: (error: Error | string | object) => void
): void {
  const promise = (async () => {
    try {
      await task();
    } catch (error) {
      if (onError) {
        onError(error as Error | string | object);
      } else {
        console.error(error);
      }
    }
  })();

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
  }
}

interface HandlerHost {
  handler: (request: Request, ctx?: ExecutionContext) => Promise<Response>;
}

// Records the per-request ExecutionContext against the Request so plugin
// callbacks (sendOTP, sendMagicLink) can schedule work on the context of
// the request they are serving.
export function withHandlerContext(instance: HandlerHost, ctxRef: ContextRef): void {
  const originalHandler = instance.handler.bind(instance);
  instance.handler = async (request: Request, ctx?: ExecutionContext) => {
    const activeCtx = ctx ?? ctxRef.current;
    if (activeCtx) {
      setRequestContext(request, activeCtx);
    }
    return originalHandler(request);
  };
}
