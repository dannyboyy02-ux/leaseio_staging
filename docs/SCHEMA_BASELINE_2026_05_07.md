# LeaseIO Schema Baseline — 2026-05-07

Reference snapshot of the live Supabase `public` schema for the LeaseIO project. Use this document as the "expected state" when running `supabase db pull` to fix migration drift.

| Field | Value |
|---|---|
| Generation date | 2026-05-07 |
| Project ref | `wwkwoxxcprnjjufkbzac` |
| Schema | `public` |
| Tables | 41 |
| Views | 4 |
| Columns | 669 |
| Indexes | 195 |
| RLS policies | 112 |
| Functions | 21 |
| CHECK constraints | 51 |
| Foreign keys | 119 |
| Triggers | 15 |

See [`MIGRATION_DRIFT_REMEDIATION.md`](./MIGRATION_DRIFT_REMEDIATION.md) for the playbook that consumes this baseline.

This document is for grep/diff reference, not top-to-bottom reading. All sections are alphabetically sorted within their grouping so future regenerations diff cleanly.

---

## 1. Tables and columns

Each table lists its columns in ordinal-position order: `column | type | nullable | default`.

### `alert_rules` (8 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `alert_type` | `text` | NO |  |
| 4 | `threshold_days` | `integer` | YES |  |
| 5 | `threshold_value` | `numeric` | YES |  |
| 6 | `is_active` | `boolean` | NO | `true` |
| 7 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 8 | `updated_at` | `timestamp with time zone` | NO | `now()` |

