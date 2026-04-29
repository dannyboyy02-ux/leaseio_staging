-- ============================================================================
-- Summary Share Token: expiry column + 30-day backfill
-- ============================================================================
-- Public summary share tokens (leases.summary_share_token) previously had no
-- expiration: once issued, the token worked forever. This migration adds an
-- expiry column and gives every existing token a 30-day grace period from
-- the deploy time so existing share links continue to work for a month.
--
-- New tokens issued after this migration set expiry to now() + 30 days at
-- generation time; the get-summary-by-token edge function rejects expired
-- tokens with 404.
-- ============================================================================

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS summary_share_token_expires_at timestamptz;

UPDATE public.leases
   SET summary_share_token_expires_at = now() + interval '30 days'
 WHERE summary_share_token IS NOT NULL
   AND summary_share_token_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS leases_summary_share_token_expires_at_idx
  ON public.leases (summary_share_token_expires_at)
  WHERE summary_share_token_expires_at IS NOT NULL;
