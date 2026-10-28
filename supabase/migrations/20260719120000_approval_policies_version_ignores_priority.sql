-- ============================================================================
-- Phase 0 / migration 1 of 2 — approval_policies_version_increment stops
-- watching `priority`.
--
-- APPLY ORDER: this file MUST apply BEFORE
-- 20260719120100_retire_is_default_fallback_routing.sql. That migration writes
-- the `priority` column (to pin each formerly-flagged fallback rule last), and
-- until this trigger change lands such a write would bump `version` on a
-- governance table and put in-flight leases through a reroute reconcile. The
-- timestamps sequence them correctly; do not reorder, and do not apply the data
-- migration alone.
--
-- THE INVARIANT, stated plainly:
--   `approval_policies.version` stamps a rule's ROUTING DEFINITION — what it
--   matches (name + the five match_* criteria) and how it approves
--   (separation_of_duties_override). A rule's POSITION relative to other rules
--   is NOT part of its definition, so reordering rules must not bump version.
--
-- WHAT THIS BUYS — stated precisely, without overclaim:
--   It eliminates SPURIOUS reroutes. `lease_attribute_snapshots` records
--   `policy_id` + `policy_version`, and resolve-approval-chain compares
--   `snapshot.policy_version === newPolicy.version` to decide whether an
--   in-flight lease's chain needs reconciling. With `priority` in the WHEN
--   clause, ANY reorder bumps version on the touched rules — faking a content
--   change on a rule whose DEFINITION did not change. Every in-flight lease
--   pinned to one of them then fails that short-circuit, and its next benign
--   attribute edit drops into the full reconcile path, writing a fabricated
--   `lease_reroute_events` row with zero actual step changes — on the exact
--   governance table the repository-integrity lane exists to defend. Removing
--   `priority` from the WHEN clause removes that fabrication.
--
-- WHAT THIS DOES **NOT** BUY — read this before quoting the migration:
--   It does NOT freeze routing, and it is NOT an in-flight-immutability
--   guarantee. Reordering rules CAN still change who approves a request that is
--   already in flight. The chain is re-evaluated against the CURRENT rule set
--   whenever the lease's OWN attributes materially change; if a reorder (or an
--   edit, or a new rule) made a DIFFERENT rule the winner, that new rule applies
--   at that moment and the chain is rebuilt. That is the intended reroute design
--   — owner decision D-Q5, ratified after an adversarial review that correctly
--   refuted the stronger claim.
--
--   That genuine winner change is caught independently by
--   `snapshot.policy_id !== newPolicy.id` on the same line, and — as of the
--   D-Q5 disclosure work — it is no longer silent: resolve-approval-chain writes
--   a `chain_routing_rule_changed` lease_activity_log row naming the prior rule,
--   the new rule, and why, so the activity log answers "why did my approvers
--   change?" without a DB query. Visibility, not immutability, is the guarantee.
--
-- WHAT ELSE CHANGES: nothing. Every other column comparison is reproduced
-- EXACTLY as it stands in 20260516120000_baseline_schema.sql:3043 — name, all
-- five match_* columns, and separation_of_duties_override. Only the
-- `priority` disjunct is removed. The trigger function
-- (public.increment_policy_version) is untouched.
--
-- Idempotent: CREATE OR REPLACE TRIGGER (PG14+). Safe to replay.
--
-- SECURITY-SENSITIVE (governance trigger on an approval-routing table): route
-- lease-security-scanner + lease-repository-integrity-reviewer BEFORE applying
-- via apply_migration, per the CLAUDE.md security-migration rule.
-- ============================================================================

CREATE OR REPLACE TRIGGER approval_policies_version_increment
  BEFORE UPDATE ON public.approval_policies
  FOR EACH ROW
  WHEN (
    (OLD.name IS DISTINCT FROM NEW.name)
    OR (OLD.match_asset_types IS DISTINCT FROM NEW.match_asset_types)
    OR (OLD.match_departments IS DISTINCT FROM NEW.match_departments)
    OR (OLD.match_min_annual_cost IS DISTINCT FROM NEW.match_min_annual_cost)
    OR (OLD.match_max_annual_cost IS DISTINCT FROM NEW.match_max_annual_cost)
    OR (OLD.match_regions IS DISTINCT FROM NEW.match_regions)
    OR (OLD.match_lease_types IS DISTINCT FROM NEW.match_lease_types)
    OR (OLD.separation_of_duties_override IS DISTINCT FROM NEW.separation_of_duties_override)
  )
  EXECUTE FUNCTION public.increment_policy_version();

COMMENT ON FUNCTION public.increment_policy_version() IS
  'BEFORE UPDATE on approval_policies: bumps version when a rule''s ROUTING DEFINITION changes (name, the five match_* criteria, separation_of_duties_override). As of 20260719120000 `priority` is deliberately NOT in the trigger''s WHEN clause: a rule''s position in the evaluation order is not part of its definition, and bumping version on a reorder would break resolve-approval-chain''s policy_version short-circuit and fabricate lease_reroute_events rows for in-flight leases whose steps did not change. This removes SPURIOUS reroutes only — it does NOT freeze routing. A reorder that makes a genuinely different rule the winner still applies to an in-flight lease on its next material attribute change (the intended reroute design, D-Q5); that case is caught by the policy_id comparison and disclosed by the chain_routing_rule_changed activity row.';
