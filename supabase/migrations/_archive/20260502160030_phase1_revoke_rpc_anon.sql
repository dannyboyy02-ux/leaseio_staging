-- Defense-in-depth: explicitly revoke the auto-granted EXECUTE on the
-- two Phase 1 RPCs from the `anon` role. Both functions already raise
-- 'Forbidden' when auth.uid() is null, but no reason to leave the door
-- ajar.
--
-- This file mirrors the migration applied to the live Supabase project on
-- 2026-05-02 (version 20260502160030). It is idempotent — REVOKE is a no-op
-- when the privilege has already been removed.

REVOKE EXECUTE ON FUNCTION public.preview_policy_resolution(uuid, text, text, numeric, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.apply_policy_steps(uuid, jsonb) FROM anon;
