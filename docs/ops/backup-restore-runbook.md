# Supabase backup-restore runbook

Per `docs/OPERATIONAL_MONITORING_SPEC.md` Phase 3 deliverable. Validates that Supabase's backup mechanism actually restores correctly. Run once during Phase 3, then annually thereafter (the annual reminder belongs in `vendor_renewal_calendar`).

---

## Why this drill matters

Supabase Pro includes daily backups with 7-day retention; backups are point-in-time-recoverable (PITR) on Pro+. But a backup you've never restored is, in the operational-discipline sense, a backup that doesn't work. The first time you find out it doesn't work is during a production incident, which is the wrong time. This drill catches:

- Backup file integrity at the storage layer
- Restore tooling availability (the Supabase Pause/Restore flow, or `pg_restore` if doing it manually)
- Data integrity at restore time (does the restored data match production at the snapshot's timestamp?)
- RLS, function, and trigger preservation (does the restored project actually run?)
- Migration history reconciliation (will subsequent migrations apply cleanly to the restored state?)

---

## Pre-drill setup

Before starting:

1. **Pick a non-production day.** A weekend afternoon is fine. The drill takes ~1–2 hours of clock time but ~15 minutes of attention; mostly waiting for the restore.
2. **Have credentials ready:**
   - Supabase Dashboard access for the production project (`wwkwoxxcprnjjufkbzac`)
   - Supabase Dashboard access to create a new staging project (or an existing dedicated staging project)
   - DB password for the production project (Settings → Database)
3. **Pick a verification anchor.** Pick 3 specific data points you'll verify after restore:
   - One row in `leases` with a known `id`
   - One row in `workspaces` with a known `id`
   - One row in `lease_activity_log` with a recent `created_at`

   Note their values now so you can confirm them post-restore. Capture in this runbook's "Drill log" section below.

---

## Drill procedure

### Option A — Supabase native restore (preferred)

This is the path Supabase officially supports and the one most likely to be used in a real incident. Use it when possible.

1. **In the production project's dashboard**, navigate to Settings → Database → Backups.
2. **Pick a backup** from the last 7 days (the most recent daily is fine).
3. **Click "Restore to new project"** (or equivalent). This creates a new Supabase project populated from the backup.
4. **Wait for restore to complete.** Typically 10–30 minutes for a project of LeaseIO's current size.
5. **Capture the new project ref.** It'll look like `xxxx-xxx-xxxx`. Store it in the drill log below.

### Option B — Manual `pg_dump` + `pg_restore` (fallback)

Use when Supabase native restore is unavailable. Requires `pg_dump` and `pg_restore` installed locally.

1. **Capture a logical backup** from production:
   ```
   pg_dump --format=custom --no-owner --no-privileges \
     "postgresql://postgres:<PASSWORD>@db.wwkwoxxcprnjjufkbzac.supabase.co:5432/postgres" \
     --file=leaseio-backup-YYYY-MM-DD.dump
   ```
   Don't commit this file. Keep it locally for the drill duration; delete after.
2. **Create a new staging Supabase project** in the same region. Note its connection string.
3. **Restore into staging:**
   ```
   pg_restore --no-owner --no-privileges \
     --dbname="postgresql://postgres:<STAGING_PASSWORD>@db.<staging-ref>.supabase.co:5432/postgres" \
     leaseio-backup-YYYY-MM-DD.dump
   ```
4. **Apply post-restore housekeeping:**
   - Recreate the `private` schema if it was excluded
   - Re-seed `vendor_alert_recipients` if it was excluded by `--no-acl`
   - Verify `cron.job` table state (pg_cron schedules don't always survive restore cleanly; may need to reschedule)

---

## Verification

Once the restored project is up:

1. **Connect to the restored DB** via the Supabase SQL editor or `psql`.
2. **Verify the three anchor rows you captured pre-drill:**
   ```sql
   SELECT id, request_title, lifecycle_status FROM leases WHERE id = '<your anchor lease id>';
   SELECT id, name, plan FROM workspaces WHERE id = '<your anchor workspace id>';
   SELECT activity_type, created_at FROM lease_activity_log WHERE id = '<your anchor activity id>';
   ```
   Each should return the exact same data as production at the snapshot's timestamp.
3. **Verify RLS is intact:**
   ```sql
   SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.leases'::regclass;
   ```
   Spot-check 3 policies are present.
4. **Verify functions and triggers are intact:**
   ```sql
   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY proname LIMIT 20;
   ```
   Should include `is_workspace_member`, `is_workspace_owner`, `is_ops_admin`, etc.
5. **Try a destructive operation under RLS** (the restored DB shouldn't have your local auth):
   - Connect via `psql` as the `authenticated` role with no JWT
   - `SELECT count(*) FROM public.leases;` — should return 0 (RLS denies, no auth.uid())
6. **Apply a recent repo migration** to verify migration history reconciles:
   - Pick a recent migration from `supabase/migrations/` (the latest one)
   - Apply via `supabase db query --file ... --linked` (with `--linked` pointing at the restored staging project)
   - Should succeed (idempotent guards) or fail with a clear conflict (which itself is informative — document the result)

---

## Cleanup

When verification is complete:

1. **Pause the restored project** to stop billing immediately. Settings → General → Pause Project.
2. **Schedule deletion** for 7 days out. Gives you time to revisit if you discover something.
3. **Delete the local `pg_dump` file** if you went with Option B.
4. **Update this runbook** with any deltas discovered during the drill (commands that didn't work as documented, edge cases hit, etc.).

---

## Drill log

Append entries here with each drill. Don't modify earlier entries.

### Drill 1 — pending (target: by end of Phase 3 build)

| Field | Value |
|---|---|
| Date | YYYY-MM-DD |
| Driver | <name> |
| Backup snapshot date | YYYY-MM-DD |
| Restore method | Option A / Option B |
| Restored project ref | xxxx-xxx-xxxx |
| Time to complete | NN minutes |
| Anchor rows verified | ☐ leases ☐ workspaces ☐ activity log |
| RLS verified | ☐ |
| Functions verified | ☐ |
| Migration apply test | passed / failed (note details) |
| Cleanup completed | ☐ |
| Issues discovered | (free-form) |
| Next drill scheduled in `vendor_renewal_calendar`? | ☐ |
