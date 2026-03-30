-- Add intake_source to track how each lease entered the system
ALTER TABLE leases ADD COLUMN IF NOT EXISTS intake_source text
  DEFAULT 'manual_upload'
  CHECK (intake_source IN ('request_workflow', 'email_intake', 'backdoor', 'manual_upload'));

COMMENT ON COLUMN leases.intake_source IS 'How this lease entered the system: request_workflow (Path 1), email_intake (Path 2), backdoor (historical onboarding), manual_upload (direct upload)';

-- Backfill: only mark as request_workflow where there is clear evidence
-- of workflow origin (has a lifecycle_status set AND has approval history)
UPDATE leases
SET intake_source = 'request_workflow'
WHERE intake_source = 'manual_upload'
  AND lifecycle_status IS NOT NULL
  AND lifecycle_status NOT IN ('draft')
  AND id IN (
    SELECT DISTINCT lease_id FROM lease_approvals
  );

-- Everything else stays as manual_upload (the default), which is the
-- safest assumption for leases without clear provenance signals.
