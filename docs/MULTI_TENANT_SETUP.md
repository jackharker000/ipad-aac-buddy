# Parley multi-tenant setup

Parley is a login-gated, multi-tenant product. Every user signs in, every
user's data is isolated (Postgres RLS server-side + per-user Dexie snapshots
client-side), every external API call is usage/cost-logged, and admins get a
metrics-only dashboard at `/admin`.

## 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com) (or reuse the
   existing Parley project).
2. Apply the migration:
   ```sh
   # with the Supabase CLI linked to the project
   supabase db push
   # or paste supabase/migrations/20260708120000_multi_tenant_core.sql into
   # the SQL editor and run it.
   ```
   The migration is idempotent (`if not exists` / `drop policy if exists`)
   and safe to run on a database that already has `user_backups`.

What it creates:

| Table          | Purpose                                                                             | Who can read                                                                           |
| -------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `profiles`     | one row per user: email, display name, role, last_active_at                         | the user; admins                                                                       |
| `user_backups` | encrypted-at-rest snapshot of the user's local database                             | **the user only — admins deliberately have no access** (AAC transcripts are sensitive) |
| `usage_log`    | one row per LLM/STT/TTS/embedding call: provider, model, tokens, est. cost, latency | the user (own rows); admins (all)                                                      |

Roles cannot be self-escalated: a trigger freezes `profiles.role` on user
updates; only the service role (server) or an existing admin can change it.

## 2. Environment variables (Vercel → Settings → Environment Variables)

```
SUPABASE_URL=                    # Project settings → API
SUPABASE_PUBLISHABLE_KEY=        # ("anon" / publishable key)
SUPABASE_SERVICE_ROLE_KEY=       # server only — powers usage logging + admin queries
VITE_SUPABASE_URL=               # same URL, exposed to the client bundle
VITE_SUPABASE_PUBLISHABLE_KEY=   # same publishable key, exposed to the client
PARLEY_ADMIN_EMAILS=you@example.com   # bootstrap admin(s), comma-separated
```

Behavior matrix:

- **All set (production):** sign-in required for every visitor; all server
  functions reject anonymous calls (401); usage logging active.
- **Unset, dev build:** local-first anonymous mode (engine hacking, offline).
- **Unset, production build:** a "deployment not configured" notice — a
  public multi-user deploy is never silently unauthenticated.

## 3. First admin

Sign up normally with an email listed in `PARLEY_ADMIN_EMAILS`, open
`/admin`, and (optionally) promote yourself durably via the role toggle in
the users table — after that the env allow-list is redundant for you.

## 4. What's logged per API call

`usage_log` gets one row per outbound provider call (and one per failed
fallback attempt): `fn` (server function name), `provider`, `model`,
`input_tokens`/`output_tokens` (LLM), `characters` (TTS/embeddings),
`est_cost_usd` (list-price estimate — see `src/lib/server/pricing.ts`),
`latency_ms`, `ok`, `error`. Inserts are fire-and-forget via the service
role; a logging failure never breaks the user-facing request.

## 5. Security model recap

- API keys live only in server env; server functions are the only callers.
- Every money-spending server function runs behind `requireUserOrLocal`
  (bearer-token validation when Supabase is configured).
- `/admin` server functions run behind `requireAdmin` (role or allow-list).
- RLS is the backstop: even with a leaked publishable key, a user can only
  read/write their own rows.
- Admin dashboard is metrics/cost only. Transcript access for admins is
  intentionally not built (vulnerable users / minors — per project policy any
  future version must be gated behind explicit per-user consent).

## Known follow-ups (not yet implemented)

- **E2E-encrypted cloud snapshots:** `user_backups.data` is currently
  plaintext JSON inside Postgres (protected by RLS + at-rest encryption).
  The plan of record is client-side AES-GCM with a per-device passphrase so
  the server only ever sees ciphertext.
- **Merge into `jackharker000/parley`** behind `/app` per the one-repo,
  one-domain architecture; the marketing site header already links to the
  app via `VITE_PARLEY_APP_URL`.
- **Scribe audio-hours cost:** ElevenLabs bills STT per audio hour; we log
  session starts but not duration. Wire the client to report session length
  if per-user STT cost matters.
