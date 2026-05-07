-- ─────────────────────────────────────────────────────────────────────────
-- profiles.notify_abstraction_complete — fill the gap that produced 400s
-- ─────────────────────────────────────────────────────────────────────────
--
-- AccountSettings.tsx selects + updates this column but it never existed
-- in the schema, producing a silent 400 on every Account Settings load
-- and a silent failure on every preference save. KNOWN_ISSUES #1 (filed
-- 2026-05-03). Adding the column with a sensible default.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS notify_abstraction_complete boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.profiles.notify_abstraction_complete IS
  'When true, the user receives a notification when the AI extraction pipeline finishes processing a lease they uploaded. Default true. Toggled from /app/settings/account.';
