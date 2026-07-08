import { createMiddleware } from "@tanstack/react-start";
import { auth } from "./client";

/**
 * Attaches the signed-in user's Firebase ID token as `Authorization: Bearer …`
 * to every server-function RPC issued from the browser. Must be registered as a
 * global `functionMiddleware` in `src/start.ts`; otherwise the server-side auth
 * guards (`requireUserOrLocal` / `requireAdmin`) reject every signed-in user.
 *
 * `authStateReady()` makes sure Firebase has finished restoring the persisted
 * session before we read `currentUser`, so early RPCs on a fresh page load
 * still carry a token instead of racing the auth restore.
 */
export const attachFirebaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    let token: string | undefined;
    try {
      await auth.authStateReady();
      token = await auth.currentUser?.getIdToken();
    } catch {
      token = undefined;
    }
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