### `approval_chain_steps` (11 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `policy_id` | `uuid` | NO |  |
| 3 | `stage` | `text` | NO |  |
| 4 | `step_order` | `integer` | NO |  |
| 5 | `parallel_group` | `integer` | NO | `1` |
| 6 | `approver_user_id` | `uuid` | YES |  |
| 7 | `approver_role` | `text` | YES |  |
| 8 | `delegate_user_id` | `uuid` | YES |  |
| 9 | `delegate_after_days` | `integer` | YES |  |
| 10 | `is_required` | `boolean` | NO | `true` |
| 11 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `approval_policies` (19 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `name` | `text` | NO |  |
| 4 | `description` | `text` | YES |  |
| 5 | `priority` | `integer` | NO | `100` |
| 6 | `match_asset_types` | `text[]` | NO | `'{}'::text[]` |
| 7 | `match_departments` | `text[]` | NO | `'{}'::text[]` |
| 8 | `match_min_annual_cost` | `numeric` | YES |  |
| 9 | `match_max_annual_cost` | `numeric` | YES |  |
| 10 | `match_regions` | `text[]` | NO | `'{}'::text[]` |
| 11 | `match_lease_types` | `text[]` | NO | `'{}'::text[]` |
| 12 | `separation_of_duties_override` | `boolean` | YES |  |
| 13 | `is_default_fallback` | `boolean` | NO | `false` |
| 14 | `version` | `integer` | NO | `1` |
| 15 | `is_active` | `boolean` | NO | `true` |
| 16 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 17 | `updated_at` | `timestamp with time zone` | NO | `now()` |
| 18 | `created_by` | `uuid` | NO |  |
| 19 | `updated_by` | `uuid` | NO |  |

### `chain_step_overrides` (12 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `chain_step_id` | `uuid` | NO |  |
| 3 | `lease_id` | `uuid` | NO |  |
| 4 | `workspace_id` | `uuid` | NO |  |
| 5 | `override_action` | `text` | NO |  |
| 6 | `override_by` | `uuid` | NO |  |
| 7 | `override_reason` | `text` | NO |  |
| 8 | `override_at` | `timestamp with time zone` | NO | `now()` |
| 9 | `reassigned_to_user_id` | `uuid` | YES |  |
| 10 | `prior_assignee_user_id` | `uuid` | YES |  |
| 11 | `prior_assignee_role` | `text` | YES |  |
| 12 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `chain_step_voluntary_delegations` (10 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `chain_step_id` | `uuid` | NO |  |
| 3 | `lease_id` | `uuid` | NO |  |
| 4 | `workspace_id` | `uuid` | NO |  |
| 5 | `delegated_by` | `uuid` | NO |  |
| 6 | `delegated_to` | `uuid` | NO |  |
| 7 | `delegated_at` | `timestamp with time zone` | NO | `now()` |
| 8 | `reason` | `text` | YES |  |
| 9 | `revoked_at` | `timestamp with time zone` | YES |  |
| 10 | `revoked_by` | `uuid` | YES |  |

### `deleted_workspaces` (10 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `original_workspace_id` | `uuid` | NO |  |
| 3 | `owner_id` | `uuid` | NO |  |
| 4 | `workspace_name` | `text` | YES |  |
| 5 | `workspace_plan` | `text` | YES |  |
| 6 | `lease_count_at_deletion` | `integer` | YES |  |
| 7 | `member_count_at_deletion` | `integer` | YES |  |
| 8 | `storage_objects_purged` | `integer` | YES |  |
| 9 | `deleted_at` | `timestamp with time zone` | NO | `now()` |
| 10 | `deleted_by` | `uuid` | YES |  |

### `dismissed_events` (7 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `user_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `event_key` | `text` | NO |  |
| 5 | `dismissed_at` | `timestamp with time zone` | NO | `now()` |
| 6 | `expires_at` | `timestamp with time zone` | YES |  |
| 7 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `executed_term_edits` (8 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `field_name` | `text` | NO |  |
| 4 | `original_value` | `text` | YES |  |
| 5 | `edited_value` | `text` | YES |  |
| 6 | `edited_by` | `uuid` | NO |  |
| 7 | `edited_at` | `timestamp with time zone` | NO | `now()` |
| 8 | `reason` | `text` | YES |  |

### `field_corrections` (10 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `field_name` | `text` | NO |  |
| 4 | `original_value` | `text` | YES |  |
| 5 | `corrected_value` | `text` | YES |  |
| 6 | `ai_confidence` | `numeric` | YES |  |
| 7 | `corrected_by` | `uuid` | YES |  |
| 8 | `corrected_at` | `timestamp with time zone` | YES | `now()` |
| 9 | `correction_type` | `text` | YES |  |
| 10 | `user_notes` | `text` | YES |  |

### `invite_tokens` (10 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `email` | `text` | NO |  |
| 4 | `role` | `workspace_role` | NO | `'viewer'::workspace_role` |
| 5 | `token` | `text` | NO | `encode(gen_random_bytes(32), 'hex'::text)` |
| 6 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 7 | `expires_at` | `timestamp with time zone` | NO | `(now() + '7 days'::interval)` |
| 8 | `accepted_at` | `timestamp with time zone` | YES |  |
| 9 | `first_name` | `text` | YES |  |
| 10 | `last_name` | `text` | YES |  |

### `lease_activity_log` (8 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `user_id` | `uuid` | YES |  |
| 4 | `activity_type` | `text` | NO |  |
| 5 | `from_status` | `text` | YES |  |
| 6 | `to_status` | `text` | YES |  |
| 7 | `details` | `jsonb` | YES |  |
| 8 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_approval_actions` (7 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `approver_id` | `uuid` | NO |  |
| 4 | `approval_type` | `text` | NO |  |
| 5 | `action` | `text` | NO |  |
| 6 | `comment` | `text` | YES |  |
| 7 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_approval_chain` (23 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `policy_id` | `uuid` | YES |  |
| 5 | `policy_version` | `integer` | YES |  |
| 6 | `stage` | `text` | NO |  |
| 7 | `step_order` | `integer` | NO |  |
| 8 | `parallel_group` | `integer` | NO | `1` |
| 9 | `approver_user_id` | `uuid` | YES |  |
| 10 | `approver_role` | `text` | YES |  |
| 11 | `delegate_user_id` | `uuid` | YES |  |
| 12 | `delegate_after_days` | `integer` | YES |  |
| 13 | `is_required` | `boolean` | NO | `true` |
| 14 | `status` | `text` | NO | `'pending'::text` |
| 15 | `action_at` | `timestamp with time zone` | YES |  |
| 16 | `action_by` | `uuid` | YES |  |
| 17 | `comment` | `text` | YES |  |
| 18 | `rerouted_from_chain_id` | `uuid` | YES |  |
| 19 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 20 | `pending_since` | `timestamp with time zone` | YES |  |
| 21 | `delegate_activated_at` | `timestamp with time zone` | YES |  |
| 22 | `effective_assignee_user_id` | `uuid` | YES |  |
| 23 | `assignee_resolution_source` | `text` | YES |  |

### `lease_approvers` (6 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `approver_id` | `uuid` | NO |  |
| 4 | `approval_type` | `text` | NO |  |
| 5 | `approved_at` | `timestamp with time zone` | YES |  |
| 6 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_asc842_inputs` (40 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `tenant_improvement_allowance` | `numeric` | YES |  |
| 5 | `tenant_improvement_allowance_basis` | `text` | YES |  |
| 6 | `initial_direct_costs` | `numeric` | YES |  |
| 7 | `initial_direct_costs_basis` | `text` | YES |  |
| 8 | `prepaid_rent` | `numeric` | YES |  |
| 9 | `prepaid_rent_basis` | `text` | YES |  |
| 10 | `lease_incentives_received` | `numeric` | YES |  |
| 11 | `lease_incentives_received_basis` | `text` | YES |  |
| 12 | `residual_value_guarantee` | `numeric` | YES |  |
| 13 | `residual_value_guarantee_basis` | `text` | YES |  |
| 14 | `purchase_option_present` | `boolean` | YES |  |
| 15 | `purchase_option_price` | `numeric` | YES |  |
| 16 | `purchase_option_reasonably_certain` | `boolean` | YES |  |
| 17 | `purchase_option_basis` | `text` | YES |  |
| 18 | `termination_penalty_amount` | `numeric` | YES |  |
| 19 | `termination_penalty_reasonably_certain` | `boolean` | YES |  |
| 20 | `termination_penalty_basis` | `text` | YES |  |
| 21 | `ownership_transfers_at_end` | `boolean` | YES |  |
| 22 | `bargain_purchase_option` | `boolean` | YES |  |
| 23 | `major_part_economic_life` | `boolean` | YES |  |
| 24 | `major_part_economic_life_pct` | `numeric` | YES |  |
| 25 | `pv_substantially_all_fair_value` | `boolean` | YES |  |
| 26 | `pv_to_fair_value_pct` | `numeric` | YES |  |
| 27 | `asset_fair_value` | `numeric` | YES |  |
| 28 | `specialized_asset_no_alt_use` | `boolean` | YES |  |
| 29 | `classification_criteria_basis` | `text` | YES |  |
| 30 | `renewal_options_rc_term_months` | `integer` | YES |  |
| 31 | `renewal_options_rc_basis` | `text` | YES |  |
| 32 | `short_term_lease_election` | `boolean` | YES |  |
| 33 | `short_term_lease_election_basis` | `text` | YES |  |
| 34 | `variable_payments_description` | `text` | YES |  |
| 35 | `variable_payments_estimated_annual` | `numeric` | YES |  |
| 36 | `sublease_income_annual` | `numeric` | YES |  |
| 37 | `sublease_basis` | `text` | YES |  |
| 38 | `last_updated_at` | `timestamp with time zone` | NO | `now()` |
| 39 | `last_updated_by` | `uuid` | YES |  |
| 40 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_attribute_snapshots` (14 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `chain_resolution_at` | `timestamp with time zone` | NO | `now()` |
| 5 | `policy_id` | `uuid` | YES |  |
| 6 | `policy_version` | `integer` | YES |  |
| 7 | `asset_type` | `text` | YES |  |
| 8 | `lease_type` | `text` | YES |  |
| 9 | `requesting_department` | `text` | YES |  |
| 10 | `region` | `text` | YES |  |
| 11 | `monthly_payment` | `numeric` | YES |  |
| 12 | `annual_cost_at_snapshot` | `numeric` | YES |  |
| 13 | `raw_attributes` | `jsonb` | NO | `'{}'::jsonb` |
| 14 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_change_set_items` (8 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `change_set_id` | `uuid` | NO |  |
| 3 | `field_name` | `text` | NO |  |
| 4 | `field_label` | `text` | NO |  |
| 5 | `old_value` | `text` | YES |  |
| 6 | `proposed_value` | `text` | YES |  |
| 7 | `source_section` | `text` | YES |  |
| 8 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_change_sets` (15 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `unlock_request_id` | `uuid` | YES |  |
| 5 | `submitted_by` | `uuid` | NO |  |
| 6 | `status` | `text` | NO | `'draft'::text` |
| 7 | `change_summary` | `text` | YES |  |
| 8 | `submitted_at` | `timestamp with time zone` | YES |  |
| 9 | `reviewed_by` | `uuid` | YES |  |
| 10 | `reviewed_at` | `timestamp with time zone` | YES |  |
| 11 | `review_note` | `text` | YES |  |
| 12 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 13 | `updated_at` | `timestamp with time zone` | NO | `now()` |
| 14 | `self_approved` | `boolean` | NO | `false` |
| 15 | `requested_approver_id` | `uuid` | YES |  |

### `lease_documents` (17 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `document_type` | `text` | NO |  |
| 5 | `iteration_number` | `integer` | NO |  |
| 6 | `version_number` | `integer` | NO |  |
| 7 | `storage_path` | `text` | NO |  |
| 8 | `filename` | `text` | NO |  |
| 9 | `mime_type` | `text` | YES |  |
| 10 | `file_size_bytes` | `bigint` | YES |  |
| 11 | `uploaded_by` | `uuid` | NO |  |
| 12 | `uploaded_at` | `timestamp with time zone` | NO | `now()` |
| 13 | `notes` | `text` | YES |  |
| 14 | `is_current_latest` | `boolean` | NO | `false` |
| 15 | `superseded_by` | `uuid` | YES |  |
| 16 | `superseded_at` | `timestamp with time zone` | YES |  |
| 17 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_field_confidence` (7 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `field_name` | `text` | NO |  |
| 4 | `confidence_score` | `numeric` | NO |  |
| 5 | `was_corrected` | `boolean` | YES | `false` |
| 6 | `corrected_at` | `timestamp with time zone` | YES |  |
| 7 | `created_at` | `timestamp with time zone` | YES | `now()` |

### `lease_governance_audit` (17 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `event_type` | `text` | NO |  |
| 5 | `actor_user_id` | `uuid` | YES |  |
| 6 | `actor_email` | `text` | YES |  |
| 7 | `related_unlock_request_id` | `uuid` | YES |  |
| 8 | `related_change_set_id` | `uuid` | YES |  |
| 9 | `field_name` | `text` | YES |  |
| 10 | `field_label` | `text` | YES |  |
| 11 | `old_value` | `text` | YES |  |
| 12 | `proposed_value` | `text` | YES |  |
| 13 | `final_value` | `text` | YES |  |
| 14 | `change_summary` | `text` | YES |  |
| 15 | `rejection_reason` | `text` | YES |  |
| 16 | `cancellation_reason` | `text` | YES |  |
| 17 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_notifications` (11 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `event_type` | `text` | NO |  |
| 4 | `event_date` | `date` | NO |  |
| 5 | `event_description` | `text` | YES |  |
| 6 | `notify_days_before` | `int4[]` | NO | `'{90,60,30,14,7}'::integer[]` |
| 7 | `notify_email` | `boolean` | NO | `true` |
| 8 | `is_confirmed` | `boolean` | NO | `false` |
| 9 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 10 | `updated_at` | `timestamp with time zone` | NO | `now()` |
| 11 | `last_notified_at` | `timestamp with time zone` | YES |  |

### `lease_nudges` (6 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `sent_by` | `uuid` | YES |  |
| 4 | `nudge_type` | `text` | NO |  |
| 5 | `sent_at` | `timestamp with time zone` | NO | `now()` |
| 6 | `channel` | `text` | NO |  |

### `lease_reports` (21 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `report_type` | `text` | NO |  |
| 4 | `report_scope` | `text` | NO |  |
| 5 | `lease_id` | `uuid` | YES |  |
| 6 | `period_start` | `date` | YES |  |
| 7 | `period_end` | `date` | YES |  |
| 8 | `generated_at` | `timestamp with time zone` | NO | `now()` |
| 9 | `generated_by` | `uuid` | NO |  |
| 10 | `pdf_storage_path` | `text` | YES |  |
| 11 | `json_storage_path` | `text` | YES |  |
| 12 | `lease_count` | `integer` | NO | `0` |
| 13 | `excluded_lease_count` | `integer` | NO | `0` |
| 14 | `exclusion_reasons` | `jsonb` | NO | `'{}'::jsonb` |
| 15 | `organization_name_at_gen` | `text` | YES |  |
| 16 | `discount_rate_method_at_gen` | `text` | YES |  |
| 17 | `workspace_settings_snapshot` | `jsonb` | NO | `'{}'::jsonb` |
| 18 | `status` | `text` | NO | `'pending'::text` |
| 19 | `error_message` | `text` | YES |  |
| 20 | `expires_at` | `timestamp with time zone` | YES |  |
| 21 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_reroute_events` (20 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `triggered_by` | `uuid` | YES |  |
| 5 | `triggered_at` | `timestamp with time zone` | NO | `now()` |
| 6 | `trigger_reason` | `text` | NO |  |
| 7 | `prior_policy_id` | `uuid` | YES |  |
| 8 | `prior_policy_version` | `integer` | YES |  |
| 9 | `new_policy_id` | `uuid` | YES |  |
| 10 | `new_policy_version` | `integer` | YES |  |
| 11 | `changed_attributes` | `jsonb` | NO |  |
| 12 | `prior_lifecycle_status` | `text` | NO |  |
| 13 | `new_lifecycle_status` | `text` | NO |  |
| 14 | `steps_added_count` | `integer` | NO | `0` |
| 15 | `steps_superseded_count` | `integer` | NO | `0` |
| 16 | `steps_preserved_count` | `integer` | NO | `0` |
| 17 | `detection_mode` | `text` | NO |  |
| 18 | `resulted_in_chain_violation` | `boolean` | NO | `false` |
| 19 | `notes` | `text` | YES |  |
| 20 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `lease_state_transitions` (10 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `from_status` | `text` | YES |  |
| 4 | `to_status` | `text` | NO |  |
| 5 | `from_lifecycle` | `text` | YES |  |
| 6 | `to_lifecycle` | `text` | YES |  |
| 7 | `transitioned_by` | `uuid` | YES |  |
| 8 | `transition_reason` | `text` | YES |  |
| 9 | `metadata` | `jsonb` | YES | `'{}'::jsonb` |
| 10 | `created_at` | `timestamp with time zone` | YES | `now()` |

### `lease_unlock_requests` (11 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `requested_by` | `uuid` | NO |  |
| 5 | `request_reason` | `text` | NO |  |
| 6 | `status` | `text` | NO | `'pending'::text` |
| 7 | `reviewed_by` | `uuid` | YES |  |
| 8 | `reviewed_at` | `timestamp with time zone` | YES |  |
| 9 | `review_note` | `text` | YES |  |
| 10 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 11 | `updated_at` | `timestamp with time zone` | NO | `now()` |

### `leases` (136 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `user_id` | `uuid` | NO |  |
| 3 | `filename` | `text` | NO |  |
| 4 | `storage_path` | `text` | YES |  |
| 5 | `status` | `text` | NO | `'Uploaded'::text` |
| 6 | `error_message` | `text` | YES |  |
| 7 | `uploaded_at` | `timestamp with time zone` | NO | `now()` |
| 8 | `processed_at` | `timestamp with time zone` | YES |  |
| 9 | `extracted_json` | `jsonb` | YES |  |
| 10 | `landlord_name` | `text` | YES |  |
| 11 | `tenant_name` | `text` | YES |  |
| 12 | `lease_start` | `date` | YES |  |
| 13 | `lease_end` | `date` | YES |  |
| 14 | `base_rent_amount` | `text` | YES |  |
| 15 | `base_rent_frequency` | `text` | YES |  |
| 16 | `current_monthly_rent` | `numeric` | YES |  |
| 17 | `rent_escalation_type` | `text` | YES |  |
| 18 | `workspace_id` | `uuid` | YES |  |
| 19 | `square_footage` | `integer` | YES |  |
| 20 | `confirmed_sections` | `text[]` | NO | `'{}'::text[]` |
| 21 | `lifecycle_status` | `text` | YES | `'draft'::text` |
| 22 | `category` | `text` | YES |  |
| 23 | `business_unit` | `text` | YES |  |
| 24 | `estimated_term_min` | `integer` | YES |  |
| 25 | `estimated_term_max` | `integer` | YES |  |
| 26 | `estimated_monthly_cost_min` | `numeric` | YES |  |
| 27 | `estimated_monthly_cost_max` | `numeric` | YES |  |
| 28 | `lease_owner_id` | `uuid` | YES |  |
| 29 | `notes` | `text` | YES |  |
| 30 | `rejection_reason` | `text` | YES |  |
| 31 | `submitted_for_approval_at` | `timestamp with time zone` | YES |  |
| 32 | `internal_approved_at` | `timestamp with time zone` | YES |  |
| 33 | `execution_approved_at` | `timestamp with time zone` | YES |  |
| 34 | `activated_at` | `timestamp with time zone` | YES |  |
| 35 | `lease_type` | `text` | YES |  |
| 36 | `approver_email` | `text` | YES |  |
| 37 | `initializer_id` | `uuid` | YES |  |
| 38 | `confidence_scores` | `jsonb` | YES | `'{}'::jsonb` |
| 39 | `audit_log` | `jsonb` | YES | `'[]'::jsonb` |
| 40 | `last_nudged_at` | `timestamp with time zone` | YES |  |
| 41 | `parent_lease_id` | `uuid` | YES |  |
| 42 | `avg_confidence_score` | `numeric` | YES |  |
| 43 | `monthly_payment` | `numeric` | YES |  |
| 44 | `term_months` | `integer` | YES |  |
| 45 | `asset_type` | `text` | YES |  |
| 46 | `escalation_rate` | `numeric` | YES | `0` |
| 47 | `calc_total_commitment` | `numeric` | YES |  |
| 48 | `calc_pv_liability` | `numeric` | YES |  |
| 49 | `calc_straight_line_exp` | `numeric` | YES |  |
| 50 | `calc_cash_pl_delta` | `numeric` | YES |  |
| 51 | `lease_classification` | `text` | YES | `'pending'::text` |
| 52 | `covenant_flagged` | `boolean` | YES | `false` |
| 53 | `request_title` | `text` | YES |  |
| 54 | `requesting_department` | `text` | YES |  |
| 55 | `requestor_id` | `uuid` | YES |  |
| 56 | `request_urgency` | `text` | YES | `'standard'::text` |
| 57 | `expected_start_date` | `date` | YES |  |
| 58 | `request_description` | `text` | YES |  |
| 59 | `vendor_name` | `text` | YES |  |
| 60 | `manager_approved_by` | `uuid` | YES |  |
| 61 | `manager_approved_at` | `timestamp with time zone` | YES |  |
| 62 | `manager_rejection_reason` | `text` | YES |  |
| 63 | `financial_approved_by` | `uuid` | YES |  |
| 64 | `financial_approved_at` | `timestamp with time zone` | YES |  |
| 65 | `financial_rejection_reason` | `text` | YES |  |
| 66 | `financial_returned_to_submitter` | `boolean` | YES | `false` |
| 67 | `lease_classification_set_by` | `uuid` | YES |  |
| 68 | `lease_classification_set_at` | `timestamp with time zone` | YES |  |
| 69 | `status_changed_at` | `timestamp with time zone` | YES |  |
| 70 | `summary_share_token` | `text` | YES |  |
| 71 | `summary_shared_at` | `timestamp with time zone` | YES |  |
| 72 | `summary_last_viewed_at` | `timestamp with time zone` | YES |  |
| 73 | `executed_document_url` | `text` | YES |  |
| 74 | `executed_storage_path` | `text` | YES |  |
| 75 | `executed_filename` | `text` | YES |  |
| 76 | `executed_extracted_json` | `jsonb` | YES |  |
| 77 | `executed_extraction_confidence` | `jsonb` | YES | `'{}'::jsonb` |
| 78 | `executed_uploaded_at` | `timestamp with time zone` | YES |  |
| 79 | `executed_uploaded_by` | `uuid` | YES |  |
| 80 | `executed_monthly_payment` | `numeric` | YES |  |
| 81 | `executed_commencement_date` | `date` | YES |  |
| 82 | `executed_expiry_date` | `date` | YES |  |
| 83 | `executed_tenant_name` | `text` | YES |  |
| 84 | `executed_landlord_name` | `text` | YES |  |
| 85 | `executed_rent_review_clause` | `text` | YES |  |
| 86 | `executed_break_clause` | `text` | YES |  |
| 87 | `variance_monthly_payment` | `numeric` | YES |  |
| 88 | `variance_commencement_days` | `integer` | YES |  |
| 89 | `variance_expiry_days` | `integer` | YES |  |
| 90 | `variance_tenant_name_match` | `boolean` | YES |  |
| 91 | `variance_landlord_name_match` | `boolean` | YES |  |
| 92 | `variance_reviewed_at` | `timestamp with time zone` | YES |  |
| 93 | `variance_reviewed_by` | `uuid` | YES |  |
| 94 | `model_locked` | `boolean` | NO | `false` |
| 95 | `model_locked_at` | `timestamp with time zone` | YES |  |
| 96 | `model_locked_by` | `uuid` | YES |  |
| 97 | `escalation_type` | `text` | YES |  |
| 98 | `needs_escalation_review` | `boolean` | YES | `false` |
| 99 | `property_address` | `text` | YES |  |
| 100 | `rent_commencement_date` | `date` | YES |  |
| 101 | `security_deposit` | `text` | YES |  |
| 102 | `renewal_options` | `text` | YES |  |
| 103 | `escalation_clauses` | `text` | YES |  |
| 104 | `termination_clauses` | `text` | YES |  |
| 105 | `intake_source` | `text` | YES | `'manual_upload'::text` |
| 106 | `location` | `text` | YES |  |
| 107 | `building` | `text` | YES |  |
| 108 | `region` | `text` | YES |  |
| 109 | `unlock_requested` | `boolean` | NO | `false` |
| 110 | `unlock_requested_by` | `uuid` | YES |  |
| 111 | `unlock_requested_at` | `timestamp with time zone` | YES |  |
| 112 | `unlock_action_token` | `text` | YES |  |
| 113 | `unlock_token_expires_at` | `timestamp with time zone` | YES |  |
| 114 | `vendor_address_line1` | `text` | YES |  |
| 115 | `vendor_address_line2` | `text` | YES |  |
| 116 | `vendor_city` | `text` | YES |  |
| 117 | `vendor_state` | `text` | YES |  |
| 118 | `vendor_zip` | `text` | YES |  |
| 119 | `vendor_phone` | `text` | YES |  |
| 120 | `summary_share_token_expires_at` | `timestamp with time zone` | YES |  |
| 121 | `archived` | `boolean` | NO | `false` |
| 122 | `archived_at` | `timestamp with time zone` | YES |  |
| 123 | `archived_by` | `uuid` | YES |  |
| 124 | `concept_approved_at` | `timestamp with time zone` | YES |  |
| 125 | `signator_approved_at` | `timestamp with time zone` | YES |  |
| 126 | `counter_signed_at` | `timestamp with time zone` | YES |  |
| 127 | `fully_executed_at` | `timestamp with time zone` | YES |  |
| 128 | `execution_owner_id` | `uuid` | YES |  |
| 129 | `signator_attestation` | `text` | YES |  |
| 130 | `counter_signature_due_date` | `date` | YES |  |
| 131 | `counter_signature_reminder_count` | `integer` | NO | `0` |
| 132 | `reroute_evaluation_pending` | `boolean` | NO | `false` |
| 133 | `discount_rate` | `numeric` | YES |  |
| 134 | `discount_rate_basis` | `text` | YES |  |
| 135 | `discount_rate_set_at` | `timestamp with time zone` | YES |  |
| 136 | `discount_rate_set_by` | `uuid` | YES |  |

### `notifications` (9 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `user_id` | `uuid` | YES |  |
| 4 | `lease_id` | `uuid` | YES |  |
| 5 | `alert_type` | `text` | NO |  |
| 6 | `title` | `text` | NO |  |
| 7 | `body` | `text` | NO |  |
| 8 | `read_at` | `timestamp with time zone` | YES |  |
| 9 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `processing_rate_limits` (7 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `function_name` | `text` | NO |  |
| 4 | `window_start` | `timestamp with time zone` | NO |  |
| 5 | `request_count` | `integer` | NO | `1` |
| 6 | `updated_at` | `timestamp with time zone` | NO | `now()` |
| 7 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `profiles` (20 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO |  |
| 2 | `email` | `text` | YES |  |
| 3 | `plan` | `text` | NO | `'free'::text` |
| 4 | `processed_count` | `integer` | NO | `0` |
| 5 | `stripe_customer_id` | `text` | YES |  |
| 6 | `stripe_subscription_id` | `text` | YES |  |
| 7 | `subscription_status` | `text` | YES |  |
| 8 | `subscription_period_end` | `timestamp with time zone` | YES |  |
| 9 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 10 | `first_name` | `text` | YES |  |
| 11 | `last_name` | `text` | YES |  |
| 12 | `company_name` | `text` | YES |  |
| 13 | `timezone` | `text` | YES | `'America/New_York'::text` |
| 14 | `billing_interval` | `text` | NO | `'monthly'::text` |
| 15 | `trial_ends_at` | `timestamp with time zone` | YES |  |
| 16 | `email_notifications_enabled` | `boolean` | NO | `true` |
| 17 | `sms_notifications_enabled` | `boolean` | NO | `false` |
| 18 | `current_workspace_id` | `uuid` | YES |  |
| 19 | `ai_processing_consent_at` | `timestamp with time zone` | YES |  |
| 20 | `notify_abstraction_complete` | `boolean` | NO | `true` |

### `rent_schedules` (9 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `period_start` | `date` | NO |  |
| 4 | `period_end` | `date` | YES |  |
| 5 | `monthly_amount` | `numeric` | YES |  |
| 6 | `annual_amount` | `numeric` | YES |  |
| 7 | `notes` | `text` | YES |  |
| 8 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 9 | `updated_at` | `timestamp with time zone` | NO | `now()` |

### `risk_templates` (9 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | YES |  |
| 3 | `is_system` | `boolean` | NO | `false` |
| 4 | `title` | `text` | NO |  |
| 5 | `severity` | `text` | NO |  |
| 6 | `default_explanation` | `text` | NO |  |
| 7 | `asset_type` | `text` | YES |  |
| 8 | `created_by` | `uuid` | YES |  |
| 9 | `created_at` | `timestamp with time zone` | NO | `now()` |

### `risks` (14 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `title` | `text` | NO |  |
| 4 | `severity` | `text` | NO |  |
| 5 | `explanation` | `text` | YES |  |
| 6 | `citation_page` | `integer` | YES |  |
| 7 | `citation_snippet` | `text` | YES |  |
| 8 | `dismissed_at` | `timestamp with time zone` | YES |  |
| 9 | `dismissed_by` | `uuid` | YES |  |
| 10 | `dismissed_reason` | `text` | YES |  |
| 11 | `created_by` | `uuid` | YES |  |
| 12 | `is_user_added` | `boolean` | NO | `false` |
| 13 | `risk_template_id` | `uuid` | YES |  |
| 14 | `source_text_norm` | `text` | YES |  |

### `summary_views` (5 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `lease_id` | `uuid` | NO |  |
| 3 | `viewed_at` | `timestamp with time zone` | YES | `now()` |
| 4 | `viewer_ip` | `text` | YES |  |
| 5 | `referrer` | `text` | YES |  |

### `user_out_of_office` (10 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `user_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `starts_at` | `timestamp with time zone` | NO |  |
| 5 | `ends_at` | `timestamp with time zone` | NO |  |
| 6 | `delegate_user_id` | `uuid` | NO |  |
| 7 | `reason` | `text` | YES |  |
| 8 | `is_active` | `boolean` | NO | `true` |
| 9 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 10 | `updated_at` | `timestamp with time zone` | NO | `now()` |

### `user_preferences` (6 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `user_id` | `uuid` | NO |  |
| 3 | `workspace_id` | `uuid` | NO |  |
| 4 | `onboarding_dismissed_at` | `timestamp with time zone` | YES |  |
| 5 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 6 | `updated_at` | `timestamp with time zone` | NO | `now()` |

### `workspace_approvers` (6 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `user_id` | `uuid` | NO |  |
| 4 | `is_active` | `boolean` | NO | `true` |
| 5 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 6 | `created_by` | `uuid` | YES |  |

### `workspace_members` (8 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `user_id` | `uuid` | YES |  |
| 5 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 6 | `role` | `workspace_role` | NO | `'viewer'::workspace_role` |
| 7 | `invited_email` | `text` | YES |  |
| 8 | `invited_at` | `timestamp with time zone` | YES |  |
| 9 | `accepted_at` | `timestamp with time zone` | YES |  |

### `workspace_roles` (5 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `workspace_id` | `uuid` | NO |  |
| 3 | `user_id` | `uuid` | NO |  |
| 4 | `role` | `text` | NO |  |
| 5 | `created_at` | `timestamp with time zone` | YES | `now()` |

### `workspaces` (28 columns)

| # | column | type | null | default |
|---|---|---|---|---|
| 1 | `id` | `uuid` | NO | `gen_random_uuid()` |
| 2 | `name` | `text` | NO |  |
| 3 | `owner_id` | `uuid` | NO |  |
| 4 | `plan` | `text` | NO | `'pro'::text` |
| 5 | `document_limit` | `integer` | NO | `3` |
| 6 | `documents_used` | `integer` | NO | `0` |
| 7 | `timezone` | `text` | NO | `'America/New_York'::text` |
| 8 | `default_notification_days` | `integer` | NO | `90` |
| 9 | `created_at` | `timestamp with time zone` | NO | `now()` |
| 10 | `updated_at` | `timestamp with time zone` | NO | `now()` |
| 11 | `billing_interval` | `text` | NO | `'monthly'::text` |
| 12 | `discount_rate` | `numeric` | YES | `5.5` |
| 13 | `covenant_threshold` | `numeric` | YES |  |
| 14 | `approval_threshold` | `numeric` | YES | `0` |
| 15 | `backdoor_enabled` | `boolean` | NO | `false` |
| 16 | `asset_type_config` | `jsonb` | YES | `'["Real Estate", "Equipment", "Vehicle", "Other"]'::jsonb` |
| 17 | `department_options` | `jsonb` | NO | `'[]'::jsonb` |
| 18 | `region_options` | `jsonb` | NO | `'[]'::jsonb` |
| 19 | `location_options` | `jsonb` | NO | `'[]'::jsonb` |
| 20 | `building_options` | `jsonb` | NO | `'[]'::jsonb` |
| 21 | `max_archived_leases` | `integer` | YES |  |
| 22 | `separation_of_duties_default` | `boolean` | NO | `true` |
| 23 | `counter_signature_default_due_days` | `integer` | NO | `21` |
| 24 | `report_organization_name` | `text` | YES |  |
| 25 | `report_fiscal_year_start_month` | `integer` | NO | `1` |
| 26 | `report_rounding_precision` | `integer` | NO | `2` |
| 27 | `report_artifact_retention_days` | `integer` | NO | `90` |
| 28 | `report_default_discount_method` | `text` | YES | `'workspace_default'::text` |

---

## 2. Views

### `v_correction_analytics`

```sql
 SELECT field_name,
    count(*) AS total_corrections,
    avg(ai_confidence) AS avg_original_confidence,
    count(DISTINCT lease_id) AS leases_affected,
    max(corrected_at) AS last_correction
   FROM field_corrections fc
  GROUP BY field_name
  ORDER BY (count(*)) DESC;
```

### `v_governance_audit_report`

```sql
 SELECT gau.id,
    gau.created_at AS event_timestamp,
    gau.event_type,
    gau.workspace_id,
    gau.lease_id,
    COALESCE(l.request_title, l.filename, 'Unnamed lease'::text) AS lease_name,
    gau.actor_user_id,
    gau.actor_email,
    gau.related_unlock_request_id,
    gau.related_change_set_id,
    gau.field_name,
    gau.field_label,
    gau.old_value,
    gau.proposed_value,
    gau.final_value,
    gau.change_summary,
    gau.rejection_reason,
    gau.cancellation_reason
   FROM lease_governance_audit gau
     JOIN leases l ON l.id = gau.lease_id
  ORDER BY gau.created_at DESC;
```

### `v_lease_verification_audit`

```sql
 SELECT l.id AS lease_id,
    l.workspace_id,
    l.confirmed_sections,
    l.model_locked,
    l.model_locked_at,
    l.model_locked_by,
    l.lease_classification_set_at,
    l.lease_classification_set_by,
    COALESCE(l.discount_rate, w.discount_rate) AS discount_rate,
    l.discount_rate AS discount_rate_per_lease_override,
    w.discount_rate AS discount_rate_workspace_default,
    l.discount_rate_basis,
    l.discount_rate_set_at,
    l.discount_rate_set_by,
    l.signator_attestation,
    l.signator_approved_at,
    COALESCE(( SELECT jsonb_agg(jsonb_build_object('field_id', fc.field_name, 'original_value', fc.original_value, 'corrected_value', fc.corrected_value, 'correction_type', fc.correction_type, 'corrected_at', fc.corrected_at, 'corrected_by', fc.corrected_by, 'ai_confidence_at_correction', fc.ai_confidence) ORDER BY fc.corrected_at) AS jsonb_agg
           FROM field_corrections fc
          WHERE fc.lease_id = l.id), '[]'::jsonb) AS field_corrections
   FROM leases l
     LEFT JOIN workspaces w ON w.id = l.workspace_id;
```

### `v_review_queue`

```sql
 SELECT id,
    filename,
    tenant_name,
    landlord_name,
    status,
    avg_confidence_score,
    uploaded_at,
    user_id,
    workspace_id,
    COALESCE((extracted_json ->> '_fields_requiring_review'::text)::text[], '{}'::text[]) AS fields_requiring_review,
    array_length(COALESCE((extracted_json ->> '_fields_requiring_review'::text)::text[], '{}'::text[]), 1) AS review_field_count
   FROM leases l
  WHERE status = 'Needs Review'::text
  ORDER BY avg_confidence_score, uploaded_at;
```

---

## 3. Indexes

Primary-key indexes (named `<table>_pkey`) are omitted as they are implicit.

### `alert_rules`

- `alert_rules_workspace_id_alert_type_key` — `CREATE UNIQUE INDEX alert_rules_workspace_id_alert_type_key ON public.alert_rules USING btree (workspace_id, alert_type)`
- `idx_alert_rules_workspace` — `CREATE INDEX idx_alert_rules_workspace ON public.alert_rules USING btree (workspace_id)`

### `approval_chain_steps`

- `idx_approval_chain_steps_approver_user_id` — `CREATE INDEX idx_approval_chain_steps_approver_user_id ON public.approval_chain_steps USING btree (approver_user_id)`
- `idx_approval_chain_steps_delegate_user_id` — `CREATE INDEX idx_approval_chain_steps_delegate_user_id ON public.approval_chain_steps USING btree (delegate_user_id)`
- `idx_approval_chain_steps_policy` — `CREATE INDEX idx_approval_chain_steps_policy ON public.approval_chain_steps USING btree (policy_id, stage, step_order)`

### `approval_policies`

- `idx_approval_policies_created_by` — `CREATE INDEX idx_approval_policies_created_by ON public.approval_policies USING btree (created_by)`
- `idx_approval_policies_one_default_per_workspace` — `CREATE UNIQUE INDEX idx_approval_policies_one_default_per_workspace ON public.approval_policies USING btree (workspace_id) WHERE ((is_default_fallback = true) AND (is_active = true))`
- `idx_approval_policies_updated_by` — `CREATE INDEX idx_approval_policies_updated_by ON public.approval_policies USING btree (updated_by)`
- `idx_approval_policies_workspace_active` — `CREATE INDEX idx_approval_policies_workspace_active ON public.approval_policies USING btree (workspace_id, is_active)`

### `chain_step_overrides`

- `idx_chain_step_overrides_chain_step_id` — `CREATE INDEX idx_chain_step_overrides_chain_step_id ON public.chain_step_overrides USING btree (chain_step_id)`
- `idx_chain_step_overrides_lease` — `CREATE INDEX idx_chain_step_overrides_lease ON public.chain_step_overrides USING btree (lease_id, override_at DESC)`
- `idx_chain_step_overrides_override_by` — `CREATE INDEX idx_chain_step_overrides_override_by ON public.chain_step_overrides USING btree (override_by)`
- `idx_chain_step_overrides_prior_assignee_user_id` — `CREATE INDEX idx_chain_step_overrides_prior_assignee_user_id ON public.chain_step_overrides USING btree (prior_assignee_user_id)`
- `idx_chain_step_overrides_reassigned_to_user_id` — `CREATE INDEX idx_chain_step_overrides_reassigned_to_user_id ON public.chain_step_overrides USING btree (reassigned_to_user_id)`
- `idx_chain_step_overrides_workspace_recent` — `CREATE INDEX idx_chain_step_overrides_workspace_recent ON public.chain_step_overrides USING btree (workspace_id, override_at DESC)`

### `chain_step_voluntary_delegations`

- `idx_chain_step_voluntary_delegations_delegated_by` — `CREATE INDEX idx_chain_step_voluntary_delegations_delegated_by ON public.chain_step_voluntary_delegations USING btree (delegated_by)`
- `idx_chain_step_voluntary_delegations_delegated_to` — `CREATE INDEX idx_chain_step_voluntary_delegations_delegated_to ON public.chain_step_voluntary_delegations USING btree (delegated_to)`
- `idx_chain_step_voluntary_delegations_lease_id` — `CREATE INDEX idx_chain_step_voluntary_delegations_lease_id ON public.chain_step_voluntary_delegations USING btree (lease_id)`
- `idx_chain_step_voluntary_delegations_revoked_by` — `CREATE INDEX idx_chain_step_voluntary_delegations_revoked_by ON public.chain_step_voluntary_delegations USING btree (revoked_by)`
- `idx_chain_step_voluntary_delegations_workspace_id` — `CREATE INDEX idx_chain_step_voluntary_delegations_workspace_id ON public.chain_step_voluntary_delegations USING btree (workspace_id)`
- `idx_voluntary_delegations_active` — `CREATE INDEX idx_voluntary_delegations_active ON public.chain_step_voluntary_delegations USING btree (chain_step_id, delegated_at DESC) WHERE (revoked_at IS NULL)`
- `idx_voluntary_delegations_step` — `CREATE INDEX idx_voluntary_delegations_step ON public.chain_step_voluntary_delegations USING btree (chain_step_id)`

### `deleted_workspaces`

- `idx_deleted_workspaces_deleted_by` — `CREATE INDEX idx_deleted_workspaces_deleted_by ON public.deleted_workspaces USING btree (deleted_by)`
- `idx_deleted_workspaces_owner` — `CREATE INDEX idx_deleted_workspaces_owner ON public.deleted_workspaces USING btree (owner_id, deleted_at DESC)`

### `dismissed_events`

- `dismissed_events_user_id_workspace_id_event_key_key` — `CREATE UNIQUE INDEX dismissed_events_user_id_workspace_id_event_key_key ON public.dismissed_events USING btree (user_id, workspace_id, event_key)`
- `idx_dismissed_events_workspace_id` — `CREATE INDEX idx_dismissed_events_workspace_id ON public.dismissed_events USING btree (workspace_id)`

### `executed_term_edits`

- `idx_executed_term_edits_edited_by` — `CREATE INDEX idx_executed_term_edits_edited_by ON public.executed_term_edits USING btree (edited_by)`
- `idx_executed_term_edits_lease_id` — `CREATE INDEX idx_executed_term_edits_lease_id ON public.executed_term_edits USING btree (lease_id)`

### `field_corrections`

- `idx_corrections_created_at` — `CREATE INDEX idx_corrections_created_at ON public.field_corrections USING btree (corrected_at DESC)`
- `idx_corrections_field_name` — `CREATE INDEX idx_corrections_field_name ON public.field_corrections USING btree (field_name)`
- `idx_corrections_lease_id` — `CREATE INDEX idx_corrections_lease_id ON public.field_corrections USING btree (lease_id)`
- `idx_field_corrections_lease_id` — `CREATE INDEX idx_field_corrections_lease_id ON public.field_corrections USING btree (lease_id)`

### `invite_tokens`

- `invite_tokens_token_key` — `CREATE UNIQUE INDEX invite_tokens_token_key ON public.invite_tokens USING btree (token)`
- `invite_tokens_workspace_id_idx` — `CREATE INDEX invite_tokens_workspace_id_idx ON public.invite_tokens USING btree (workspace_id)`

### `lease_activity_log`

- `idx_lease_activity_log_lease_id` — `CREATE INDEX idx_lease_activity_log_lease_id ON public.lease_activity_log USING btree (lease_id)`
- `idx_lease_activity_log_user_id` — `CREATE INDEX idx_lease_activity_log_user_id ON public.lease_activity_log USING btree (user_id)`

### `lease_approval_actions`

- `idx_lease_approval_actions_approver_id` — `CREATE INDEX idx_lease_approval_actions_approver_id ON public.lease_approval_actions USING btree (approver_id)`
- `idx_lease_approval_actions_lease_id` — `CREATE INDEX idx_lease_approval_actions_lease_id ON public.lease_approval_actions USING btree (lease_id)`

### `lease_approval_chain`

- `idx_chain_pending_delegate_timer` — `CREATE INDEX idx_chain_pending_delegate_timer ON public.lease_approval_chain USING btree (pending_since) WHERE ((status = 'pending'::text) AND (delegate_user_id IS NOT NULL) AND (delegate_after_days IS NOT NULL) AND (delegate_activated_at IS NULL))`
- `idx_chain_pending_since` — `CREATE INDEX idx_chain_pending_since ON public.lease_approval_chain USING btree (pending_since) WHERE ((status = 'pending'::text) AND (pending_since IS NOT NULL))`
- `idx_lease_approval_chain_action_by` — `CREATE INDEX idx_lease_approval_chain_action_by ON public.lease_approval_chain USING btree (action_by)`
- `idx_lease_approval_chain_assignee_pending` — `CREATE INDEX idx_lease_approval_chain_assignee_pending ON public.lease_approval_chain USING btree (approver_user_id, status) WHERE (status = 'pending'::text)`
- `idx_lease_approval_chain_delegate_user_id` — `CREATE INDEX idx_lease_approval_chain_delegate_user_id ON public.lease_approval_chain USING btree (delegate_user_id)`
- `idx_lease_approval_chain_effective_assignee_user_id` — `CREATE INDEX idx_lease_approval_chain_effective_assignee_user_id ON public.lease_approval_chain USING btree (effective_assignee_user_id)`
- `idx_lease_approval_chain_lease` — `CREATE INDEX idx_lease_approval_chain_lease ON public.lease_approval_chain USING btree (lease_id, stage, step_order)`
- `idx_lease_approval_chain_policy_id` — `CREATE INDEX idx_lease_approval_chain_policy_id ON public.lease_approval_chain USING btree (policy_id)`
- `idx_lease_approval_chain_rerouted_from_chain_id` — `CREATE INDEX idx_lease_approval_chain_rerouted_from_chain_id ON public.lease_approval_chain USING btree (rerouted_from_chain_id)`
- `idx_lease_approval_chain_workspace_pending` — `CREATE INDEX idx_lease_approval_chain_workspace_pending ON public.lease_approval_chain USING btree (workspace_id, status) WHERE (status = 'pending'::text)`

### `lease_approvers`

- `idx_lease_approvers_approver_id` — `CREATE INDEX idx_lease_approvers_approver_id ON public.lease_approvers USING btree (approver_id)`
- `idx_lease_approvers_lease_id` — `CREATE INDEX idx_lease_approvers_lease_id ON public.lease_approvers USING btree (lease_id)`
- `lease_approvers_lease_id_approver_id_approval_type_key` — `CREATE UNIQUE INDEX lease_approvers_lease_id_approver_id_approval_type_key ON public.lease_approvers USING btree (lease_id, approver_id, approval_type)`

### `lease_asc842_inputs`

- `idx_lease_asc842_inputs_last_updated_by` — `CREATE INDEX idx_lease_asc842_inputs_last_updated_by ON public.lease_asc842_inputs USING btree (last_updated_by)`
- `idx_lease_asc842_inputs_workspace` — `CREATE INDEX idx_lease_asc842_inputs_workspace ON public.lease_asc842_inputs USING btree (workspace_id)`
- `lease_asc842_inputs_lease_id_key` — `CREATE UNIQUE INDEX lease_asc842_inputs_lease_id_key ON public.lease_asc842_inputs USING btree (lease_id)`

### `lease_attribute_snapshots`

- `idx_lease_attribute_snapshots_lease_chronological` — `CREATE INDEX idx_lease_attribute_snapshots_lease_chronological ON public.lease_attribute_snapshots USING btree (lease_id, chain_resolution_at DESC)`
- `idx_lease_attribute_snapshots_policy_id` — `CREATE INDEX idx_lease_attribute_snapshots_policy_id ON public.lease_attribute_snapshots USING btree (policy_id)`
- `idx_lease_attribute_snapshots_workspace_id` — `CREATE INDEX idx_lease_attribute_snapshots_workspace_id ON public.lease_attribute_snapshots USING btree (workspace_id)`

### `lease_change_set_items`

- `idx_lease_change_set_items_change_set_id` — `CREATE INDEX idx_lease_change_set_items_change_set_id ON public.lease_change_set_items USING btree (change_set_id)`
- `lease_change_set_items_change_set_field_unique` — `CREATE UNIQUE INDEX lease_change_set_items_change_set_field_unique ON public.lease_change_set_items USING btree (change_set_id, field_name)`

### `lease_change_sets`

- `idx_lease_change_sets_lease_id` — `CREATE INDEX idx_lease_change_sets_lease_id ON public.lease_change_sets USING btree (lease_id)`
- `idx_lease_change_sets_reviewed_by` — `CREATE INDEX idx_lease_change_sets_reviewed_by ON public.lease_change_sets USING btree (reviewed_by)`
- `idx_lease_change_sets_submitted_by` — `CREATE INDEX idx_lease_change_sets_submitted_by ON public.lease_change_sets USING btree (submitted_by)`
- `idx_lease_change_sets_workspace_status` — `CREATE INDEX idx_lease_change_sets_workspace_status ON public.lease_change_sets USING btree (workspace_id, status)`
- `lease_change_sets_requested_approver_id_idx` — `CREATE INDEX lease_change_sets_requested_approver_id_idx ON public.lease_change_sets USING btree (requested_approver_id) WHERE (requested_approver_id IS NOT NULL)`
- `lease_change_sets_unlock_request_id_idx` — `CREATE INDEX lease_change_sets_unlock_request_id_idx ON public.lease_change_sets USING btree (unlock_request_id) WHERE (unlock_request_id IS NOT NULL)`

### `lease_documents`

- `idx_lease_documents_lease_chronological` — `CREATE INDEX idx_lease_documents_lease_chronological ON public.lease_documents USING btree (lease_id, iteration_number, version_number)`
- `idx_lease_documents_one_current_latest_per_lease` — `CREATE UNIQUE INDEX idx_lease_documents_one_current_latest_per_lease ON public.lease_documents USING btree (lease_id) WHERE (is_current_latest = true)`
- `idx_lease_documents_superseded_by` — `CREATE INDEX idx_lease_documents_superseded_by ON public.lease_documents USING btree (superseded_by)`
- `idx_lease_documents_uploaded_by` — `CREATE INDEX idx_lease_documents_uploaded_by ON public.lease_documents USING btree (uploaded_by)`
- `idx_lease_documents_workspace` — `CREATE INDEX idx_lease_documents_workspace ON public.lease_documents USING btree (workspace_id)`

### `lease_field_confidence`

- `idx_field_confidence_lease_id` — `CREATE INDEX idx_field_confidence_lease_id ON public.lease_field_confidence USING btree (lease_id)`
- `idx_field_confidence_low_scores` — `CREATE INDEX idx_field_confidence_low_scores ON public.lease_field_confidence USING btree (confidence_score) WHERE (confidence_score < 0.85)`
- `idx_lease_field_confidence_lease_id` — `CREATE INDEX idx_lease_field_confidence_lease_id ON public.lease_field_confidence USING btree (lease_id)`
- `idx_lease_field_confidence_score` — `CREATE INDEX idx_lease_field_confidence_score ON public.lease_field_confidence USING btree (confidence_score)`
- `lease_field_confidence_lease_id_field_name_key` — `CREATE UNIQUE INDEX lease_field_confidence_lease_id_field_name_key ON public.lease_field_confidence USING btree (lease_id, field_name)`

### `lease_governance_audit`

- `idx_governance_audit_change_set_id` — `CREATE INDEX idx_governance_audit_change_set_id ON public.lease_governance_audit USING btree (related_change_set_id) WHERE (related_change_set_id IS NOT NULL)`
- `idx_governance_audit_lease_id` — `CREATE INDEX idx_governance_audit_lease_id ON public.lease_governance_audit USING btree (lease_id, created_at DESC)`
- `idx_governance_audit_workspace_id` — `CREATE INDEX idx_governance_audit_workspace_id ON public.lease_governance_audit USING btree (workspace_id, created_at DESC)`
- `lease_governance_audit_actor_user_id_idx` — `CREATE INDEX lease_governance_audit_actor_user_id_idx ON public.lease_governance_audit USING btree (actor_user_id) WHERE (actor_user_id IS NOT NULL)`
- `lease_governance_audit_related_unlock_request_id_idx` — `CREATE INDEX lease_governance_audit_related_unlock_request_id_idx ON public.lease_governance_audit USING btree (related_unlock_request_id) WHERE (related_unlock_request_id IS NOT NULL)`

### `lease_notifications`

- `idx_lease_notifications_confirmed` — `CREATE INDEX idx_lease_notifications_confirmed ON public.lease_notifications USING btree (is_confirmed) WHERE (is_confirmed = true)`
- `idx_lease_notifications_event_date` — `CREATE INDEX idx_lease_notifications_event_date ON public.lease_notifications USING btree (event_date)`
- `idx_lease_notifications_lease_id` — `CREATE INDEX idx_lease_notifications_lease_id ON public.lease_notifications USING btree (lease_id)`

### `lease_nudges`

- `idx_lease_nudges_lease_id` — `CREATE INDEX idx_lease_nudges_lease_id ON public.lease_nudges USING btree (lease_id)`
- `idx_lease_nudges_sent_by` — `CREATE INDEX idx_lease_nudges_sent_by ON public.lease_nudges USING btree (sent_by)`

### `lease_reports`

- `idx_lease_reports_generated_by` — `CREATE INDEX idx_lease_reports_generated_by ON public.lease_reports USING btree (generated_by)`
- `idx_lease_reports_lease` — `CREATE INDEX idx_lease_reports_lease ON public.lease_reports USING btree (lease_id, generated_at DESC) WHERE (lease_id IS NOT NULL)`
- `idx_lease_reports_period` — `CREATE INDEX idx_lease_reports_period ON public.lease_reports USING btree (workspace_id, period_start, period_end) WHERE (period_start IS NOT NULL)`
- `idx_lease_reports_workspace_chronological` — `CREATE INDEX idx_lease_reports_workspace_chronological ON public.lease_reports USING btree (workspace_id, generated_at DESC)`

### `lease_reroute_events`

- `idx_lease_reroute_events_lease_chronological` — `CREATE INDEX idx_lease_reroute_events_lease_chronological ON public.lease_reroute_events USING btree (lease_id, triggered_at DESC)`
- `idx_lease_reroute_events_new_policy_id` — `CREATE INDEX idx_lease_reroute_events_new_policy_id ON public.lease_reroute_events USING btree (new_policy_id)`
- `idx_lease_reroute_events_prior_policy_id` — `CREATE INDEX idx_lease_reroute_events_prior_policy_id ON public.lease_reroute_events USING btree (prior_policy_id)`
- `idx_lease_reroute_events_triggered_by` — `CREATE INDEX idx_lease_reroute_events_triggered_by ON public.lease_reroute_events USING btree (triggered_by)`
- `idx_lease_reroute_events_workspace_chain_violations` — `CREATE INDEX idx_lease_reroute_events_workspace_chain_violations ON public.lease_reroute_events USING btree (workspace_id, triggered_at) WHERE (resulted_in_chain_violation = true)`

### `lease_state_transitions`

- `idx_state_transitions_date` — `CREATE INDEX idx_state_transitions_date ON public.lease_state_transitions USING btree (created_at DESC)`
- `idx_state_transitions_lease` — `CREATE INDEX idx_state_transitions_lease ON public.lease_state_transitions USING btree (lease_id)`
- `idx_state_transitions_user` — `CREATE INDEX idx_state_transitions_user ON public.lease_state_transitions USING btree (transitioned_by)`

### `lease_unlock_requests`

- `idx_lease_unlock_requests_lease_id` — `CREATE INDEX idx_lease_unlock_requests_lease_id ON public.lease_unlock_requests USING btree (lease_id)`
- `idx_lease_unlock_requests_requested_by` — `CREATE INDEX idx_lease_unlock_requests_requested_by ON public.lease_unlock_requests USING btree (requested_by)`
- `idx_lease_unlock_requests_reviewed_by` — `CREATE INDEX idx_lease_unlock_requests_reviewed_by ON public.lease_unlock_requests USING btree (reviewed_by)`
- `idx_lease_unlock_requests_workspace_status` — `CREATE INDEX idx_lease_unlock_requests_workspace_status ON public.lease_unlock_requests USING btree (workspace_id, status)`

### `leases`

- `idx_leases_archived_by` — `CREATE INDEX idx_leases_archived_by ON public.leases USING btree (archived_by)`
- `idx_leases_avg_confidence` — `CREATE INDEX idx_leases_avg_confidence ON public.leases USING btree (avg_confidence_score) WHERE (avg_confidence_score IS NOT NULL)`
- `idx_leases_discount_rate_set_at` — `CREATE INDEX idx_leases_discount_rate_set_at ON public.leases USING btree (workspace_id, discount_rate_set_at DESC) WHERE (discount_rate IS NOT NULL)`
- `idx_leases_discount_rate_set_by` — `CREATE INDEX idx_leases_discount_rate_set_by ON public.leases USING btree (discount_rate_set_by)`
- `idx_leases_executed_uploaded_by` — `CREATE INDEX idx_leases_executed_uploaded_by ON public.leases USING btree (executed_uploaded_by)`
- `idx_leases_execution_owner_id` — `CREATE INDEX idx_leases_execution_owner_id ON public.leases USING btree (execution_owner_id)`
- `idx_leases_financial_approved_by` — `CREATE INDEX idx_leases_financial_approved_by ON public.leases USING btree (financial_approved_by)`
- `idx_leases_lease_classification_set_by` — `CREATE INDEX idx_leases_lease_classification_set_by ON public.leases USING btree (lease_classification_set_by)`
- `idx_leases_lease_owner_id` — `CREATE INDEX idx_leases_lease_owner_id ON public.leases USING btree (lease_owner_id)`
- `idx_leases_lifecycle_status` — `CREATE INDEX idx_leases_lifecycle_status ON public.leases USING btree (lifecycle_status)`
- `idx_leases_manager_approved_by` — `CREATE INDEX idx_leases_manager_approved_by ON public.leases USING btree (manager_approved_by)`
- `idx_leases_model_locked` — `CREATE INDEX idx_leases_model_locked ON public.leases USING btree (model_locked) WHERE (model_locked = true)`
- `idx_leases_model_locked_by` — `CREATE INDEX idx_leases_model_locked_by ON public.leases USING btree (model_locked_by)`
- `idx_leases_parent_lease_id` — `CREATE INDEX idx_leases_parent_lease_id ON public.leases USING btree (parent_lease_id) WHERE (parent_lease_id IS NOT NULL)`
- `idx_leases_review_queue` — `CREATE INDEX idx_leases_review_queue ON public.leases USING btree (user_id, status, avg_confidence_score) WHERE (status = 'Needs Review'::text)`
- `idx_leases_status` — `CREATE INDEX idx_leases_status ON public.leases USING btree (status)`
- `idx_leases_unlock_requested_by` — `CREATE INDEX idx_leases_unlock_requested_by ON public.leases USING btree (unlock_requested_by)`
- `idx_leases_user_status` — `CREATE INDEX idx_leases_user_status ON public.leases USING btree (user_id, status)`
- `idx_leases_variance_reviewed_by` — `CREATE INDEX idx_leases_variance_reviewed_by ON public.leases USING btree (variance_reviewed_by)`
- `idx_leases_workspace_id` — `CREATE INDEX idx_leases_workspace_id ON public.leases USING btree (workspace_id)`
- `leases_archived_workspace_idx` — `CREATE INDEX leases_archived_workspace_idx ON public.leases USING btree (workspace_id, archived)`
- `leases_summary_share_token_expires_at_idx` — `CREATE INDEX leases_summary_share_token_expires_at_idx ON public.leases USING btree (summary_share_token_expires_at) WHERE (summary_share_token_expires_at IS NOT NULL)`
- `leases_summary_share_token_key` — `CREATE UNIQUE INDEX leases_summary_share_token_key ON public.leases USING btree (summary_share_token)`

### `notifications`

- `idx_notifications_lease` — `CREATE INDEX idx_notifications_lease ON public.notifications USING btree (lease_id)`
- `idx_notifications_unread` — `CREATE INDEX idx_notifications_unread ON public.notifications USING btree (workspace_id, user_id) WHERE (read_at IS NULL)`
- `idx_notifications_user` — `CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id)`
- `idx_notifications_workspace` — `CREATE INDEX idx_notifications_workspace ON public.notifications USING btree (workspace_id)`

### `processing_rate_limits`

- `processing_rate_limits_workspace_id_function_name_window_st_key` — `CREATE UNIQUE INDEX processing_rate_limits_workspace_id_function_name_window_st_key ON public.processing_rate_limits USING btree (workspace_id, function_name, window_start)`

### `rent_schedules`

- `idx_rent_schedules_lease_id` — `CREATE INDEX idx_rent_schedules_lease_id ON public.rent_schedules USING btree (lease_id)`
- `idx_rent_schedules_period` — `CREATE INDEX idx_rent_schedules_period ON public.rent_schedules USING btree (period_start, period_end)`

### `risk_templates`

- `idx_risk_templates_created_by` — `CREATE INDEX idx_risk_templates_created_by ON public.risk_templates USING btree (created_by)`
- `risk_templates_asset_type_idx` — `CREATE INDEX risk_templates_asset_type_idx ON public.risk_templates USING btree (asset_type) WHERE (asset_type IS NOT NULL)`
- `risk_templates_workspace_idx` — `CREATE INDEX risk_templates_workspace_idx ON public.risk_templates USING btree (workspace_id, is_system)`

### `risks`

- `idx_risks_created_by` — `CREATE INDEX idx_risks_created_by ON public.risks USING btree (created_by)`
- `idx_risks_dismissed_by` — `CREATE INDEX idx_risks_dismissed_by ON public.risks USING btree (dismissed_by)`
- `risks_dismissed_at_idx` — `CREATE INDEX risks_dismissed_at_idx ON public.risks USING btree (lease_id, dismissed_at)`
- `risks_is_user_added_idx` — `CREATE INDEX risks_is_user_added_idx ON public.risks USING btree (lease_id, is_user_added)`
- `risks_risk_template_id_idx` — `CREATE INDEX risks_risk_template_id_idx ON public.risks USING btree (risk_template_id) WHERE (risk_template_id IS NOT NULL)`

### `summary_views`

- `summary_views_lease_id_idx` — `CREATE INDEX summary_views_lease_id_idx ON public.summary_views USING btree (lease_id)`

### `user_out_of_office`

- `idx_user_ooo_active_window` — `CREATE INDEX idx_user_ooo_active_window ON public.user_out_of_office USING btree (user_id, workspace_id, starts_at, ends_at) WHERE (is_active = true)`
- `idx_user_out_of_office_delegate_user_id` — `CREATE INDEX idx_user_out_of_office_delegate_user_id ON public.user_out_of_office USING btree (delegate_user_id)`
- `idx_user_out_of_office_workspace_id` — `CREATE INDEX idx_user_out_of_office_workspace_id ON public.user_out_of_office USING btree (workspace_id)`

### `user_preferences`

- `idx_user_preferences_workspace_id` — `CREATE INDEX idx_user_preferences_workspace_id ON public.user_preferences USING btree (workspace_id)`
- `user_preferences_user_id_workspace_id_key` — `CREATE UNIQUE INDEX user_preferences_user_id_workspace_id_key ON public.user_preferences USING btree (user_id, workspace_id)`

### `workspace_approvers`

- `idx_workspace_approvers_created_by` — `CREATE INDEX idx_workspace_approvers_created_by ON public.workspace_approvers USING btree (created_by)`
- `idx_workspace_approvers_user_id` — `CREATE INDEX idx_workspace_approvers_user_id ON public.workspace_approvers USING btree (user_id)`
- `idx_workspace_approvers_workspace_id` — `CREATE INDEX idx_workspace_approvers_workspace_id ON public.workspace_approvers USING btree (workspace_id)`
- `workspace_approvers_workspace_id_user_id_key` — `CREATE UNIQUE INDEX workspace_approvers_workspace_id_user_id_key ON public.workspace_approvers USING btree (workspace_id, user_id)`

### `workspace_members`

- `idx_workspace_members_user_id` — `CREATE INDEX idx_workspace_members_user_id ON public.workspace_members USING btree (user_id)`
- `workspace_members_workspace_id_user_id_key` — `CREATE UNIQUE INDEX workspace_members_workspace_id_user_id_key ON public.workspace_members USING btree (workspace_id, user_id)`

### `workspace_roles`

- `idx_workspace_roles_user_id` — `CREATE INDEX idx_workspace_roles_user_id ON public.workspace_roles USING btree (user_id)`
- `workspace_roles_workspace_id_user_id_role_key` — `CREATE UNIQUE INDEX workspace_roles_workspace_id_user_id_role_key ON public.workspace_roles USING btree (workspace_id, user_id, role)`

### `workspaces`

- `idx_workspaces_owner_id` — `CREATE INDEX idx_workspaces_owner_id ON public.workspaces USING btree (owner_id)`

---

## 4. CHECK constraints

### `approval_chain_steps`

- `approval_chain_steps_approver_role_check` — `CHECK ((approver_role = ANY (ARRAY['submitter'::text, 'manager_approver'::text, 'financial_approver'::text, 'signator'::text, 'admin'::text])))`
- `approval_chain_steps_delegate_after_days_check` — `CHECK (((delegate_after_days IS NULL) OR (delegate_after_days > 0)))`
- `approval_chain_steps_stage_check` — `CHECK ((stage = ANY (ARRAY['concept'::text, 'signator'::text])))`
- `one_assignee_method` — `CHECK ((((approver_user_id IS NOT NULL) AND (approver_role IS NULL)) OR ((approver_user_id IS NULL) AND (approver_role IS NOT NULL))))`

### `approval_policies`

- `cost_range_valid` — `CHECK (((match_min_annual_cost IS NULL) OR (match_max_annual_cost IS NULL) OR (match_min_annual_cost <= match_max_annual_cost)))`

### `chain_step_overrides`

- `chain_step_overrides_override_action_check` — `CHECK ((override_action = ANY (ARRAY['approve'::text, 'reject'::text, 'send_back'::text, 'reassign'::text, 'cancel_step'::text])))`
- `chain_step_overrides_override_reason_check` — `CHECK ((length(TRIM(BOTH FROM override_reason)) >= 20))`

### `chain_step_voluntary_delegations`

- `vd_no_self_delegation` — `CHECK ((delegated_by <> delegated_to))`

### `field_corrections`

- `field_corrections_correction_type_check` — `CHECK ((correction_type = ANY (ARRAY['edit'::text, 'add_missing'::text, 'delete_wrong'::text])))`

### `lease_activity_log`

- `lease_activity_log_activity_type_check` — `CHECK ((activity_type = ANY (ARRAY['status_change'::text, 'approval'::text, 'rejection'::text, 'send_back'::text, 'pause'::text, 'nudge_sent'::text, 'document_upload'::text, 'created'::text, 'comment'::text, 'executed_uploaded'::text, 'executed_terms_extracted'::text, 'unlock_approved'::text, 'unlock_requested'::text, 'change_canceled'::text, 'change_set_submitted'::text, 'change_set_approved'::text, 'change_set_rejected'::text, 'change_set_self_approved'::text, 'risk_dismissed'::text, 'risk_restored'::text, 'risk_added'::text, 'change_submitted'::text, 'change_approved'::text, 'change_rejected'::text, 'chain_resolved'::text, 'chain_step_approved'::text, 'chain_step_rejected'::text, 'chain_step_sent_back'::text, 'chain_stage_completed'::text, 'chain_resolution_failed'::text, 'concept_stage_entered'::text, 'concept_stage_completed'::text, 'negotiation_stage_entered'::text, 'final_review_stage_entered'::text, 'pending_counter_signature_started'::text, 'fully_executed_recorded'::text, 'concept_approver_escalation_requested'::text, 'final_review_advanced'::text, 'document_uploaded_with_metadata'::text, 'document_iteration_started'::text, 'document_version_bumped'::text, 'signator_attestation_recorded'::text, 'execution_owner_assigned'::text, 'counter_signature_recorded'::text, 'counter_signature_reminder_sent'::text, 'counter_signature_overdue_recorded'::text, 'signator_review_decline'::text, 'execution_owner_reassigned'::text, 'attribute_change_detected'::text, 'chain_rerouted'::text, 'chain_reroute_skipped_no_match'::text, 'chain_violation_entered'::text, 'chain_violation_resolved'::text, 'reroute_audit_run'::text, 'manual_reroute_requested'::text, 'manual_reroute_approved'::text, 'manual_reroute_rejected'::text, 'voluntary_delegation_set'::text, 'voluntary_delegation_revoked'::text, 'admin_override_executed'::text, 'out_of_office_declared'::text, 'out_of_office_revoked'::text, 'delegate_timer_activated'::text, 'delegate_timer_started'::text, 'step_pending_started'::text, 'stuck_chain_detected'::text, 'stuck_chain_resolved'::text, 'deactivated_approver_handled'::text, 'chain_step_overridden'::text, 'chain_step_admin_reassigned'::text, 'report_generation_requested'::text, 'report_generation_completed'::text, 'report_generation_failed'::text, 'report_downloaded'::text, 'report_expired'::text, 'report_deleted'::text, 'discount_rate_set'::text, 'discount_rate_cleared'::text, 'asc842_inputs_updated'::text])))`

### `lease_approval_actions`

- `lease_approval_actions_action_check` — `CHECK ((action = ANY (ARRAY['approve'::text, 'send_back'::text, 'reject'::text, 'pause'::text])))`
- `lease_approval_actions_approval_type_check` — `CHECK ((approval_type = ANY (ARRAY['internal'::text, 'execution'::text])))`

### `lease_approval_chain`

- `chain_assignee_present` — `CHECK (((approver_user_id IS NOT NULL) OR (approver_role IS NOT NULL)))`
- `lease_approval_chain_assignee_source_check` — `CHECK (((assignee_resolution_source IS NULL) OR (assignee_resolution_source = ANY (ARRAY['policy_user'::text, 'policy_role'::text, 'policy_delegate'::text, 'ooo_delegate'::text, 'voluntary_delegate'::text, 'admin_reassign'::text]))))`
- `lease_approval_chain_stage_check` — `CHECK ((stage = ANY (ARRAY['concept'::text, 'signator'::text])))`
- `lease_approval_chain_status_check` — `CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'sent_back'::text, 'superseded'::text, 'delegated'::text, 'skipped'::text])))`

### `lease_approvers`

- `lease_approvers_approval_type_check` — `CHECK ((approval_type = ANY (ARRAY['internal'::text, 'execution'::text])))`

### `lease_asc842_inputs`

- `asc842_inputs_amounts_non_negative` — `CHECK ((((tenant_improvement_allowance IS NULL) OR (tenant_improvement_allowance >= (0)::numeric)) AND ((initial_direct_costs IS NULL) OR (initial_direct_costs >= (0)::numeric)) AND ((prepaid_rent IS NULL) OR (prepaid_rent >= (0)::numeric)) AND ((lease_incentives_received IS NULL) OR (lease_incentives_received >= (0)::numeric)) AND ((residual_value_guarantee IS NULL) OR (residual_value_guarantee >= (0)::numeric)) AND ((purchase_option_price IS NULL) OR (purchase_option_price >= (0)::numeric)) AND ((termination_penalty_amount IS NULL) OR (termination_penalty_amount >= (0)::numeric)) AND ((asset_fair_value IS NULL) OR (asset_fair_value >= (0)::numeric)) AND ((variable_payments_estimated_annual IS NULL) OR (variable_payments_estimated_annual >= (0)::numeric)) AND ((sublease_income_annual IS NULL) OR (sublease_income_annual >= (0)::numeric))))`
- `asc842_inputs_pct_range` — `CHECK ((((major_part_economic_life_pct IS NULL) OR ((major_part_economic_life_pct >= (0)::numeric) AND (major_part_economic_life_pct <= (100)::numeric))) AND ((pv_to_fair_value_pct IS NULL) OR ((pv_to_fair_value_pct >= (0)::numeric) AND (pv_to_fair_value_pct <= (100)::numeric)))))`
- `asc842_inputs_renewal_term_non_negative` — `CHECK (((renewal_options_rc_term_months IS NULL) OR (renewal_options_rc_term_months >= 0)))`

### `lease_change_sets`

- `lease_change_sets_status_check` — `CHECK ((status = ANY (ARRAY['draft'::text, 'pending_approval'::text, 'approved'::text, 'rejected'::text, 'canceled'::text])))`

### `lease_documents`

- `lease_documents_document_type_check` — `CHECK ((document_type = ANY (ARRAY['concept_attachment'::text, 'loi'::text, 'draft'::text, 'redline'::text, 'counter_redline'::text, 'final_negotiated'::text, 'our_signed'::text, 'fully_executed_counterparty_returned'::text, 'amendment'::text, 'side_letter'::text, 'other'::text])))`

### `lease_governance_audit`

- `lease_governance_audit_event_type_check` — `CHECK ((event_type = ANY (ARRAY['unlock_requested'::text, 'unlock_approved'::text, 'unlock_rejected'::text, 'change_set_created'::text, 'field_change_staged'::text, 'change_set_submitted'::text, 'change_set_approved'::text, 'field_change_committed'::text, 'change_set_rejected'::text, 'change_set_canceled'::text, 'lease_relocked'::text, 'change_set_self_approved'::text])))`

### `lease_notifications`

- `lease_notifications_event_type_check` — `CHECK ((event_type = ANY (ARRAY['expiration'::text, 'escalation'::text, 'renewal_window'::text, 'commencement'::text, 'custom'::text, 'new_request'::text, 'status_changed'::text, 'document_uploaded'::text])))`

### `lease_nudges`

- `lease_nudges_channel_check` — `CHECK ((channel = ANY (ARRAY['in_app'::text, 'email'::text, 'sms'::text])))`
- `lease_nudges_nudge_type_check` — `CHECK ((nudge_type = ANY (ARRAY['manual'::text, 'automatic_day2'::text, 'automatic_day5'::text, 'automatic_day10'::text])))`

### `lease_reports`

- `lease_reports_report_scope_check` — `CHECK ((report_scope = ANY (ARRAY['single_lease'::text, 'monthly'::text, 'quarterly'::text, 'annual'::text, 'custom_range'::text])))`
- `lease_reports_report_type_check` — `CHECK ((report_type = ANY (ARRAY['lease_disclosure'::text, 'portfolio_period'::text])))`
- `lease_reports_status_check` — `CHECK ((status = ANY (ARRAY['pending'::text, 'generating'::text, 'ready'::text, 'failed'::text, 'expired'::text])))`
- `report_scope_lease_id_correlation` — `CHECK ((((report_scope = 'single_lease'::text) AND (lease_id IS NOT NULL) AND (period_start IS NULL) AND (period_end IS NULL)) OR ((report_scope = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text, 'custom_range'::text])) AND (lease_id IS NULL) AND (period_start IS NOT NULL) AND (period_end IS NOT NULL) AND (period_start <= period_end))))`

### `lease_reroute_events`

- `lease_reroute_events_detection_mode_check` — `CHECK ((detection_mode = ANY (ARRAY['auto'::text, 'manual_admin'::text, 'manual_audit'::text])))`

### `lease_unlock_requests`

- `lease_unlock_requests_status_check` — `CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'canceled'::text])))`

### `leases`

- `leases_category_check` — `CHECK ((category = ANY (ARRAY['property'::text, 'equipment'::text, 'vehicle'::text, 'other'::text])))`
- `leases_discount_rate_range` — `CHECK (((discount_rate IS NULL) OR ((discount_rate > (0)::numeric) AND (discount_rate <= (50)::numeric))))`
- `leases_intake_source_check` — `CHECK ((intake_source = ANY (ARRAY['request_workflow'::text, 'email_intake'::text, 'backdoor'::text, 'manual_upload'::text, 'audit'::text])))`
- `leases_lifecycle_status_check` — `CHECK ((lifecycle_status = ANY (ARRAY['draft'::text, 'submitted'::text, 'under_review'::text, 'approved'::text, 'executed'::text, 'active'::text, 'expired'::text, 'rejected'::text, 'cancelled'::text, 'concept_submitted'::text, 'concept_under_review'::text, 'in_negotiation'::text, 'final_review'::text, 'pending_counter_signature'::text, 'fully_executed'::text, 'chain_violation'::text])))`
- `leases_signator_attestation_required` — `CHECK (((signator_approved_at IS NULL) OR ((signator_approved_at IS NOT NULL) AND (signator_attestation IS NOT NULL) AND (length(TRIM(BOTH FROM signator_attestation)) > 0))))`
- `leases_status_check` — `CHECK ((status = ANY (ARRAY['Uploaded'::text, 'Processing'::text, 'Ready'::text, 'Failed'::text, 'Needs Review'::text])))`
- `leases_type_check` — `CHECK (((lease_type IS NULL) OR (lease_type = ANY (ARRAY['Real Estate'::text, 'Equipment'::text, 'master'::text, 'amendment'::text]))))`

### `profiles`

- `profiles_plan_check` — `CHECK ((plan = ANY (ARRAY['free'::text, 'starter'::text, 'pro'::text, 'business'::text])))`

### `risk_templates`

- `risk_templates_scope_check` — `CHECK ((((is_system = true) AND (workspace_id IS NULL)) OR ((is_system = false) AND (workspace_id IS NOT NULL))))`
- `risk_templates_severity_check` — `CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))`

### `risks`

- `risks_severity_check` — `CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text])))`

### `user_out_of_office`

- `ooo_no_self_delegation` — `CHECK ((user_id <> delegate_user_id))`
- `ooo_valid_window` — `CHECK ((starts_at < ends_at))`

### `workspace_roles`

- `workspace_roles_role_check` — `CHECK ((role = ANY (ARRAY['submitter'::text, 'manager_approver'::text, 'financial_approver'::text, 'signator'::text, 'admin'::text])))`

### `workspaces`

- `workspaces_counter_signature_due_days_range` — `CHECK (((counter_signature_default_due_days >= 1) AND (counter_signature_default_due_days <= 365)))`
- `workspaces_report_artifact_retention_days_check` — `CHECK (((report_artifact_retention_days >= 1) AND (report_artifact_retention_days <= 730)))`
- `workspaces_report_default_discount_method_check` — `CHECK ((report_default_discount_method = ANY (ARRAY['workspace_default'::text, 'risk_free_rate'::text, 'incremental_borrowing_rate'::text, 'custom'::text])))`
- `workspaces_report_fiscal_year_start_month_check` — `CHECK (((report_fiscal_year_start_month >= 1) AND (report_fiscal_year_start_month <= 12)))`
- `workspaces_report_rounding_precision_check` — `CHECK (((report_rounding_precision >= 0) AND (report_rounding_precision <= 6)))`

---

## 5. Foreign keys

Format: `child_table.column → parent_table.column [cascade]`. Parsed from `pg_get_constraintdef` output.

### `alert_rules`

- `alert_rules_workspace_id_fkey`: `alert_rules.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `approval_chain_steps`

- `approval_chain_steps_approver_user_id_fkey`: `approval_chain_steps.approver_user_id` → `auth.users.id`
- `approval_chain_steps_delegate_user_id_fkey`: `approval_chain_steps.delegate_user_id` → `auth.users.id`
- `approval_chain_steps_policy_id_fkey`: `approval_chain_steps.policy_id` → `approval_policies.id` ON DELETE CASCADE

### `approval_policies`

- `approval_policies_created_by_fkey`: `approval_policies.created_by` → `auth.users.id`
- `approval_policies_updated_by_fkey`: `approval_policies.updated_by` → `auth.users.id`
- `approval_policies_workspace_id_fkey`: `approval_policies.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `chain_step_overrides`

- `chain_step_overrides_chain_step_id_fkey`: `chain_step_overrides.chain_step_id` → `lease_approval_chain.id` ON DELETE CASCADE
- `chain_step_overrides_lease_id_fkey`: `chain_step_overrides.lease_id` → `leases.id` ON DELETE CASCADE
- `chain_step_overrides_override_by_fkey`: `chain_step_overrides.override_by` → `auth.users.id`
- `chain_step_overrides_prior_assignee_user_id_fkey`: `chain_step_overrides.prior_assignee_user_id` → `auth.users.id`
- `chain_step_overrides_reassigned_to_user_id_fkey`: `chain_step_overrides.reassigned_to_user_id` → `auth.users.id`
- `chain_step_overrides_workspace_id_fkey`: `chain_step_overrides.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `chain_step_voluntary_delegations`

- `chain_step_voluntary_delegations_chain_step_id_fkey`: `chain_step_voluntary_delegations.chain_step_id` → `lease_approval_chain.id` ON DELETE CASCADE
- `chain_step_voluntary_delegations_delegated_by_fkey`: `chain_step_voluntary_delegations.delegated_by` → `auth.users.id`
- `chain_step_voluntary_delegations_delegated_to_fkey`: `chain_step_voluntary_delegations.delegated_to` → `auth.users.id`
- `chain_step_voluntary_delegations_lease_id_fkey`: `chain_step_voluntary_delegations.lease_id` → `leases.id` ON DELETE CASCADE
- `chain_step_voluntary_delegations_revoked_by_fkey`: `chain_step_voluntary_delegations.revoked_by` → `auth.users.id`
- `chain_step_voluntary_delegations_workspace_id_fkey`: `chain_step_voluntary_delegations.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `deleted_workspaces`

- `deleted_workspaces_deleted_by_fkey`: `deleted_workspaces.deleted_by` → `auth.users.id`

### `dismissed_events`

- `dismissed_events_user_id_fkey`: `dismissed_events.user_id` → `auth.users.id` ON DELETE CASCADE
- `dismissed_events_workspace_id_fkey`: `dismissed_events.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `executed_term_edits`

- `executed_term_edits_edited_by_fkey`: `executed_term_edits.edited_by` → `auth.users.id`
- `executed_term_edits_lease_id_fkey`: `executed_term_edits.lease_id` → `leases.id` ON DELETE CASCADE

### `field_corrections`

- `field_corrections_lease_id_fkey`: `field_corrections.lease_id` → `leases.id` ON DELETE CASCADE

### `invite_tokens`

- `invite_tokens_workspace_id_fkey`: `invite_tokens.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_activity_log`

- `lease_activity_log_lease_id_fkey`: `lease_activity_log.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_activity_log_user_id_fkey`: `lease_activity_log.user_id` → `profiles.id` ON DELETE SET NULL

### `lease_approval_actions`

- `lease_approval_actions_approver_id_fkey`: `lease_approval_actions.approver_id` → `auth.users.id`
- `lease_approval_actions_lease_id_fkey`: `lease_approval_actions.lease_id` → `leases.id` ON DELETE CASCADE

### `lease_approval_chain`

- `lease_approval_chain_action_by_fkey`: `lease_approval_chain.action_by` → `auth.users.id`
- `lease_approval_chain_approver_user_id_fkey`: `lease_approval_chain.approver_user_id` → `auth.users.id`
- `lease_approval_chain_delegate_user_id_fkey`: `lease_approval_chain.delegate_user_id` → `auth.users.id`
- `lease_approval_chain_effective_assignee_user_id_fkey`: `lease_approval_chain.effective_assignee_user_id` → `auth.users.id`
- `lease_approval_chain_lease_id_fkey`: `lease_approval_chain.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_approval_chain_policy_id_fkey`: `lease_approval_chain.policy_id` → `approval_policies.id`
- `lease_approval_chain_rerouted_from_chain_id_fkey`: `lease_approval_chain.rerouted_from_chain_id` → `lease_approval_chain.id`
- `lease_approval_chain_workspace_id_fkey`: `lease_approval_chain.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_approvers`

- `lease_approvers_approver_id_fkey`: `lease_approvers.approver_id` → `auth.users.id`
- `lease_approvers_lease_id_fkey`: `lease_approvers.lease_id` → `leases.id` ON DELETE CASCADE

### `lease_asc842_inputs`

- `lease_asc842_inputs_last_updated_by_fkey`: `lease_asc842_inputs.last_updated_by` → `auth.users.id`
- `lease_asc842_inputs_lease_id_fkey`: `lease_asc842_inputs.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_asc842_inputs_workspace_id_fkey`: `lease_asc842_inputs.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_attribute_snapshots`

- `lease_attribute_snapshots_lease_id_fkey`: `lease_attribute_snapshots.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_attribute_snapshots_policy_id_fkey`: `lease_attribute_snapshots.policy_id` → `approval_policies.id`
- `lease_attribute_snapshots_workspace_id_fkey`: `lease_attribute_snapshots.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_change_set_items`

- `lease_change_set_items_change_set_id_fkey`: `lease_change_set_items.change_set_id` → `lease_change_sets.id` ON DELETE CASCADE

### `lease_change_sets`

- `lease_change_sets_lease_id_fkey`: `lease_change_sets.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_change_sets_requested_approver_id_fkey`: `lease_change_sets.requested_approver_id` → `auth.users.id` ON DELETE SET NULL
- `lease_change_sets_reviewed_by_fkey`: `lease_change_sets.reviewed_by` → `auth.users.id`
- `lease_change_sets_submitted_by_fkey`: `lease_change_sets.submitted_by` → `auth.users.id`
- `lease_change_sets_unlock_request_id_fkey`: `lease_change_sets.unlock_request_id` → `lease_unlock_requests.id`
- `lease_change_sets_workspace_id_fkey`: `lease_change_sets.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_documents`

- `lease_documents_lease_id_fkey`: `lease_documents.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_documents_superseded_by_fkey`: `lease_documents.superseded_by` → `lease_documents.id`
- `lease_documents_uploaded_by_fkey`: `lease_documents.uploaded_by` → `auth.users.id`
- `lease_documents_workspace_id_fkey`: `lease_documents.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_field_confidence`

- `lease_field_confidence_lease_id_fkey`: `lease_field_confidence.lease_id` → `leases.id` ON DELETE CASCADE

### `lease_governance_audit`

- `lease_governance_audit_actor_user_id_fkey`: `lease_governance_audit.actor_user_id` → `auth.users.id`
- `lease_governance_audit_lease_id_fkey`: `lease_governance_audit.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_governance_audit_related_change_set_id_fkey`: `lease_governance_audit.related_change_set_id` → `lease_change_sets.id`
- `lease_governance_audit_related_unlock_request_id_fkey`: `lease_governance_audit.related_unlock_request_id` → `lease_unlock_requests.id`
- `lease_governance_audit_workspace_id_fkey`: `lease_governance_audit.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_notifications`

- `lease_notifications_lease_id_fkey`: `lease_notifications.lease_id` → `leases.id` ON DELETE CASCADE

### `lease_nudges`

- `lease_nudges_lease_id_fkey`: `lease_nudges.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_nudges_sent_by_fkey`: `lease_nudges.sent_by` → `auth.users.id`

### `lease_reports`

- `lease_reports_generated_by_fkey`: `lease_reports.generated_by` → `auth.users.id`
- `lease_reports_lease_id_fkey`: `lease_reports.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_reports_workspace_id_fkey`: `lease_reports.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_reroute_events`

- `lease_reroute_events_lease_id_fkey`: `lease_reroute_events.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_reroute_events_new_policy_id_fkey`: `lease_reroute_events.new_policy_id` → `approval_policies.id`
- `lease_reroute_events_prior_policy_id_fkey`: `lease_reroute_events.prior_policy_id` → `approval_policies.id`
- `lease_reroute_events_triggered_by_fkey`: `lease_reroute_events.triggered_by` → `auth.users.id`
- `lease_reroute_events_workspace_id_fkey`: `lease_reroute_events.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `lease_state_transitions`

- `lease_state_transitions_lease_id_fkey`: `lease_state_transitions.lease_id` → `leases.id` ON DELETE CASCADE

### `lease_unlock_requests`

- `lease_unlock_requests_lease_id_fkey`: `lease_unlock_requests.lease_id` → `leases.id` ON DELETE CASCADE
- `lease_unlock_requests_requested_by_fkey`: `lease_unlock_requests.requested_by` → `auth.users.id`
- `lease_unlock_requests_reviewed_by_fkey`: `lease_unlock_requests.reviewed_by` → `auth.users.id`
- `lease_unlock_requests_workspace_id_fkey`: `lease_unlock_requests.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `leases`

- `leases_archived_by_fkey`: `leases.archived_by` → `auth.users.id`
- `leases_discount_rate_set_by_fkey`: `leases.discount_rate_set_by` → `auth.users.id`
- `leases_executed_uploaded_by_fkey`: `leases.executed_uploaded_by` → `auth.users.id`
- `leases_execution_owner_id_fkey`: `leases.execution_owner_id` → `auth.users.id`
- `leases_financial_approved_by_fkey`: `leases.financial_approved_by` → `auth.users.id`
- `leases_lease_classification_set_by_fkey`: `leases.lease_classification_set_by` → `auth.users.id`
- `leases_lease_owner_id_fkey`: `leases.lease_owner_id` → `auth.users.id`
- `leases_manager_approved_by_fkey`: `leases.manager_approved_by` → `auth.users.id`
- `leases_model_locked_by_fkey`: `leases.model_locked_by` → `auth.users.id`
- `leases_parent_lease_id_fkey`: `leases.parent_lease_id` → `leases.id`
- `leases_unlock_requested_by_fkey`: `leases.unlock_requested_by` → `auth.users.id`
- `leases_user_id_fkey`: `leases.user_id` → `profiles.id` ON DELETE CASCADE
- `leases_variance_reviewed_by_fkey`: `leases.variance_reviewed_by` → `auth.users.id`
- `leases_workspace_id_fkey`: `leases.workspace_id` → `workspaces.id` ON DELETE SET NULL

### `notifications`

- `notifications_lease_id_fkey`: `notifications.lease_id` → `leases.id` ON DELETE SET NULL
- `notifications_user_id_fkey`: `notifications.user_id` → `auth.users.id` ON DELETE CASCADE
- `notifications_workspace_id_fkey`: `notifications.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `processing_rate_limits`

- `processing_rate_limits_workspace_id_fkey`: `processing_rate_limits.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `profiles`

- `profiles_id_fkey`: `profiles.id` → `auth.users.id` ON DELETE CASCADE

### `rent_schedules`

- `rent_schedules_lease_id_fkey`: `rent_schedules.lease_id` → `leases.id` ON DELETE CASCADE

### `risk_templates`

- `risk_templates_created_by_fkey`: `risk_templates.created_by` → `auth.users.id` ON DELETE SET NULL
- `risk_templates_workspace_id_fkey`: `risk_templates.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `risks`

- `risks_created_by_fkey`: `risks.created_by` → `auth.users.id` ON DELETE SET NULL
- `risks_dismissed_by_fkey`: `risks.dismissed_by` → `auth.users.id` ON DELETE SET NULL
- `risks_lease_id_fkey`: `risks.lease_id` → `leases.id` ON DELETE CASCADE
- `risks_risk_template_id_fkey`: `risks.risk_template_id` → `risk_templates.id` ON DELETE SET NULL

### `summary_views`

- `summary_views_lease_id_fkey`: `summary_views.lease_id` → `leases.id` ON DELETE CASCADE

### `user_out_of_office`

- `user_out_of_office_delegate_user_id_fkey`: `user_out_of_office.delegate_user_id` → `auth.users.id`
- `user_out_of_office_user_id_fkey`: `user_out_of_office.user_id` → `auth.users.id` ON DELETE CASCADE
- `user_out_of_office_workspace_id_fkey`: `user_out_of_office.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `user_preferences`

- `user_preferences_user_id_fkey`: `user_preferences.user_id` → `auth.users.id` ON DELETE CASCADE
- `user_preferences_workspace_id_fkey`: `user_preferences.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `workspace_approvers`

- `workspace_approvers_created_by_fkey`: `workspace_approvers.created_by` → `auth.users.id`
- `workspace_approvers_user_id_fkey`: `workspace_approvers.user_id` → `auth.users.id` ON DELETE CASCADE
- `workspace_approvers_workspace_id_fkey`: `workspace_approvers.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `workspace_members`

- `workspace_members_user_id_fkey`: `workspace_members.user_id` → `auth.users.id` ON DELETE CASCADE
- `workspace_members_workspace_id_fkey`: `workspace_members.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `workspace_roles`

- `workspace_roles_user_id_fkey`: `workspace_roles.user_id` → `auth.users.id` ON DELETE CASCADE
- `workspace_roles_workspace_id_fkey`: `workspace_roles.workspace_id` → `workspaces.id` ON DELETE CASCADE

### `workspaces`

- `workspaces_owner_id_fkey`: `workspaces.owner_id` → `auth.users.id` ON DELETE CASCADE

---

## 6. RLS policies

All policies are `PERMISSIVE`. Empty `USING` / `WITH CHECK` cells mean the column was NULL in `pg_policies` (unconditional or not applicable for the cmd).

### `alert_rules`

**alert_rules_manage** — cmd `ALL`, roles `{public}`

USING:
```
((workspace_id IN ( SELECT wm.workspace_id
   FROM workspace_members wm
  WHERE ((wm.user_id = auth.uid()) AND (wm.role = 'admin'::workspace_role)))) OR (workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid()))))
```
WITH CHECK:
```
((workspace_id IN ( SELECT wm.workspace_id
   FROM workspace_members wm
  WHERE ((wm.user_id = auth.uid()) AND (wm.role = 'admin'::workspace_role)))) OR (workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid()))))
```

**alert_rules_select** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())))
```


### `approval_chain_steps`

**admins write steps via policy** — cmd `ALL`, roles `{public}`

USING:
```
(policy_id IN ( SELECT approval_policies.id
   FROM approval_policies
  WHERE (approval_policies.workspace_id IN ( SELECT workspaces.id
           FROM workspaces
          WHERE (workspaces.owner_id = auth.uid())
        UNION
         SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))))
```
WITH CHECK:
```
(policy_id IN ( SELECT approval_policies.id
   FROM approval_policies
  WHERE (approval_policies.workspace_id IN ( SELECT workspaces.id
           FROM workspaces
          WHERE (workspaces.owner_id = auth.uid())
        UNION
         SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))))
```

**members read steps via policy** — cmd `SELECT`, roles `{public}`

USING:
```
(policy_id IN ( SELECT approval_policies.id
   FROM approval_policies
  WHERE (approval_policies.workspace_id IN ( SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE (workspace_members.user_id = auth.uid())
        UNION
         SELECT workspaces.id
           FROM workspaces
          WHERE (workspaces.owner_id = auth.uid())))))
```


### `approval_policies`

**workspace admins write policies** — cmd `ALL`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```
WITH CHECK:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```

**workspace members read policies** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `chain_step_overrides`

**chain_step_overrides_select** — cmd `SELECT`, roles `{authenticated}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `chain_step_voluntary_delegations`

**voluntary_delegations_select** — cmd `SELECT`, roles `{authenticated}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `deleted_workspaces`

**Owners view own workspace deletions** — cmd `SELECT`, roles `{public}`

USING:
```
((owner_id = auth.uid()) OR (deleted_by = auth.uid()))
```


### `dismissed_events`

**Users can manage their own dismissed events** — cmd `ALL`, roles `{public}`

USING:
```
(auth.uid() = user_id)
```
WITH CHECK:
```
(auth.uid() = user_id)
```


### `executed_term_edits`

**financial_approver_insert_term_edits** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
((edited_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (leases l
     JOIN workspace_roles wr ON (((wr.workspace_id = l.workspace_id) AND (wr.user_id = auth.uid()))))
  WHERE ((l.id = executed_term_edits.lease_id) AND (wr.role = ANY (ARRAY['financial_approver'::text, 'admin'::text]))))))
```

**workspace_members_select_term_edits** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = executed_term_edits.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `field_corrections`

**Users can insert corrections for their leases** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = field_corrections.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**Users can view corrections for their workspace leases** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = field_corrections.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `invite_tokens`

**Owners can create workspace invites** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
is_workspace_owner(workspace_id, auth.uid())
```

**Owners can delete workspace invites** — cmd `DELETE`, roles `{public}`

USING:
```
is_workspace_owner(workspace_id, auth.uid())
```

**Owners can view workspace invites** — cmd `SELECT`, roles `{public}`

USING:
```
is_workspace_owner(workspace_id, auth.uid())
```

**Users can view invites sent to them** — cmd `SELECT`, roles `{public}`

USING:
```
(email = (( SELECT users.email
   FROM auth.users
  WHERE (users.id = auth.uid())))::text)
```


### `lease_activity_log`

**Users can create activity entries** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(((user_id = auth.uid()) OR (user_id IS NULL)) AND (EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_activity_log.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid()))))))
```

**Users can view activity for their leases** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_activity_log.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `lease_approval_actions`

**Approvers can create approval actions** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
((approver_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM lease_approvers la
  WHERE ((la.lease_id = lease_approval_actions.lease_id) AND (la.approver_id = auth.uid())))))
```

**Users can view approval actions for their leases** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_approval_actions.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `lease_approval_chain`

**admins update chain in workspace** — cmd `UPDATE`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```
WITH CHECK:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```

**assignee acts on own pending step** — cmd `UPDATE`, roles `{public}`

USING:
```
((status = 'pending'::text) AND ((approver_user_id = auth.uid()) OR ((approver_role IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM workspace_roles wr
  WHERE ((wr.workspace_id = lease_approval_chain.workspace_id) AND (wr.user_id = auth.uid()) AND (wr.role = lease_approval_chain.approver_role)))))))
```
WITH CHECK:
```
((action_by = auth.uid()) AND (status = ANY (ARRAY['approved'::text, 'rejected'::text, 'sent_back'::text])))
```

**workspace members read chain** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `lease_approvers`

**Lease owners and admins can assign approvers** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_approvers.lease_id) AND ((l.user_id = auth.uid()) OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'::workspace_role)))))
```

**Lease owners and admins can remove approvers** — cmd `DELETE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_approvers.lease_id) AND ((l.user_id = auth.uid()) OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'::workspace_role)))))
```

**Users can view lease approvers for their leases** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_approvers.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**lease_approvers_update** — cmd `UPDATE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_approvers.lease_id) AND ((l.user_id = auth.uid()) OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'::workspace_role)))))
```
WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_approvers.lease_id) AND ((l.user_id = auth.uid()) OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'::workspace_role)))))
```


### `lease_asc842_inputs`

**editors and admins update asc842 inputs** — cmd `UPDATE`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['admin'::workspace_role, 'editor'::workspace_role])))
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```
WITH CHECK:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['admin'::workspace_role, 'editor'::workspace_role])))
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```

**editors and admins write asc842 inputs** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['admin'::workspace_role, 'editor'::workspace_role])))
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```

