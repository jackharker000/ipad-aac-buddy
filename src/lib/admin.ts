import { getIdToken } from "@/lib/auth";

/**
 * Admin data helpers — Firebase-backed, cross-device.
 *
 * Accounts live in Firebase Auth (not on-device any more), so the admin
 * dashboard sees *every* Parley account regardless of which device created it.
 * Data comes from two keyed server routes that hold the Firebase Admin SDK and
 * verify the caller carries the `admin` custom claim:
 *
 *   POST /api/admin/users → { users: AdminUserRecord[] }   (all users, newest first)
 *   POST /api/admin/user  → { user: AdminUserRecord }       (one user by uid)
 *
 * These are plain client fetch helpers. Firebase auth state only exists in the
 * browser, so they must be called from components (useEffect), never from
 * route loaders (which run during SSR where there is no signed-in user).
 */

export type AdminUserRecord = {
  uid: string;
  email: string | null;
  displayName: string | null;
  is_admin: boolean;
  disabled: boolean;
  createdAt: string | null; // ISO string (Firebase metadata.creationTime)
  lastSignInAt: string | null; // ISO string
  provider: string | null; // e.g. "password"
};

/** Error from an /api/admin/* call, carrying the HTTP status for the pages. */
export class AdminApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

const SERVICE_ACCOUNT_MISSING =
  "Admin features need the Firebase service account configured on the server. See docs/setup.md.";

async function authedFetch(
  path: string,
  extraBody: Record<string, unknown> = {},
): Promise<Response> {
  const token = await getIdToken();
  if (!token) throw new AdminApiError(401, "Not signed in.");
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: token, ...extraBody }),
  });
}

async function parseError(res: Response): Promise<never> {
  if (res.status === 503) {
    throw new AdminApiError(503, SERVICE_ACCOUNT_MISSING);
  }
  let message = "Request failed";
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // non-JSON body — keep the generic message
  }
  throw new AdminApiError(res.status, message);
}

/** Fetch every Parley account (newest first). Throws AdminApiError on failure. */
export async function fetchUsers(): Promise<AdminUserRecord[]> {
  const res = await authedFetch("/api/admin/users");
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { users: AdminUserRecord[] };
  return body.users;
}

/** Fetch a single account by uid. Returns null if it doesn't exist (404). */
export async function fetchUser(uid: string): Promise<AdminUserRecord | null> {
  const res = await authedFetch("/api/admin/user", { uid });
  if (res.status === 404) return null;
  if (!res.ok) return parseError(res);
  const body = (await res.json()) as { user: AdminUserRecord };
  return body.user;
}
