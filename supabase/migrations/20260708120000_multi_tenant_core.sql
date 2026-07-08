-- Multi-tenant core: profiles + roles, per-user backups with RLS, usage/cost log.
--
-- Design notes:
--  * Every table is RLS-enabled. Users can only ever see their own rows.
--  * Admins (profiles.role = 'admin') can read profiles and usage_log for the
--    admin dashboard — but deliberately have NO access to user_backups, which
--    holds conversation transcripts (sensitive, medical-adjacent AAC data).
--  * usage_log rows are inserted exclusively by server functions via the
--    service-role key; there is no INSERT policy for regular users.

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, created automatically on signup.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  last_active_at timestamptz
);

alter table public.profiles enable row level security;

-- Security-definer helper so policies can check admin-ness without recursing
-- into profiles' own RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
  on public.profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  -- Constrain role on self-insert: a user may only ever create their own row
  -- as a plain 'user'. Without the role check, a client could self-insert an
  -- admin row if the signup trigger ever failed to pre-create it. (Review M5.)
  with check (id = auth.uid() and role = 'user');

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Users must not be able to grant themselves admin: freeze `role` on UPDATE
-- unless the caller is already an admin (service role bypasses RLS + triggers
-- run as table owner, so server-side role changes still work).
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Freeze `role` against self-escalation by a signed-in non-admin user.
  -- `auth.uid()` is NULL for service-role / SQL-editor calls (no JWT context);
  -- those are trusted server operations, so we must ALLOW them — otherwise
  -- adminSetRole (service role) silently no-ops and the first admin can never
  -- be minted. Only revert when there IS an authenticated caller and they are
  -- not already an admin. (Review LOW — trigger correctness.)
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_admin() then
    new.role := old.role;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_role on public.profiles;
create trigger protect_profile_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

-- Auto-create a profile row for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users that signed up before this migration.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- user_backups: per-user Dexie snapshot. Owner-only; no admin access.
-- ---------------------------------------------------------------------------
create table if not exists public.user_backups (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_backups enable row level security;

drop policy if exists "user_backups_owner_select" on public.user_backups;
create policy "user_backups_owner_select"
  on public.user_backups for select
  using (user_id = auth.uid());

drop policy if exists "user_backups_owner_insert" on public.user_backups;
create policy "user_backups_owner_insert"
  on public.user_backups for insert
  with check (user_id = auth.uid());

drop policy if exists "user_backups_owner_update" on public.user_backups;
create policy "user_backups_owner_update"
  on public.user_backups for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_backups_owner_delete" on public.user_backups;
create policy "user_backups_owner_delete"
  on public.user_backups for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- usage_log: one row per external API call (LLM / STT / TTS / embeddings).
-- Written server-side via the service role; users see their own rows, admins
-- see everything. Powers the admin dashboard's usage + cost views.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  fn text not null,
  provider text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  characters integer,
  est_cost_usd numeric(12, 6),
  latency_ms integer,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists usage_log_created_at_idx on public.usage_log (created_at desc);
create index if not exists usage_log_user_created_idx on public.usage_log (user_id, created_at desc);

alter table public.usage_log enable row level security;

drop policy if exists "usage_log_select_own" on public.usage_log;
create policy "usage_log_select_own"
  on public.usage_log for select
  using (user_id = auth.uid());

drop policy if exists "usage_log_select_admin" on public.usage_log;
create policy "usage_log_select_admin"
  on public.usage_log for select
  using (public.is_admin());
