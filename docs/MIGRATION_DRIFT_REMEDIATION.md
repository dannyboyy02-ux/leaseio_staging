# Migration Drift Remediation

**Filed 2026-05-07 from the professional-grade audit.**
**Severity:** P1 for production readiness. Not user-blocking right now.

---

## Why this matters

The repo's `supabase/migrations/` directory and the live Supabase
project's applied migration history are **out of sync in both
directions**. Per the project's standing **Schema Change Rule**
(`docs/CLAUDE.md`), every schema change must be committed as a
`.sql` migration file. That rule has been violated multiple times
(both before and during this build).

**Concrete consequences:**

- A clean rebuild from `supabase/migrations/` will **not** reproduce
  the live schema. Tables, indexes, policies, and functions added
  via Studio / MCP are missing.
- New Supabase environments (staging, branches, disaster-recovery
  restore) will fail to come up correctly.
- Any "schema as code" claim for SOC / customer audits is currently
  false.
- The risk grows: each new feature that depends on a drifted object
  will have an ambiguous source-of-truth.

---

## What's drifted (counted 2026-05-07)

### Live migrations with NO matching local file (23)

These were applied via Supabase Studio or MCP `apply_migration`
without a corresponding `.sql` file being committed:

```
add_audit_intake_source_and_fix_constraints
add_name_fields_to_invite_tokens
backfill_silently_dropped_asset_type_v2
change_set_items_unique_field_per_set
change_set_items_update_rls
change_set_requested_approver
change_set_self_approval_columns
create_dismissed_events_table
create_processing_rate_limits_table
create_user_preferences_table
governance_audit_self_approved_event
phase5_notifications_and_alert_rules
phase5_process_alerts_cron
risks_dismiss_columns_and_activity_type_v2
risks_update_rls_for_dismiss
sweep_h02_missing_delete_policies
sweep_indexes_hot_join_paths
sweep_m02_m03_remaining_rls_guardrails
tmp_e2e_test_read_for_highlight_validation        ← dev-only, expected
tmp_e2e_test_read_for_highlight_validation_v2     ← dev-only, expected
tmp_e2e_test_read_v3_90ff8e4f                     ← dev-only, expected
tmp_rent_schedule_diag_read                       ← dev-only, expected
user_added_risks_and_templates
```

The 4 `tmp_*` entries are diagnostic reads that probably should be
purged from the live `supabase_migrations.schema_migrations` table
during remediation. The other 19 are real schema changes that need
committed `.sql` files.

### Local files with NO matching live migration (28)

These are repo files that don't appear in the live migration
history:

```
0a5bc892-3356-4c7b-a9ba-ab4127f71c52
0d54ba96-7d0d-472f-b799-bc96fbd8cb9c
190dea19-fa36-49f3-8ea6-f8303be321f4
254a3132-6e79-4b3f-b167-5bc1a659e7eb
4375e762-9c10-44fe-8b17-4b207118973a
45c75cb7-d5ac-47a8-976f-78c22669767a
55d5da26-9c19-460a-945e-c267e7fa7d98
5c24ae6a-a187-4d3d-bc87-dc3f3a73faca
6c7086fd-0f2c-4396-845d-fc87a5c8fd67
ab160a49-80b2-4a10-b70f-7ab6a808073b
add_audit_intake_source
add_notify_abstraction_complete                   ← may overlap fix this session
add_status_changed_at
audit_remediation
audit_remediation_phase1
c1c353dd-f462-4056-9271-0d22f28d624e
c8fa0470-2653-4141-acbf-3a6bd1b36386
d2749bd0-9fd1-41bb-a176-02c36fba3bd2
df9ca410-8a17-4a03-a24d-667e6d590e74
ed4a1140-2360-4526-b1ea-519c46531e72
f0366553-6e50-4342-9ef5-cf40be5f6e43
fd382fae-d42f-46ae-8b52-ce04cb57d00e
governance_rls_tighten
phase1_financial_columns
phase1_lease_intake_lifecycle
phase2_approval_roles
phase6_notification_triggers
schema_audit_fixes
```

The 11 UUID-named files are likely Lovable Studio artifacts that
were applied once and then squashed/replaced under a different
named migration. Most of the remaining named files (`phase1_*`,
`phase2_*`, etc.) are pre-Phase-1 work that was reorganized when
the official "Phase N Build Spec" naming convention started — and
the live versions have different names than the local files.

---

## Remediation path (requires Supabase CLI — owner runs locally)

This step requires the `supabase` CLI to be installed and linked to
the project. It cannot be done via the MCP tools because
`supabase db pull` is a CLI-only operation that produces a
context-aware diff against the local migration history.

### Step 1 — Snapshot before touching anything

```bash
# From the repo root
supabase db dump --schema public --data-only=false > _backup_schema_2026_05_07.sql
```

Keep this file. It's your safety net if anything goes sideways.

### Step 2 — Pull the live schema diff

```bash
supabase db pull --schema public
```

This generates a new `supabase/migrations/<timestamp>_remote_schema.sql`
file containing every object on live that the local migration
history does not produce. Inspect it before committing — it
should describe roughly the 19 real drifted migrations from above
plus any policy / index / function tweaks that were never captured.

### Step 3 — Tag drifted-but-unused local files

Move the 28 local files that have no matching live migration into
`supabase/migrations/_archived_2026_05_07/`. They are kept under
`git history` for forensic reference but excluded from new
deployments. Add a `README.md` in that folder explaining why.

### Step 4 — Verify a clean rebuild

```bash
# In a fresh Supabase project (or local Docker)
supabase db reset
# Then run a smoke check that the app boots and a lease can be uploaded.
```

### Step 5 — Going forward

Re-affirm the Schema Change Rule in `CLAUDE.md`:

> **Every schema change MUST be authored as a `.sql` migration file
> committed under `supabase/migrations/` BEFORE it is applied to
> production.** No more direct Studio edits. No more
> `mcp__claude_ai_Supabase__apply_migration` calls without a
> matching committed file.

The `apply_migration` MCP tool is convenient but is what got us
here. From now on:

1. Author the migration as a file.
2. Commit it.
3. Apply it via `supabase db push` (CLI) or via `apply_migration`
   *while pasting the file contents verbatim* so the file and the
   live state stay in lockstep.
4. Verify the live `supabase_migrations.schema_migrations` table
   has a row whose `name` matches the file's `<timestamp>_<name>.sql`.

---

## Risk if not remediated

| Scenario | Impact |
|---|---|
| Spinning up a staging environment | Will not have the missing 19 schema objects. Many features will silently break. |
| Disaster recovery (Supabase outage / data center loss) | Schema cannot be rebuilt from repo alone. Customer-data restore from backup works, but schema reconstruction relies on the surviving live state. |
| Supabase branching for PRs (Pro plan) | Fresh branch will not match prod, so PR previews break. |
| Phase 9 (firm layer) opens | Adding the firm-tier schema starts from ambiguous state. Future migrations may collide. |
| Customer / SOC audit | "We use schema-as-code" is currently inaccurate. |

**Time to remediate:** 1-2 hours for an owner with the Supabase CLI.
The longest part is reviewing the `supabase db pull` output line by
line before committing.

---

## What this doc replaces

This file supersedes any verbal claim that the repo migrations folder
is the schema's source of truth. Until Step 5 is signed off, treat
the live database as authoritative for schema-state questions.