**workspace members read asc842 inputs** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `lease_attribute_snapshots`

**lease_attribute_snapshots_select** — cmd `SELECT`, roles `{authenticated}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `lease_change_set_items`

**workspace members can delete change set items** — cmd `DELETE`, roles `{public}`

USING:
```
(change_set_id IN ( SELECT lease_change_sets.id
   FROM lease_change_sets
  WHERE (lease_change_sets.workspace_id IN ( SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE (workspace_members.user_id = auth.uid())))))
```

**workspace members can insert change set items** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(change_set_id IN ( SELECT lease_change_sets.id
   FROM lease_change_sets
  WHERE (lease_change_sets.workspace_id IN ( SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE (workspace_members.user_id = auth.uid())))))
```

**workspace members can update change set items** — cmd `UPDATE`, roles `{public}`

USING:
```
(change_set_id IN ( SELECT lease_change_sets.id
   FROM lease_change_sets
  WHERE (lease_change_sets.workspace_id IN ( SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE (workspace_members.user_id = auth.uid())))))
```
WITH CHECK:
```
(change_set_id IN ( SELECT lease_change_sets.id
   FROM lease_change_sets
  WHERE (lease_change_sets.workspace_id IN ( SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE (workspace_members.user_id = auth.uid())))))
```

**workspace members can view change set items** — cmd `SELECT`, roles `{public}`

