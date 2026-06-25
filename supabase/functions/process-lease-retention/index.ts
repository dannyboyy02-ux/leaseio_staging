// process-lease-retention — Leases redesign Phase 3 (nightly hard-purge cron)
//
// Finds leases whose 14-day retention window has elapsed (deleted_at IS NOT NULL
// AND purge_after <= now) and HARD-purges each: writes a durable deleted_leases
// forensic row FIRST (the only survivor of the ON DELETE CASCADE), then deletes
// the lease row (CASCADE destroys lease_activity_log / lease_governance_audit /
// lease_approval_chain / risks / rent_schedules / …), then purges its storage
// LAST. Runs as service_role, which is the only role that may clear
// prevent_committed_lease_hard_delete + the retention/lock guards.
//
// IDEMPOTENT / RESUMABLE (mirrors process-cancellation-lifecycle):
//   - re-reads each lease fresh at the moment of destruction (a concurrent
//     restore-lease wins — if deleted_at went NULL we skip it),
//   - forensic insert keyed UNIQUE(original_lease_id): a duplicate means a prior
//     partial purge → resume the deletes rather than abort,
//   - conditional delete (.not('deleted_at','is',null)) so a restore between the
//     re-read and the delete still wins,
//   - storage purge LAST so an abort before it leaves the lease restorable.
//
// AUTH: verify_jwt = false; gated by the x-cron-secret header ==
// LEASE_RETENTION_CRON_SECRET (fail-closed: a missing/empty secret rejects all
// callers). Schedule + secret are operator-gated — see the cron migration.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const BATCH = 50;

