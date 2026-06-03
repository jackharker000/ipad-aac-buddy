# Setup

## First-time setup

```bash
git clone <repo-url>
cd ipad-aac-buddy
bun install
cp .env.example .env
```

Fill in the keys in `.env`. See `.env.example` for which vars are server-only and which are public.

## Supabase setup

1. Create a Supabase project at https://supabase.com.
2. In the project's SQL editor, run the migration at `supabase/migrations/0001_init.sql`.
3. In Authentication → Providers, enable Email and (optionally) disable magic links if you only want password sign-in.
4. In Authentication → URL Configuration:
   - Set Site URL to your deploy URL (e.g. `https://parley.example.com`). Use `http://localhost:3000` for local dev.
   - Add `/auth/callback` to the Redirect URLs allow-list for every URL you want to receive confirmation/recovery links from (Site URL and any preview deploys).
5. Copy the project URL and anon key from Project Settings → API into the matching `SUPABASE_*` and `VITE_SUPABASE_*` vars in `.env`. Copy the service role key into `SUPABASE_SERVICE_ROLE_KEY` (never expose this to the client).

## Creating the first admin

Sign up for an account by visiting `/signup` in your running app. Then, in the Supabase SQL editor:

```sql
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                          || jsonb_build_object('is_admin', true)
 where email = 'you@example.com';
```

Sign out and back in to refresh the JWT. You should now be able to reach `/admin`.

## Dev

```bash
bun run dev
```

The app boots on http://localhost:3000.

## Typecheck

```bash
bun run typecheck
```

## Build

```bash
bun run build
```

## Deploy

Push to the repo's main branch. Vercel auto-detects the TanStack Start project (Nitro under the hood) and builds it. Set every var from `.env.example` (except the `VITE_*` ones that are mirrored, which Vercel will bundle from the build environment) in the Vercel project's environment settings — Production, Preview, and Development scopes as needed.