USING:
```
(change_set_id IN ( SELECT lease_change_sets.id
   FROM lease_change_sets
  WHERE (lease_change_sets.workspace_id IN ( SELECT workspace_members.workspace_id
           FROM workspace_members
          WHERE (workspace_members.user_id = auth.uid())))))
```


### `lease_change_sets`

**lease_change_sets_delete** — cmd `DELETE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_change_sets.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**submitters and approvers can update change sets** — cmd `UPDATE`, roles `{public}`

USING:
```
((submitted_by = auth.uid()) OR (workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role)))) OR (workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid()))) OR (workspace_id IN ( SELECT workspace_roles.workspace_id
   FROM workspace_roles
  WHERE ((workspace_roles.user_id = auth.uid()) AND (workspace_roles.role = 'financial_approver'::text)))))
```

**workspace members can create change sets** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())))
```

**workspace members can view change sets** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())))
```


### `lease_documents`

**admins delete documents** — cmd `DELETE`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```

**admins manage documents** — cmd `UPDATE`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```

**submitters and admins write documents** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['admin'::workspace_role, 'editor'::workspace_role])))
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid()))) AND (uploaded_by = auth.uid()) AND (lease_id IN ( SELECT leases.id
   FROM leases
  WHERE (leases.workspace_id = lease_documents.workspace_id))))
```

