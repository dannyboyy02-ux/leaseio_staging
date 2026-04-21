-- Add dedicated columns for fields extracted by AI but previously stored only in extracted_json.
-- These columns enable SQL queries, proper save/edit persistence, and correct portfolio calculations.

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS property_address        text,
  ADD COLUMN IF NOT EXISTS rent_commencement_date  date,
  ADD COLUMN IF NOT EXISTS security_deposit        text,
  ADD COLUMN IF NOT EXISTS renewal_options         text,
  ADD COLUMN IF NOT EXISTS escalation_clauses      text,
  ADD COLUMN IF NOT EXISTS termination_clauses     text;

-- term_months already exists but is never written by the extraction pipeline.
-- Backfill from lease_start / lease_end for existing rows where it is null.
UPDATE leases
SET term_months = ROUND(
  EXTRACT(EPOCH FROM (lease_end::timestamptz - lease_start::timestamptz)) / (86400 * 30.4375)
)::integer
WHERE term_months IS NULL
  AND lease_start IS NOT NULL
  AND lease_end   IS NOT NULL;

-- Backfill the new text columns from extracted_json for existing rows.
UPDATE leases
SET
  property_address       = COALESCE(property_address,       extracted_json #>> '{property_address,value}'),
  rent_commencement_date = COALESCE(rent_commencement_date, (extracted_json #>> '{rent_commencement_date,value}')::date),
  security_deposit       = COALESCE(security_deposit,       extracted_json #>> '{security_deposit,value}'),
  renewal_options        = COALESCE(renewal_options,        extracted_json #>> '{renewal_options,value}'),
  escalation_clauses     = COALESCE(escalation_clauses,     extracted_json #>> '{escalation_clauses,value}'),
  termination_clauses    = COALESCE(termination_clauses,    extracted_json #>> '{termination_clauses,value}')
WHERE extracted_json IS NOT NULL;

COMMENT ON COLUMN leases.property_address       IS 'Full address of leased premises — extracted by AI, editable in workbench';
COMMENT ON COLUMN leases.rent_commencement_date IS 'Date rent obligations begin (may differ from lease_start)';
COMMENT ON COLUMN leases.security_deposit       IS 'Security deposit amount as extracted from document';
COMMENT ON COLUMN leases.renewal_options        IS 'Summary of renewal / extension option terms';
COMMENT ON COLUMN leases.escalation_clauses     IS 'Detailed description of rent escalation methodology';
COMMENT ON COLUMN leases.termination_clauses    IS 'Summary of termination and break clause provisions';
