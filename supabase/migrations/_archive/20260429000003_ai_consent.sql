-- ============================================================================
-- profiles.ai_processing_consent_at — persisted AI processing consent
-- ============================================================================
-- The signup form requires users to acknowledge that uploaded documents are
-- processed by AI before they can create an account. That acknowledgement was
-- previously only validated client-side and never persisted, which meant we
-- could neither prove consent for compliance nor honor a revocation.
--
-- This column captures the timestamp of consent. NULL means the user has
-- revoked (or, before this migration, never recorded) consent.
--
-- Existing users are backfilled to their profile creation time, since the
-- signup form has gated account creation on the consent checkbox for some
-- time. New signups will write the timestamp via the application code.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ai_processing_consent_at timestamptz;

UPDATE public.profiles
   SET ai_processing_consent_at = created_at
 WHERE ai_processing_consent_at IS NULL;