**workspace members read documents** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `lease_field_confidence`

**Users can insert field confidence for their leases** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_field_confidence.lease_id) AND (l.user_id = auth.uid()))))
```

**Users can view field confidence for their leases** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_field_confidence.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `lease_governance_audit`

**workspace members can insert governance audit** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())))
```

**workspace members can view governance audit** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())))
```


### `lease_notifications`

**Users can create notifications for their leases** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases
  WHERE ((leases.id = lease_notifications.lease_id) AND (leases.user_id = auth.uid()))))
```

**Users can delete notifications for their leases** — cmd `DELETE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases
  WHERE ((leases.id = lease_notifications.lease_id) AND (leases.user_id = auth.uid()))))
```

**Users can update notifications for their leases** — cmd `UPDATE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases
  WHERE ((leases.id = lease_notifications.lease_id) AND (leases.user_id = auth.uid()))))
```

**Users can view notifications for their leases** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases
  WHERE ((leases.id = lease_notifications.lease_id) AND (leases.user_id = auth.uid()))))
```


### `lease_nudges`

**Lease owners and admins can send nudges** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_nudges.lease_id) AND ((l.user_id = auth.uid()) OR (l.lease_owner_id = auth.uid()) OR has_workspace_permission(l.workspace_id, auth.uid(), 'admin'::workspace_role)))))
```

