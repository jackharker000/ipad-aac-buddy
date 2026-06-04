import crypto from "node:crypto";

/**
 * Server-side Firebase via REST — NOT the firebase-admin SDK.
 *
 * firebase-admin pulls in gRPC/google-gax, which use CommonJS `__dirname` and
 * load `.proto` files from disk paths; both break when the server is bundled
 * into ESM (Vite/Nitro). The REST APIs need only a service-account-signed
 * OAuth2 token + plain fetch, so they bundle cleanly and run anywhere.
 *
 * Credential: FIREBASE_SERVICE_ACCOUNT_B64 (base64 of the service-account
 * JSON). Server-only — never exposed to the client.
 */

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

export type AdminUserRecord = {
  uid: string;
  email: string | null;
  displayName: string | null;
  is_admin: boolean;
  disabled: boolean;
  createdAt: string | null; // ISO
  lastSignInAt: string | null; // ISO
  provider: string | null;
};

export function isAdminConfigured(): boolean {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_B64);
}

let cachedSA: ServiceAccount | null = null;
function serviceAccount(): ServiceAccount {
  if (cachedSA) return cachedSA;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_B64 on the server.");
  }
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64 JSON.");
  }
  parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  cachedSA = parsed;
  return parsed;
}

export function getProjectId(): string {
  return serviceAccount().project_id;
}

/**
 * Service-account credentials needed for signing Storage download URLs.
 * Exposed only to admin server routes — never reachable from client code.
 */
export function getServiceAccountCredentials(): { clientEmail: string; privateKey: string } {
  const sa = serviceAccount();
  return { clientEmail: sa.client_email, privateKey: sa.private_key };
}

/**
 * Default Firebase Storage bucket for this project. Matches the
 * `<projectId>.firebasestorage.app` host the Firebase web SDK uses.
 */
export function getStorageBucket(): string {
  return `${getProjectId()}.firebasestorage.app`;
}

// --------------------------------------------------------------------------
// OAuth2 access token (service-account JWT bearer grant), cached ~55 min
// --------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope:
        "https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = b64url(
    crypto.createSign("RSA-SHA256").update(signingInput).sign(sa.private_key),
  );
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: ${res.status}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

// --------------------------------------------------------------------------
// Verify a Firebase ID token (RS256 against Google's public x509 certs)
// --------------------------------------------------------------------------

const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
let certCache: { keys: Record<string, string>; expiresAt: number } | null = null;

async function googleCerts(): Promise<Record<string, string>> {
  if (certCache && certCache.expiresAt > Date.now()) return certCache.keys;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Google certs: ${res.status}`);
  const keys = (await res.json()) as Record<string, string>;
  const cc = res.headers.get("cache-control") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 3600);
  certCache = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

export type DecodedToken = { uid: string; claims: Record<string, unknown> };

export async function verifyIdToken(idToken: string): Promise<DecodedToken> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as {
    kid?: string;
    alg?: string;
  };
  const payload = JSON.parse(Buffer.from(p, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
  if (header.alg !== "RS256" || !header.kid) throw new Error("Bad token header");

  const certs = await googleCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error("Unknown signing key");

  const signature = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ok = crypto
    .createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(cert, signature);
  if (!ok) throw new Error("Invalid signature");

  const projectId = getProjectId();
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("Audience mismatch");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error("Issuer mismatch");
  }
  if (typeof payload.exp === "number" && payload.exp < nowSec) {
    throw new Error("Token expired");
  }
  const uid = (payload.sub ?? payload.user_id) as string | undefined;
  if (!uid) throw new Error("No subject");

  return { uid, claims: payload };
}

// --------------------------------------------------------------------------
// Identity Toolkit (admin user operations)
// --------------------------------------------------------------------------

function idToolkitBase(): string {
  return `https://identitytoolkit.googleapis.com/v1/projects/${getProjectId()}`;
}

type RestUser = {
  localId: string;
  email?: string;
  displayName?: string;
  disabled?: boolean;
  createdAt?: string; // ms epoch as string
  lastLoginAt?: string; // ms epoch as string
  customAttributes?: string; // JSON string
  providerUserInfo?: Array<{ providerId: string }>;
};

function mapUser(u: RestUser): AdminUserRecord {
  let isAdmin = false;
  if (u.customAttributes) {
    try {
      isAdmin = (JSON.parse(u.customAttributes) as { admin?: boolean }).admin === true;
    } catch {
      isAdmin = false;
    }
  }
  const toIso = (ms?: string): string | null => {
    if (!ms) return null;
    const n = Number(ms);
    return Number.isFinite(n) ? new Date(n).toISOString() : null;
  };
  return {
    uid: u.localId,
    email: u.email ?? null,
    displayName: u.displayName ?? null,
    is_admin: isAdmin,
    disabled: Boolean(u.disabled),
    createdAt: toIso(u.createdAt),
    lastSignInAt: toIso(u.lastLoginAt),
    provider: u.providerUserInfo?.[0]?.providerId ?? "password",
  };
}

async function authedFetch(url: string, body: unknown): Promise<Response> {
  const token = await getAccessToken();
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** True if the project has at most `n` accounts (used for first-user bootstrap). */
export async function countUsersAtMost(n: number): Promise<number> {
  const res = await authedFetch(`${idToolkitBase()}/accounts:query`, {
    returnUserInfo: false,
  });
  if (!res.ok) throw new Error(`accounts:query failed: ${res.status}`);
  const data = (await res.json()) as { recordsCount?: string };
  const count = Number(data.recordsCount ?? "0");
  return Number.isFinite(count) ? Math.min(count, n + 1) : 0;
}

export async function setAdminClaim(uid: string): Promise<void> {
  const res = await authedFetch(`${idToolkitBase()}/accounts:update`, {
    localId: uid,
    customAttributes: JSON.stringify({ admin: true }),
  });
  if (!res.ok) throw new Error(`accounts:update failed: ${res.status}`);
}

export async function listAllUsers(): Promise<AdminUserRecord[]> {
  const res = await authedFetch(`${idToolkitBase()}/accounts:batchGet?maxResults=1000`, {});
  // accounts:batchGet is actually a GET; fall back if needed.
  let data: { users?: RestUser[] };
  if (res.ok) {
    data = (await res.json()) as { users?: RestUser[] };
  } else {
    const getRes = await fetch(`${idToolkitBase()}/accounts:batchGet?maxResults=1000`, {
      headers: { authorization: `Bearer ${await getAccessToken()}` },
    });
    if (!getRes.ok) throw new Error(`accounts:batchGet failed: ${getRes.status}`);
    data = (await getRes.json()) as { users?: RestUser[] };
  }
  const users = (data.users ?? []).map(mapUser);
  users.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return users;
}

export async function getUserByUid(uid: string): Promise<AdminUserRecord | null> {
  const res = await authedFetch(`${idToolkitBase()}/accounts:lookup`, {
    localId: [uid],
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { users?: RestUser[] };
  const user = data.users?.[0];
  return user ? mapUser(user) : null;
}

// --------------------------------------------------------------------------
// Firestore (REST) — waitlist
// --------------------------------------------------------------------------

export async function addWaitlistEntry(entry: {
  name: string;
  email: string;
  about: string;
}): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default)/documents/waitlist`;
  const res = await authedFetch(url, {
    fields: {
      name: { stringValue: entry.name },
      email: { stringValue: entry.email },
      about: { stringValue: entry.about },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  });
  if (!res.ok) {
    throw new Error(`Firestore write failed: ${res.status}`);
  }
}
