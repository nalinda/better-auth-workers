import type { ExecutionContext } from '../types';

const requestContextMap = new WeakMap<Request, ExecutionContext>();

function setRequestContext(request: Request, ctx: ExecutionContext): void {
  requestContextMap.set(request, ctx);
}

export function getExecutionContext(
  request?: Request,
  optionsCtx?: ExecutionContext
): ExecutionContext | undefined {
  if (request) {
    const ctx = requestContextMap.get(request);
    if (ctx) return ctx;
  }
  return optionsCtx;
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

export function withHandlerContext(instance: HandlerHost, optionsCtx?: ExecutionContext): void {
  const originalHandler = instance.handler.bind(instance);
  instance.handler = async (request: Request, ctx?: ExecutionContext) => {
    const activeCtx = ctx ?? optionsCtx;
    if (activeCtx) {
      setRequestContext(request, activeCtx);
    }
    return originalHandler(request, ctx);
  };
}