**Users can view nudges for their leases** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_nudges.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `lease_reports`

**admins delete reports** — cmd `DELETE`, roles `{authenticated}`

USING:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```

**members initiate reports** — cmd `INSERT`, roles `{authenticated}`

WITH CHECK:
```
((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = ANY (ARRAY['admin'::workspace_role, 'editor'::workspace_role])))
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid()))) AND (generated_by = auth.uid()))
```

**workspace members read reports** — cmd `SELECT`, roles `{authenticated}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `lease_reroute_events`

**lease_reroute_events_select** — cmd `SELECT`, roles `{authenticated}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```


### `lease_state_transitions`

**Users can insert transitions for their leases** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(((transitioned_by = auth.uid()) OR (transitioned_by IS NULL)) AND (EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_state_transitions.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid()))))))
```

**Users view transitions in workspace** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_state_transitions.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `lease_unlock_requests`

**admins and requesters can update unlock requests** — cmd `UPDATE`, roles `{public}`

USING:
```
((requested_by = auth.uid()) OR (workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role)))) OR (workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid()))))
```

**lease_unlock_requests_delete** — cmd `DELETE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = lease_unlock_requests.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**workspace members can create unlock requests** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())))
```

**workspace members can view unlock requests** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())))
```


### `leases`

**Users can insert leases** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
((auth.uid() = user_id) AND ((workspace_id IS NULL) OR is_workspace_member(workspace_id, auth.uid())))
```

**leases_delete_own_or_workspace_admin** — cmd `DELETE`, roles `{public}`

USING:
```
((user_id = auth.uid()) OR has_workspace_permission(workspace_id, auth.uid(), 'admin'::workspace_role))
```

**leases_select_own_or_workspace** — cmd `SELECT`, roles `{public}`

USING:
```
((user_id = auth.uid()) OR is_workspace_member(workspace_id, auth.uid()))
```

**leases_update_own_or_workspace_editor** — cmd `UPDATE`, roles `{public}`

USING:
```
((user_id = auth.uid()) OR has_workspace_permission(workspace_id, auth.uid(), 'editor'::workspace_role) OR (EXISTS ( SELECT 1
   FROM workspace_roles wr
  WHERE ((wr.workspace_id = leases.workspace_id) AND (wr.user_id = auth.uid()) AND (wr.role = ANY (ARRAY['manager_approver'::text, 'financial_approver'::text, 'admin'::text]))))))
