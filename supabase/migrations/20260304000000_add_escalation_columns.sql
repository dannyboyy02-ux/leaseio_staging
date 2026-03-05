-- Portfolio Analytics Engine — Step 0
-- Add escalation type classification and CPI review flag to leases table.
-- These columns are populated by process_lease during escalation normalization.
-- All downstream analytics must read escalation_type and escalation_rate;
-- never parse rent_escalation_type outside of process_lease.

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS escalation_type text,
  ADD COLUMN IF NOT EXISTS needs_escalation_review boolean DEFAULT false;

COMMENT ON COLUMN leases.escalation_type IS
  'Normalized escalation classification: percent | index | none. Set by process_lease.';

COMMENT ON COLUMN leases.needs_escalation_review IS
  'True when escalation is CPI/index-based and requires manual review for ASC 842 accuracy. Never default index leases to 0.';
