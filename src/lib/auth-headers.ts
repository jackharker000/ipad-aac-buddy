import { getIdToken } from "@/lib/auth";

/**
 * Returns auth headers to attach to /api/* fetches so the server can identify
 * the calling user for usage metering. Empty object when the user isn't
 * signed in (anonymous calls still work).
 */
export async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getIdToken();
    if (!token) return {};
    return { authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}