```


### `notifications`

**notifications_delete** — cmd `DELETE`, roles `{public}`

USING:
```
((user_id = auth.uid()) OR (user_id IS NULL))
```

**notifications_select** — cmd `SELECT`, roles `{public}`

USING:
```
((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid()))) AND ((user_id = auth.uid()) OR (user_id IS NULL)))
```

**notifications_service_insert** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```

**notifications_update_read** — cmd `UPDATE`, roles `{public}`

USING:
```
((user_id = auth.uid()) OR (user_id IS NULL))
```
WITH CHECK:
```
((user_id = auth.uid()) OR (user_id IS NULL))
```


### `processing_rate_limits`

**Service role only** — cmd `ALL`, roles `{public}`

USING:
```
false
```
WITH CHECK:
```
false
```


### `profiles`

**profiles_delete_self** — cmd `DELETE`, roles `{public}`

USING:
```
(id = auth.uid())
```

**profiles_insert_own** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(id = auth.uid())
```

**profiles_insert_self** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
true
```

**profiles_select_own_or_coworker** — cmd `SELECT`, roles `{public}`

USING:
```
((id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.user_id = profiles.id) AND is_workspace_member(wm.workspace_id, auth.uid())))) OR (EXISTS ( SELECT 1
   FROM workspaces w
  WHERE ((w.owner_id = profiles.id) AND is_workspace_member(w.id, auth.uid())))))
```

**profiles_update_own** — cmd `UPDATE`, roles `{public}`

USING:
```
(id = auth.uid())
```

**profiles_update_self** — cmd `UPDATE`, roles `{public}`

USING:
```
(id = auth.uid())
```
WITH CHECK:
```
((id = auth.uid()) AND ((current_workspace_id IS NULL) OR is_workspace_member(current_workspace_id, auth.uid())))
```


### `rent_schedules`

**rent_schedules_delete** — cmd `DELETE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = rent_schedules.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**rent_schedules_insert** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = rent_schedules.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**rent_schedules_select** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = rent_schedules.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**rent_schedules_update** — cmd `UPDATE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = rent_schedules.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `risk_templates`

**risk_templates_delete** — cmd `DELETE`, roles `{public}`

USING:
```
((is_system = false) AND (workspace_id IS NOT NULL) AND is_workspace_member(workspace_id, auth.uid()))
```

**risk_templates_insert** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
((is_system = false) AND (workspace_id IS NOT NULL) AND is_workspace_member(workspace_id, auth.uid()))
```

**risk_templates_select** — cmd `SELECT`, roles `{public}`

USING:
```
((is_system = true) OR ((workspace_id IS NOT NULL) AND is_workspace_member(workspace_id, auth.uid())))
```

**risk_templates_update** — cmd `UPDATE`, roles `{public}`

USING:
```
((is_system = false) AND (workspace_id IS NOT NULL) AND is_workspace_member(workspace_id, auth.uid()))
```
WITH CHECK:
```
((is_system = false) AND (workspace_id IS NOT NULL) AND is_workspace_member(workspace_id, auth.uid()))
```


### `risks`

**risks_delete** — cmd `DELETE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = risks.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**risks_insert** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = risks.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**risks_select** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = risks.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```

**risks_update** — cmd `UPDATE`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = risks.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```
WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = risks.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `summary_views`

**summary_views_insert** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = summary_views.lease_id) AND (l.summary_share_token IS NOT NULL))))
```

**summary_views_select_workspace** — cmd `SELECT`, roles `{public}`

USING:
```
(EXISTS ( SELECT 1
   FROM leases l
  WHERE ((l.id = summary_views.lease_id) AND ((l.user_id = auth.uid()) OR is_workspace_member(l.workspace_id, auth.uid())))))
```


### `user_out_of_office`

**user_out_of_office_insert_self** — cmd `INSERT`, roles `{authenticated}`

WITH CHECK:
```
((user_id = auth.uid()) AND (workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid()))))
```

**user_out_of_office_select** — cmd `SELECT`, roles `{authenticated}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```

**user_out_of_office_update_self** — cmd `UPDATE`, roles `{authenticated}`

USING:
```
(user_id = auth.uid())
```
WITH CHECK:
```
(user_id = auth.uid())
```


### `user_preferences`

**Users can manage their own preferences** — cmd `ALL`, roles `{public}`

USING:
```
(auth.uid() = user_id)
```
WITH CHECK:
```
(auth.uid() = user_id)
```


### `workspace_approvers`

**Workspace members can view approvers** — cmd `SELECT`, roles `{public}`

USING:
```
is_workspace_member(workspace_id, auth.uid())
```

**Workspace owners can manage approvers** — cmd `ALL`, roles `{public}`

USING:
```
is_workspace_owner(workspace_id, auth.uid())
```


### `workspace_members`

**Members can view workspace membership** — cmd `SELECT`, roles `{public}`

USING:
```
((user_id = auth.uid()) OR is_workspace_member(workspace_id, auth.uid()))
```

**Owners can add members** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
is_workspace_owner(workspace_id, auth.uid())
```

**Owners can remove members** — cmd `DELETE`, roles `{public}`

USING:
```
is_workspace_owner(workspace_id, auth.uid())
```

**Owners can update members** — cmd `UPDATE`, roles `{public}`

USING:
```
is_workspace_owner(workspace_id, auth.uid())
```


### `workspace_roles`

**workspace_roles_delete** — cmd `DELETE`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```

**workspace_roles_insert** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```

**workspace_roles_select** — cmd `SELECT`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = auth.uid())
UNION
 SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())))
```

**workspace_roles_update** — cmd `UPDATE`, roles `{public}`

USING:
```
(workspace_id IN ( SELECT workspaces.id
   FROM workspaces
  WHERE (workspaces.owner_id = auth.uid())
UNION
 SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE ((workspace_members.user_id = auth.uid()) AND (workspace_members.role = 'admin'::workspace_role))))
```


### `workspaces`

**Owners can delete their workspaces** — cmd `DELETE`, roles `{public}`

USING:
```
(owner_id = auth.uid())
```

**Owners can update their workspaces** — cmd `UPDATE`, roles `{public}`

USING:
```
(owner_id = auth.uid())
```

**Users can create workspaces** — cmd `INSERT`, roles `{public}`

WITH CHECK:
```
(owner_id = auth.uid())
```

**Users can view workspaces they own or are members of** — cmd `SELECT`, roles `{public}`

USING:
```
((owner_id = auth.uid()) OR is_workspace_member(id, auth.uid()))
```


---

## 7. Functions

### `apply_policy_steps(p_policy_id uuid, p_steps jsonb)`

- Returns: `void`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.apply_policy_steps(p_policy_id uuid, p_steps jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Auth check: caller must be admin/owner of the policy's workspace
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.id = p_policy_id
      AND (
        p.workspace_id IN (SELECT id FROM public.workspaces WHERE owner_id = auth.uid())
        OR p.workspace_id IN (
          SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  DELETE FROM public.approval_chain_steps WHERE policy_id = p_policy_id;

  INSERT INTO public.approval_chain_steps (
    policy_id, stage, step_order, parallel_group,
    approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required
  )
  SELECT
    p_policy_id,
    (s->>'stage')::text,
    (s->>'step_order')::integer,
    COALESCE((s->>'parallel_group')::integer, 1),
    NULLIF(s->>'approver_user_id', '')::uuid,
    NULLIF(s->>'approver_role', ''),
    NULLIF(s->>'delegate_user_id', '')::uuid,
    NULLIF(s->>'delegate_after_days', '')::integer,
    COALESCE((s->>'is_required')::boolean, true)
  FROM jsonb_array_elements(p_steps) AS s;
END;
$function$
```

