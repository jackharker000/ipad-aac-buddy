import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context for server functions. The auth middleware seeds this
 * with the authenticated user id (or null in local-first dev mode) and the
 * server-function name, so deep call sites like `chatCompletion` can attribute
 * usage without threading ids through every signature.
 */
export type RequestContext = {
  userId: string | null;
  /** Name of the server function handling this request, for usage logging. */
  fnName?: string;
};

const als = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

/** Tag the current request with the server-function name (for usage logs). */
export function setRequestFnName(name: string) {
  const ctx = als.getStore();
  if (ctx) ctx.fnName = name;
}
