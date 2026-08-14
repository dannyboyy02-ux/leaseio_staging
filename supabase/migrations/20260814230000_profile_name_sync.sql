-- Populate profiles.first_name / last_name / company_name / timezone from
-- signup metadata.
--
-- ROOT CAUSE (found in the 2026-08-14 firm walkthrough): Signup.tsx passes
-- { first_name, last_name, company_name, timezone } into supabase.auth.signUp's
-- options.data, which lands in auth.users.raw_user_meta_data. But the
-- handle_new_user trigger inserted ONLY (id, email) into public.profiles and
-- dropped everything else. Every named signup therefore had its name in auth
-- metadata but NULL in profiles (3 of 5 live profiles at time of fix); the
-- selected timezone likewise stayed at the column default 'America/New_York'.
--
-- WHY IT SHOWS: AppSidebar reads the CURRENT user's name from
-- authUser.user_metadata directly (a per-session workaround), so a user sees
-- their OWN name fine. But any surface listing OTHER users can only read names
-- from public.profiles (a client cannot read another user's auth metadata) —
-- FirmMembers, workspace member lists, audit actor names — so those fell back
-- to showing the raw email. Timezone is read from profiles by AppContext for
-- date rendering, so the dropped value silently reverted users to Eastern.
-- The fix is at the data layer (profiles), which every reader shares; no
-- component change is needed (their render already prefers name over email).
--
-- Idempotent throughout (CREATE OR REPLACE + fill-only / provably-safe backfill).

-- 1. Forward fix: the signup trigger now copies name/company/timezone from the
--    new auth user's metadata. SECURITY DEFINER + pinned search_path are
--    preserved from the baseline definition. ON CONFLICT fills only NULLs on a
--    pre-existing profiles row (COALESCE keeps any already-set value); timezone
--    is filled only when the existing row still holds the bare default, so a
--    deliberate non-default choice is never clobbered.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
begin
  insert into public.profiles (id, email, first_name, last_name, company_name, timezone)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data->>'first_name', ''),
    nullif(new.raw_user_meta_data->>'last_name', ''),
    nullif(new.raw_user_meta_data->>'company_name', ''),
    coalesce(nullif(new.raw_user_meta_data->>'timezone', ''), 'America/New_York')
  )
  on conflict (id) do update set
    first_name   = coalesce(public.profiles.first_name, excluded.first_name),
    last_name    = coalesce(public.profiles.last_name, excluded.last_name),
    company_name = coalesce(public.profiles.company_name, excluded.company_name),
    timezone     = case
                     when public.profiles.timezone = 'America/New_York' then excluded.timezone
                     else public.profiles.timezone
                   end;

  return new;
end;
$$;

-- 2. Backfill existing rows. ORDER MATTERS: the timezone backfill (2a) uses
--    "profiles.first_name IS NULL" to prove a row was never edited via Settings,
--    so it MUST run BEFORE the name backfill (2b) fills that column — otherwise
--    2b would erase the very signal 2a depends on.

-- 2a. Backfill timezone — PROVABLY-SAFE scope only. timezone has a non-null
--     default, and AccountSettings writes profile edits to `profiles` ONLY
--     (never back to auth metadata), so a user who signed up in one zone and
--     later chose another in Settings has the real choice in profiles but a
--     stale zone frozen in metadata. Restoring from metadata blindly would
--     REVERT such a deliberate choice.
--     The safe signal: Signup REQUIRES first+last name (validated), so metadata
--     always carries them and Settings always writes non-empty names. Therefore
--     both name columns being NULL proves the row was NEVER edited via Settings
--     — its timezone is definitionally the untouched signup default, so
--     replacing it with the signup-detected metadata value is faithful
--     restoration, not a revert.
UPDATE public.profiles p
SET timezone = nullif(u.raw_user_meta_data->>'timezone', '')
FROM auth.users u
WHERE u.id = p.id
  AND p.first_name IS NULL
  AND p.last_name IS NULL
  AND p.timezone = 'America/New_York'
  AND nullif(u.raw_user_meta_data->>'timezone', '') IS NOT NULL
  AND u.raw_user_meta_data->>'timezone' <> 'America/New_York';

-- 2b. Backfill names/company: fill NULL columns from auth metadata. Guarded so
--     it only touches rows actually missing the value AND with a non-empty
--     metadata source — never overwrites a set field, never writes empty
--     strings (an intentionally-cleared name is a non-null '' and is skipped).
UPDATE public.profiles p
SET
  first_name   = coalesce(p.first_name,   nullif(u.raw_user_meta_data->>'first_name', '')),
  last_name    = coalesce(p.last_name,    nullif(u.raw_user_meta_data->>'last_name', '')),
  company_name = coalesce(p.company_name, nullif(u.raw_user_meta_data->>'company_name', ''))
FROM auth.users u
WHERE u.id = p.id
  AND (
    (p.first_name   IS NULL AND nullif(u.raw_user_meta_data->>'first_name', '')   IS NOT NULL) OR
    (p.last_name    IS NULL AND nullif(u.raw_user_meta_data->>'last_name', '')    IS NOT NULL) OR
    (p.company_name IS NULL AND nullif(u.raw_user_meta_data->>'company_name', '') IS NOT NULL)
  );