### `approve_field(p_lease_id uuid, p_field_name text)`

- Returns: `boolean`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.approve_field(p_lease_id uuid, p_field_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Verify caller owns or is a workspace member of this lease
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE leases
  SET
    confirmed_sections = array_append(
      array_remove(confirmed_sections, p_field_name),
      p_field_name
    ),
    audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
      'action',     'field_approved',
      'timestamp',  NOW(),
      'user_id',    auth.uid(),
      'field_name', p_field_name
    )
  WHERE id = p_lease_id;

  RETURN TRUE;
END;
$function$
```

### `detect_lease_attribute_change()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.detect_lease_attribute_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lease_approval_chain WHERE lease_id = NEW.id LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_status IN ('rejected', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;

  IF OLD.asset_type IS DISTINCT FROM NEW.asset_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('asset_type',
      jsonb_build_object('from', OLD.asset_type, 'to', NEW.asset_type));
  END IF;
  IF OLD.lease_type IS DISTINCT FROM NEW.lease_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('lease_type',
      jsonb_build_object('from', OLD.lease_type, 'to', NEW.lease_type));
  END IF;
  IF OLD.requesting_department IS DISTINCT FROM NEW.requesting_department THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('requesting_department',
      jsonb_build_object('from', OLD.requesting_department, 'to', NEW.requesting_department));
  END IF;
  IF OLD.region IS DISTINCT FROM NEW.region THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('region',
      jsonb_build_object('from', OLD.region, 'to', NEW.region));
  END IF;
  IF OLD.monthly_payment IS DISTINCT FROM NEW.monthly_payment THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('monthly_payment',
      jsonb_build_object('from', OLD.monthly_payment, 'to', NEW.monthly_payment));
  END IF;

  IF v_changed THEN
    INSERT INTO public.lease_activity_log (
      lease_id, user_id, activity_type, from_status, to_status, details
    ) VALUES (
      NEW.id,
      NULL,
      'attribute_change_detected',
      NEW.lifecycle_status,
      NEW.lifecycle_status,
      jsonb_build_object(
        'changed_attributes', v_changes,
        'reroute_pending', true
      )
    );
    NEW.reroute_evaluation_pending = true;
  END IF;

  RETURN NEW;
END;
$function$
```

### `finalize_lease_approval(p_lease_id uuid)`

- Returns: `boolean`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.finalize_lease_approval(p_lease_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_confirmed_sections TEXT[];
BEGIN
  -- Verify caller is a financial_approver or admin in the lease's workspace,
  -- or is the lease owner.
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (
        l.user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM workspace_roles wr
          WHERE wr.workspace_id = l.workspace_id
            AND wr.user_id = auth.uid()
            AND wr.role IN ('financial_approver', 'admin')
        )
      )
  ) THEN
    RAISE EXCEPTION 'Unauthorized: financial_approver or admin role required';
  END IF;

  SELECT confirmed_sections
  INTO v_confirmed_sections
  FROM leases
  WHERE id = p_lease_id;

  UPDATE leases
  SET
    status           = 'Ready',
    lifecycle_status = 'approved',
    audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
      'action',            'lease_approved',
      'timestamp',         NOW(),
      'user_id',           auth.uid(),
      'fields_confirmed',  v_confirmed_sections
    )
  WHERE id = p_lease_id;

  INSERT INTO lease_approval_actions (lease_id, action, performed_by, performed_at)
  VALUES (p_lease_id, 'final_approval', auth.uid(), NOW())
  ON CONFLICT DO NOTHING;

  RETURN TRUE;
END;
$function$
```

### `get_audit_user_id(p_email text)`

- Returns: `uuid`
- Language: `sql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.get_audit_user_id(p_email text)
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
  SELECT id FROM auth.users WHERE email = lower(p_email) LIMIT 1;
$function$
```

### `get_workspace_role(_workspace_id uuid, _user_id uuid)`

- Returns: `workspace_role`
- Language: `sql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.get_workspace_role(_workspace_id uuid, _user_id uuid)
 RETURNS workspace_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT role
  FROM public.workspace_members
  WHERE workspace_id = _workspace_id
    AND user_id = _user_id
$function$
```

### `handle_new_user()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  return new;
end;
$function$
```

### `has_workspace_permission(_workspace_id uuid, _user_id uuid, _min_role workspace_role)`

- Returns: `boolean`
- Language: `sql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.has_workspace_permission(_workspace_id uuid, _user_id uuid, _min_role workspace_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = _workspace_id
      AND user_id = _user_id
      AND (
        CASE role
          WHEN 'admin' THEN 3
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1
        END >= CASE _min_role
          WHEN 'admin' THEN 3
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1
        END
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$function$
```

### `increment_policy_version()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `INVOKER`

```sql
CREATE OR REPLACE FUNCTION public.increment_policy_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$function$
```

### `is_workspace_member(_workspace_id uuid, _user_id uuid)`

- Returns: `boolean`
- Language: `sql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = _workspace_id
      AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$function$
```

### `is_workspace_owner(_workspace_id uuid, _user_id uuid)`

- Returns: `boolean`
- Language: `sql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.is_workspace_owner(_workspace_id uuid, _user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$function$
```

### `lease_asc842_inputs_set_updated_at()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `INVOKER`

```sql
CREATE OR REPLACE FUNCTION public.lease_asc842_inputs_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN NEW.last_updated_at := now(); RETURN NEW; END;
$function$
```

### `log_lease_state_change()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.log_lease_state_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF (OLD.status IS DISTINCT FROM NEW.status) OR 
     (OLD.lifecycle_status IS DISTINCT FROM NEW.lifecycle_status) THEN
    
    INSERT INTO public.lease_state_transitions (
      lease_id,
      from_status,
      to_status,
      from_lifecycle,
      to_lifecycle,
      transitioned_by,
      transition_reason,
      metadata
    ) VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      OLD.lifecycle_status,
      NEW.lifecycle_status,
      auth.uid(),
      NEW.rejection_reason,
      jsonb_build_object(
        'approver', NEW.approver_email,
        'submitted_at', NEW.submitted_for_approval_at,
        'internal_approved_at', NEW.internal_approved_at,
        'execution_approved_at', NEW.execution_approved_at
      )
    );
  END IF;
  
  RETURN NEW;
END;
$function$
```

### `maintain_lease_document_latest_flag()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.maintain_lease_document_latest_flag()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.lease_documents
     SET is_current_latest = false,
         superseded_by = NEW.id,
         superseded_at = now()
   WHERE lease_id = NEW.lease_id
     AND id <> NEW.id
     AND is_current_latest = true;

  UPDATE public.lease_documents
     SET is_current_latest = true
   WHERE id = NEW.id;

  RETURN NEW;
END;
$function$
```

### `mark_field_as_corrected()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.mark_field_as_corrected()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.lease_field_confidence SET was_corrected = true, corrected_at = NEW.corrected_at
  WHERE lease_id = NEW.lease_id AND field_name = NEW.field_name;
  RETURN NEW;
END;
$function$
```

### `prevent_locked_lease_edits()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `INVOKER`

```sql
CREATE OR REPLACE FUNCTION public.prevent_locked_lease_edits()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  old_client_state jsonb;
  new_client_state jsonb;
  ignored_keys text[] := ARRAY[
    'updated_at',
    'vendor_name',
    'vendor_phone',
    'vendor_address_line1',
    'vendor_address_line2',
    'vendor_city',
    'vendor_state',
    'vendor_zip',
    'archived',
    'archived_at',
    'archived_by'
  ];
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.summary_share_token IS DISTINCT FROM OLD.summary_share_token
    OR NEW.summary_shared_at IS DISTINCT FROM OLD.summary_shared_at
    OR NEW.summary_last_viewed_at IS DISTINCT FROM OLD.summary_last_viewed_at
  THEN
    RAISE EXCEPTION 'Financial summary sharing fields are managed by the summary publishing workflow';
  END IF;

  IF OLD.model_locked IS TRUE THEN
    old_client_state := to_jsonb(OLD) - ignored_keys;
    new_client_state := to_jsonb(NEW) - ignored_keys;

    IF new_client_state IS DISTINCT FROM old_client_state THEN
      RAISE EXCEPTION 'Cannot modify a locked lease except through the governance workflow';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
```

### `preview_policy_resolution(p_workspace_id uuid, p_asset_type text, p_department text, p_annual_cost numeric, p_region text, p_lease_type text)`

- Returns: `jsonb`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.preview_policy_resolution(p_workspace_id uuid, p_asset_type text, p_department text, p_annual_cost numeric, p_region text, p_lease_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_policy public.approval_policies;
  v_chain jsonb;
  v_warnings text[] := ARRAY[]::text[];
BEGIN
  -- Caller must have membership/ownership in the workspace being queried.
  -- Belt-and-suspenders since the function is SECURITY DEFINER.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces WHERE id = p_workspace_id AND owner_id = auth.uid()
    UNION
    SELECT 1 FROM public.workspace_members WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Find matching policies, sorted by priority descending
  SELECT * INTO v_policy
  FROM public.approval_policies p
  WHERE p.workspace_id = p_workspace_id
    AND p.is_active = true
    AND (cardinality(p.match_asset_types) = 0 OR p_asset_type = ANY(p.match_asset_types))
    AND (cardinality(p.match_departments) = 0 OR p_department = ANY(p.match_departments))
    AND (p.match_min_annual_cost IS NULL OR p_annual_cost >= p.match_min_annual_cost)
    AND (p.match_max_annual_cost IS NULL OR p_annual_cost <= p.match_max_annual_cost)
    AND (cardinality(p.match_regions) = 0 OR p_region = ANY(p.match_regions))
    AND (cardinality(p.match_lease_types) = 0 OR p_lease_type = ANY(p.match_lease_types))
  ORDER BY p.priority DESC, p.created_at ASC
  LIMIT 1;

  -- Fall back to default policy if none matched
  IF v_policy.id IS NULL THEN
    SELECT * INTO v_policy
    FROM public.approval_policies p
    WHERE p.workspace_id = p_workspace_id
      AND p.is_active = true
      AND p.is_default_fallback = true
    LIMIT 1;

    IF v_policy.id IS NULL THEN
      RETURN jsonb_build_object(
        'matched', false,
        'error', 'No matching policy and no default fallback configured.'
      );
    END IF;

    v_warnings := array_append(v_warnings, 'No specific match; using default fallback policy.');
  END IF;

  -- Build resolved chain
  SELECT jsonb_agg(
    jsonb_build_object(
      'stage', s.stage,
      'step_order', s.step_order,
      'parallel_group', s.parallel_group,
      'approver_user_id', s.approver_user_id,
      'approver_role', s.approver_role,
      'delegate_user_id', s.delegate_user_id,
      'is_required', s.is_required
    )
    ORDER BY s.stage, s.step_order, s.parallel_group
  ) INTO v_chain
  FROM public.approval_chain_steps s
  WHERE s.policy_id = v_policy.id;

  RETURN jsonb_build_object(
    'matched', true,
    'policy_id', v_policy.id,
    'policy_name', v_policy.name,
    'policy_priority', v_policy.priority,
    'policy_version', v_policy.version,
    'separation_override', v_policy.separation_of_duties_override,
    'chain', COALESCE(v_chain, '[]'::jsonb),
    'warnings', to_jsonb(v_warnings)
  );
END;
$function$
```

### `record_field_correction(p_lease_id uuid, p_field_name text, p_original_value text, p_corrected_value text, p_correction_type text, p_user_notes text)`

- Returns: `uuid`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.record_field_correction(p_lease_id uuid, p_field_name text, p_original_value text, p_corrected_value text, p_correction_type text DEFAULT 'manual'::text, p_user_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_correction_id uuid;
  v_ai_confidence numeric;
BEGIN
  -- Verify caller can edit this lease
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT confidence_score INTO v_ai_confidence
  FROM lease_field_confidence
  WHERE lease_id = p_lease_id AND field_name = p_field_name;

  INSERT INTO field_corrections (
    lease_id, field_name, original_value, corrected_value,
    ai_confidence, corrected_by, corrected_at, correction_type, user_notes
  ) VALUES (
    p_lease_id, p_field_name, p_original_value, p_corrected_value,
    v_ai_confidence, auth.uid(), NOW(), p_correction_type, p_user_notes
  )
  RETURNING id INTO v_correction_id;

  UPDATE lease_field_confidence
  SET was_corrected = TRUE, corrected_at = NOW()
  WHERE lease_id = p_lease_id AND field_name = p_field_name;

  UPDATE leases
  SET audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
    'action',        'field_corrected',
    'timestamp',     NOW(),
    'user_id',       auth.uid(),
    'field_name',    p_field_name,
    'correction_id', v_correction_id
  )
  WHERE id = p_lease_id;

  RETURN v_correction_id;
END;
$function$
```

### `set_updated_at()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `INVOKER`

```sql
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
```

### `update_lease_avg_confidence()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `DEFINER`

```sql
CREATE OR REPLACE FUNCTION public.update_lease_avg_confidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.leases 
  SET avg_confidence_score = (
    SELECT AVG(confidence_score) 
    FROM public.lease_field_confidence 
    WHERE lease_id = NEW.lease_id
  ) 
  WHERE id = NEW.lease_id;
  RETURN NEW;
END;
$function$
```

### `update_updated_at_column()`

- Returns: `trigger`
- Language: `plpgsql`
- Security: `INVOKER`

```sql
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
```

---

## 8. Triggers

| table | trigger | timing | events | function |
|---|---|---|---|---|
| `approval_policies` | `approval_policies_updated_at` | `BEFORE` | `UPDATE` | `set_updated_at` |
| `approval_policies` | `approval_policies_version_increment` | `BEFORE` | `UPDATE` | `increment_policy_version` |
| `field_corrections` | `track_correction_on_field` | `AFTER` | `INSERT` | `mark_field_as_corrected` |
| `lease_asc842_inputs` | `lease_asc842_inputs_updated_at_trigger` | `BEFORE` | `UPDATE` | `lease_asc842_inputs_set_updated_at` |
| `lease_change_sets` | `lease_change_sets_updated_at` | `BEFORE` | `UPDATE` | `set_updated_at` |
| `lease_documents` | `lease_documents_latest_flag` | `AFTER` | `INSERT` | `maintain_lease_document_latest_flag` |
| `lease_field_confidence` | `update_avg_confidence_on_insert` | `AFTER` | `INSERT OR UPDATE` | `update_lease_avg_confidence` |
| `lease_notifications` | `update_lease_notifications_updated_at` | `BEFORE` | `UPDATE` | `update_updated_at_column` |
| `lease_unlock_requests` | `lease_unlock_requests_updated_at` | `BEFORE` | `UPDATE` | `set_updated_at` |
| `leases` | `enforce_model_lock` | `BEFORE` | `UPDATE` | `prevent_locked_lease_edits` |
| `leases` | `lease_state_change_logger` | `AFTER` | `UPDATE` | `log_lease_state_change` |
| `leases` | `leases_detect_attribute_change` | `BEFORE` | `UPDATE` | `detect_lease_attribute_change` |
| `rent_schedules` | `update_rent_schedules_updated_at` | `BEFORE` | `UPDATE` | `update_updated_at_column` |
| `user_out_of_office` | `user_out_of_office_updated_at` | `BEFORE` | `UPDATE` | `set_updated_at` |
| `workspaces` | `update_workspaces_updated_at` | `BEFORE` | `UPDATE` | `update_updated_at_column` |

---

## Footer

Generated 2026-05-07. To regenerate, run the same SQL queries in this doc's order. To rebuild as runnable SQL, the owner must run `supabase db pull` per [`docs/MIGRATION_DRIFT_REMEDIATION.md`](./MIGRATION_DRIFT_REMEDIATION.md).
