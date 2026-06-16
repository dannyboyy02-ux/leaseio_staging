-- ============================================================================
-- Phase 10 / #107 — firm_billing_quantity_changed activity_type
-- ============================================================================
-- The firm subscription's billed quantity (= bound child count × $499) changes
-- on every bind/release/create and on the reconcile cron. That dollar-amount
-- change must be attributable (hard rule #9 / integrity). Add the audit value to
-- firm_activity_log's CHECK. Append-only; reproduces the CP1 set + the new value.
-- ============================================================================
ALTER TABLE public.firm_activity_log
  DROP CONSTRAINT IF EXISTS firm_activity_log_activity_type_check;

ALTER TABLE public.firm_activity_log
  ADD CONSTRAINT firm_activity_log_activity_type_check
  CHECK (activity_type = ANY (ARRAY[
    -- Phase 9 firm events
    'firm_created','firm_member_added','firm_member_removed','firm_member_role_changed',
    'workspace_joined_firm','workspace_left_firm','workspace_firm_access_restricted',
    'workspace_firm_access_unrestricted','firm_billing_subscription_started',
    'firm_billing_subscription_updated','firm_billing_subscription_canceled',
    -- Phase 10 (CP1)
    'firm_invitation_sent','firm_invitation_accepted','firm_invitation_revoked',
    'firm_invitation_resent','firm_join_request_created','firm_join_request_approved',
    'firm_join_request_rejected','firm_join_request_cancelled','firm_join_request_expired',
    'firm_settings_updated','firm_billing_summary_mode_changed','firm_deleted',
    -- #107 — billed-quantity changes (incl. sync failures, recorded with
    -- details.sync_failed=true so a silent vendor failure is queryable)
    'firm_billing_quantity_changed'
  ]));
