# Leases Redesign — Deploy & Handoff (2026-06-25)

Branch: `claude/relaxed-clarke-oksfz4`. This is the durable handoff for the
Leases-page redesign (Phases 1–3). Everything below is **committed + pushed**;
nothing is applied to staging or deployed yet — the apply/deploy steps are
operator-gated and ordered (Section "Operator deploy sequence").

---

## What shipped (all on the branch)

**Phase 1 — Leases page recompose** (`src/pages/Leases.tsx`)
- Single `?status=` scope filter (Active / Archived / All, default All) replacing
  the old Active/Approval tabs + "Show archived" toggle. `?view=approval` legacy
  links redirect to `/app/approvals`.
- Row → kebab (⋯) actions; the whole row is click-to-open (keyboard-accessible:
  `role=link` + Enter/Space). Asset-type column with workspace-configurable
  abbreviations + tooltip. Search filters across property/landlord/type/status/
  dates/sqft/rent. CSV export (WYSIWYG) via the overflow menu.
- Stale Dashboard deep-links repointed (`?view=active` → `?status=active`,
  `?view=approval` → `/app/approvals`, `?view=violations` → `?status=active`
  with the lost violations-only filter tracked as KNOWN_ISSUES #151).
- Full i18n (en+es), `warning` badge token, `EmptyLeaseState` i18n.

**Phase 2 — Asset-type abbreviations**
- `src/lib/assetTypes.ts` (normalize/pretty/abbreviation, override precedence),
  `src/lib/csv.ts` `rowsToCsv`. Workspace Settings field for per-type shorthands.
- Migration `20260625120000_asset_type_abbreviations.sql` — `workspaces.asset_type_abbreviations jsonb`,
  added to the `prevent_readonly_workspace_config_edits` guard set.

**Phase 3 — Admin "Delete permanently" (soft-delete + 14-day retention)**
- Migrations `20260625130000_lease_retention_lifecycle.sql` (columns + hiding RLS
  + guard + `deleted_leases` forensic table + 3 new activity types) and
  `20260625130100_lease_retention_cron.sql` (nightly purge schedule).
- Edge functions `delete-lease`, `restore-lease`, `process-lease-retention` (new);
  count-site filters in `process_lease`, `_shared/monitoring/workspace_quotas.ts`,
  `ai-assistant` (`.is('deleted_at', null)` — service-role bypasses the hiding RLS).
- Frontend `DeleteLeaseWithRetentionDialog` + the kebab "Delete permanently" item
  + an Undo action on the success toast (calls `restore-lease`).

All phases passed security + integrity + auditor + polish review (no
unaddressed Critical/High). 1310 vitest tests pass; tsc clean.

---

## Operator deploy sequence (ORDER MATTERS)

> The touched edge functions (`process_lease`, `ai-assistant`, the
> `workspace_quotas` consumers) reference `leases.deleted_at`. If they redeploy
> BEFORE the migration applies, those queries error on a missing column. **Apply
> the migration first.**

1. **Apply the migrations** (in order):
   - `20260625120000_asset_type_abbreviations.sql` (Phase 2 — security-reviewed CLEAN)
   - `20260625130000_lease_retention_lifecycle.sql` (Phase 3 core — security+integrity CLEAN)
   - `20260625130100_lease_retention_cron.sql` (Phase 3 cron — see step 3 first)
2. **Deploy the edge functions** (new + the three touched):
   - new: `delete-lease`, `restore-lease`, `process-lease-retention`
   - redeploy (now filtering `deleted_at`): `process_lease`, `ai-assistant`, and any
     function bundling `_shared/monitoring/workspace_quotas.ts`
3. **Set the cron secret (fail-closed until then):**
   - `supabase secrets set LEASE_RETENTION_CRON_SECRET=$(openssl rand -hex 32)`
   - `INSERT INTO private.cron_secrets (id, value) VALUES ('lease_retention', '<same value>')`
   - The `20260625130100` schedule forwards that secret as `x-cron-secret`; until
     it's set, the nightly POST carries NULL and `process-lease-retention` returns
     401 — i.e. nothing is purged. Safe to apply the cron migration before the
     secret exists.
4. **Regenerate `src/integrations/supabase/types.ts`** after the migration applies
   (adds `leases.deleted_at/purge_after/deleted_by/deletion_reason`, `deleted_leases`)
   so the `as any` casts can later be tightened.
5. **Frontend deploy** (Vercel) carries the Leases UI + the Delete dialog. The
   Delete button errors gracefully (toast) until `delete-lease` is deployed.

CORS: the new frontend-invoked functions (`delete-lease`, `restore-lease`) use the
shared `_shared/cors.ts` allowlist — no cors change, so no mass redeploy needed.

---

## Verification after deploy

- Soft-delete an active lease → it vanishes from the list/Dashboard/Portfolio and
  the active count drops by one; `lease_activity_log` has a `lease_soft_deleted` row.
- The Undo toast restores it (back in the list; `lease_restored_from_deletion` row).
- Set a test lease's `purge_after` to the past (service-role) → run
  `process-lease-retention` → the lease + children are gone, a `deleted_leases`
  forensic row exists with `details.activity_log_history` populated, and its
  storage prefixes (including `lease-reports` by report_id) are purged.

## Open follow-ups (filed)
- #151 — Dashboard "Chain violation" drill-down lost its violations-only filter.
- #152 — Leases redesign deferred i18n (status-badge labels app-wide; ES n=1 subtitle).
- #153 — Phase 3 follow-ups: `ArchiveLeaseDialog` full i18n; a "Recently deleted"
  admin view for non-immediate restore (backend `restore-lease` already built).
