import { verifyIdToken } from "@/lib/firebase/admin";

/**
 * Verify the caller's Firebase ID token AND that they hold the admin claim.
 * Returns the decoded uid on success, or a Response to short-circuit the
 * handler (401/403) on failure. Defence in depth — every admin route calls
 * this, never trusting a client-side guard alone.
 *
 * Reads the token from the JSON body (`{ idToken }`) or an
 * `Authorization: Bearer <token>` header.
 */
export async function requireAdmin(
  request: Request,
): Promise<{ uid: string } | Response> {
  let idToken: string | undefined;
  try {
    const body = (await request.clone().json()) as { idToken?: string };
    idToken = body.idToken;
  } catch {
    idToken = undefined;
  }
  if (!idToken) {
    const authz = request.headers.get("authorization");
    if (authz?.startsWith("Bearer ")) idToken = authz.slice(7);
  }
  if (!idToken) {
    return new Response(JSON.stringify({ error: "Missing token" }), { status: 401 });
  }
  try {
    const decoded = await verifyIdToken(idToken);
    if (decoded.claims.admin !== true) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
    }
    return { uid: decoded.uid };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
  }
}
