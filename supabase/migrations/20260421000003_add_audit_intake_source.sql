-- Add 'audit' as a valid intake_source value for the free lease audit flow.
-- The existing CHECK constraint must be dropped and re-created since Postgres
-- does not support ALTER CHECK in place.

ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_intake_source_check;

ALTER TABLE leases
  ADD CONSTRAINT leases_intake_source_check
  CHECK (intake_source IN ('request_workflow', 'email_intake', 'backdoor', 'manual_upload', 'audit'));

COMMENT ON CONSTRAINT leases_intake_source_check ON leases IS
  'Valid intake paths: request_workflow (Path 1), email_intake (Path 2), backdoor (historical), manual_upload (direct upload), audit (free lease audit GTM flow)';
