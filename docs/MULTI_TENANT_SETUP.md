# Parley multi-tenant setup

Parley is a login-gated, multi-tenant product. Every user signs in, every
user's data is isolated (Firestore security rules server-side + per-user Dexie
snapshots client-side), every external API call is usage/cost-logged, and
admins get a metrics-only dashboard at `/admin`. The backend is **Firebase**
(Firebase Auth + Cloud Firestore).

## 1. Firebase project

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Authentication → Sign-in method:** enable **Email/Password** and **Google**.
3. **Firestore Database:** create a database (production mode).
4. **Add a Web App** (Project settings → Your apps → Web) to get the client
   config values (`apiKey`, `authDomain`, `projectId`, …).
5. **Service account** (Project settings → Service accounts → Generate new
   private key) for the server. Base64-encode the JSON for the env var:
   ```sh
   base64 -i serviceAccount.json | tr -d '\n'
   ```
6. **Deploy the security rules + indexes** (from the repo root, with the
   Firebase CLI logged in and the project selected):
   ```sh
   firebase deploy --only firestore:rules,firestore:indexes
   ```
   `firebase.json` points at `firestore.rules` and `firestore.indexes.json`.

### Firestore data model

| Collection      | Doc id     | Fields                                                                                                                    | Who can read                                                                              |
| --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `profiles`      | `{uid}`    | `email`, `displayName`, `role` (`user`\|`admin`), `createdAt`, `lastActiveAt`                                             | the user; admins                                                                          |
| `user_backups`  | `{uid}`    | `data` (E2E-encrypted snapshot), `updatedAt`                                                                              | **the user only — admins deliberately have NO access** (AAC transcripts are sensitive)    |
| `usage_log`     | auto-id    | `userId`, `fn`, `provider`, `model`, `inputTokens`, `outputTokens`, `characters`, `estCostUsd`, `latencyMs`, `ok`, `error`, `createdAt` | the user (own rows); admins (all) — but **never writable from the client** |

Rules highlights (`firestore.rules`):

- **Per-user isolation** — every read/write is gated on `request.auth.uid`.
- **Roles cannot be self-escalated** — the client can create/update only its
  own `profiles` doc and can NEVER set or change `role`. Role changes happen
  exclusively via the Admin SDK (`adminSetRole`), which bypasses rules and also
  sets a Firebase **custom claim** `admin: true`.
- **Admin-ness in rules is the `admin` custom claim** (`request.auth.token.admin
  == true`) — no extra document read to authorize an admin.
- **`user_backups` has no admin access.** The admin server functions also never
  read it in code, so the admin surface has zero backup visibility.
- **`usage_log` is server-write-only** (Admin SDK); clients can only read their
  own rows.

## 2. Environment variables (Vercel → Settings → Environment Variables)

```
# Public Firebase web app config (client bundle — safe to expose):
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_MEASUREMENT_ID=

# Server only — base64 of the service account JSON. Powers token verification,
# usage logging, and admin queries. Bypasses rules; never expose to the client:
FIREBASE_SERVICE_ACCOUNT_B64=

PARLEY_ADMIN_EMAILS=you@example.com   # bootstrap admin(s), comma-separated
```

Behavior matrix:

- **All set (production):** sign-in required for every visitor; all server
  functions reject anonymous calls (401); usage logging active.
- **Unset, dev build:** local-first anonymous mode (engine hacking, offline).
- **Unset, production build:** a "deployment not configured" notice — a
  public multi-user deploy is never silently unauthenticated. (The auth guard
  additionally fails closed with a 500 in production if
  `FIREBASE_SERVICE_ACCOUNT_B64` is missing.)

## 3. First admin (bootstrap)

There is no signup trigger in Firestore, so a user's `profiles/{uid}` doc is
auto-created on their first authenticated server call (`whoami`).

1. Add your email to `PARLEY_ADMIN_EMAILS` and verify it (the allow-list path
   requires a **verified** email).
2. Sign up / sign in normally, open `/admin`.
3. Promote yourself durably via the role toggle in the users table. That writes
   `profiles/{uid}.role = 'admin'` **and** sets the `admin` custom claim. After
   that the env allow-list is redundant for you. (Custom claims reach the client
   on the next ID-token refresh; server-side admin access via the role doc is
   effective immediately.)

The last-admin-standing guard refuses a demotion that would leave zero admins;
`PARLEY_ADMIN_EMAILS` remains the break-glass recovery path.

## 4. What's logged per API call

`usage_log` gets one row per outbound provider call (and one per failed
fallback attempt): `fn` (server function name), `provider`, `model`,
`inputTokens`/`outputTokens` (LLM), `characters` (TTS/embeddings),
`estCostUsd` (list-price estimate — see `src/lib/server/pricing.ts`),
`latencyMs`, `ok`, `error`, `createdAt`. Writes are fire-and-forget via the
Admin SDK; a logging failure never breaks the user-facing request.

## 5. Security model recap

- API keys live only in server env; server functions are the only callers.
- Every money-spending server function runs behind `requireUserOrLocal`
  (Firebase ID-token verification when Firebase is configured).
- `/admin` server functions run behind `requireAdmin` (custom claim, durable
  role, or verified allow-listed email).
- Firestore rules are the backstop: even with the (public) client config, a
  user can only read/write their own rows.
- Admin dashboard is metrics/cost only. Admins have no access to `user_backups`
  in either rules or code. Transcript access for admins is intentionally not
  built (vulnerable users / minors — per project policy any future version must
  be gated behind explicit per-user consent).

## 6. Cloud sync (E2E-encrypted backups)

`user_backups/{uid}.data` holds a full snapshot of the user's local Dexie
database. When a per-device passphrase is set, the snapshot is encrypted
client-side (AES-GCM + PBKDF2, see `src/lib/crypto/backup-crypto.ts`) before it
leaves the browser, so the server only ever stores ciphertext. Without a
passphrase the snapshot is stored as plaintext JSON (protected by rules) with a
one-time console warning; setting a passphrase and pushing once migrates the
cloud copy to ciphertext.

> **Firestore document limit:** a single document is capped at ~1 MiB. Backups
> above that are refused with a clear sync-error state rather than an opaque
> Firestore failure. If a user's snapshot grows past that (large embeddings),
> the follow-up is to spill the blob to Firebase Storage instead of Firestore.

## Known follow-ups (not yet implemented)

- **Large-backup spill to Firebase Storage** (see the 1 MiB note above).
- **Merge into `jackharker000/parley`** behind `/app` per the one-repo,
  one-domain architecture; the marketing site header already links to the
  app via `VITE_PARLEY_APP_URL`.
- **Scribe audio-hours cost:** ElevenLabs bills STT per audio hour; we log
  session starts but not duration. Wire the client to report session length
  if per-user STT cost matters.