// deno-lint-ignore no-explicit-any
async function purgeLeaseStorage(admin: any, opts: { workspaceId: string | null; leaseId: string; uploaderPrefixes: string[] }): Promise<number> {
  const { workspaceId, leaseId, uploaderPrefixes } = opts;
  let purged = 0;

  async function removePrefix(bucket: string, prefix: string) {
    try {
      const { data: entries } = await admin.storage.from(bucket).list(prefix);
      if (!entries || entries.length === 0) return;
      const files = entries.filter((e: { id?: string | null }) => e.id !== null);
      const folders = entries.filter((e: { id?: string | null }) => e.id === null);
      if (files.length > 0) {
        const paths = files.map((f: { name: string }) => `${prefix}/${f.name}`);
        const { error: rmErr } = await admin.storage.from(bucket).remove(paths);
        if (rmErr) console.error(`[lease-retention] storage remove error ${bucket}/${prefix}: ${rmErr.message}`);
        else purged += paths.length;
      }
      for (const folder of folders) await removePrefix(bucket, `${prefix}/${folder.name}`);
    } catch (err) {
      console.error("[lease-retention] storage purge error:", bucket, prefix, (err as Error)?.message);
    }
  }

  // Source + executed docs live under {uploader_user_id}/{lease_id}.
  for (const prefix of uploaderPrefixes) {
    await removePrefix("leases", prefix);
    await removePrefix("executed-leases", prefix);
  }
  // Generated docs/reports live under {workspace_id}/{lease_id} — scope to THIS
  // lease (never the whole workspace; other leases share the bucket).
  if (workspaceId) {
    await removePrefix("lease-documents", `${workspaceId}/${leaseId}`);
    await removePrefix("lease-reports", `${workspaceId}/${leaseId}`);
  }
  return purged;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cronSecret = Deno.env.get("LEASE_RETENTION_CRON_SECRET");
  const provided = req.headers.get("x-cron-secret");
  // Fail closed: unset secret or mismatch rejects everyone.
  if (!cronSecret || provided !== cronSecret) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ ok: false, error: "Server configuration error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();

  // ── Due rows: soft-deleted and past their purge_after ───────────────────
  const { data: due, error: dueErr } = await admin
    .from("leases")
    .select("id")
    .not("deleted_at", "is", null)
    .lte("purge_after", nowIso)
    .limit(BATCH);
  if (dueErr) {
    console.error("[lease-retention] due-scan error:", dueErr.message);
    return new Response(JSON.stringify({ ok: false, error: dueErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let purgedCount = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of (due ?? []) as Array<{ id: string }>) {
    const leaseId = row.id;
    try {
      // Re-read fresh: a restore between the scan and now must win.
      const { data: lease } = await admin
        .from("leases")
        .select("id, workspace_id, user_id, requestor_id, filename, request_title, lifecycle_status, model_locked, archived, deleted_at, deleted_by, purge_after, deletion_reason")
        .eq("id", leaseId)
        .maybeSingle();
      if (!lease || !lease.deleted_at || !lease.purge_after || lease.purge_after > nowIso) {
        skipped++;
        continue;
      }

      // Snapshot the activity log BEFORE the CASCADE destroys it — this is the
      // attribution chain the forensic row must carry (integrity review CRITICAL).
      const { data: activityHistory } = await admin
        .from("lease_activity_log")
        .select("activity_type, from_status, to_status, user_id, created_at, details")
        .eq("lease_id", leaseId)
        .order("created_at", { ascending: true });

      const [{ count: riskCount }, { count: chainStepCount }] = await Promise.all([
        admin.from("risks").select("id", { count: "exact", head: true }).eq("lease_id", leaseId),
        admin.from("lease_approval_chain").select("id", { count: "exact", head: true }).eq("lease_id", leaseId),
      ]);

      // Storage prefixes (derived from the lease id) BEFORE deleting the row.
      const uploaderPrefixes = new Set<string>();
      if (lease.user_id) uploaderPrefixes.add(`${lease.user_id}/${leaseId}`);
      if (lease.requestor_id && lease.requestor_id !== lease.user_id) {
        uploaderPrefixes.add(`${lease.requestor_id}/${leaseId}`);
      }

      // ── Forensic row FIRST (UNIQUE original_lease_id; resume on duplicate) ──
      const { error: forensicErr } = await admin.from("deleted_leases").insert({
        original_lease_id: leaseId,
        workspace_id: lease.workspace_id,
        filename: lease.filename,
        request_title: lease.request_title,
        lifecycle_status_at_deletion: lease.lifecycle_status,
        model_locked_at_deletion: lease.model_locked === true,
        deleted_at: lease.deleted_at,
        deleted_by: lease.deleted_by,
        purge_after: lease.purge_after,
        storage_objects_purged: 0,
        details: {
          purge_source: "lease_retention_cron",
          soft_deleted_at: lease.deleted_at,
          purge_after: lease.purge_after,
          purged_at: nowIso,
          deletion_reason: lease.deletion_reason,
          original_lifecycle_status: lease.lifecycle_status,
          was_archived: lease.archived === true,
          model_locked: lease.model_locked === true,
          workspace_id: lease.workspace_id,
          deletion_actor: lease.deleted_by ?? "system_or_unknown",
          risk_count_at_deletion: riskCount ?? 0,
          chain_step_count_at_deletion: chainStepCount ?? 0,
          activity_log_count: activityHistory?.length ?? 0,
          activity_log_history: activityHistory ?? [],
        },
      });
      if (forensicErr && !/duplicate|unique/i.test(forensicErr.message)) {
        console.error(`[lease-retention] forensic insert failed for ${leaseId} — skipping:`, forensicErr.message);
        errors.push(`${leaseId}: forensic ${forensicErr.message}`);
        continue;
      }

      // ── Hard delete (conditional so a concurrent restore wins) ──────────
      const { error: delErr } = await admin
        .from("leases")
        .delete()
        .eq("id", leaseId)
        .not("deleted_at", "is", null);
      if (delErr) {
        console.error(`[lease-retention] delete failed for ${leaseId}:`, delErr.message);
        errors.push(`${leaseId}: delete ${delErr.message}`);
        continue;
      }

      // ── Storage LAST + backfill the forensic count ──────────────────────
      const storagePurged = await purgeLeaseStorage(admin, {
        workspaceId: lease.workspace_id,
        leaseId,
        uploaderPrefixes: Array.from(uploaderPrefixes),
      });
      if (storagePurged > 0) {
        await admin
          .from("deleted_leases")
          .update({ storage_objects_purged: storagePurged })
          .eq("original_lease_id", leaseId);
      }

      purgedCount++;
    } catch (err) {
      console.error(`[lease-retention] unexpected error purging ${leaseId}:`, (err as Error)?.message);
      errors.push(`${leaseId}: ${(err as Error)?.message}`);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      scanned: due?.length ?? 0,
      purged: purgedCount,
      skipped,
      errors: errors.length,
      errorDetail: errors.slice(0, 10),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
