-- Waitlist (anonymous insert allowed; reads admin-only via service role)
create table if not exists public.waitlist (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  about text
);
alter table public.waitlist enable row level security;
-- No client-side reads/inserts; the server-side service-role client handles everything.

-- After your first signup, mark yourself admin (replace the email):
-- update auth.users
--   set raw_app_meta_data = raw_app_meta_data || jsonb_build_object('is_admin', true)
--   where email = 'you@example.com';
