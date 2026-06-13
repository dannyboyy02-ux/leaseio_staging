// Shared workspace-destruction helpers (KNOWN_ISSUES #74).
//
// The canceled-workspace cron (process-cancellation-lifecycle) and the
// owner-initiated delete-workspace function both permanently destroy a
// workspace. They MUST do identical cleanup or one path drifts: before this
// module, delete-workspace canceled NO Stripe subscriptions and purged only
// 2 of 4 storage buckets (no subfolder recursion), while the cron did the
// full job. Both now call these helpers so the two destruction paths can't
// diverge.
//
// Behavior is lifted verbatim from the cron's purge loop:
//   - cancelWorkspaceSubscriptions: list customer subs (status "all") and
//     cancel each tagged to this workspace that isn't already terminal.
//     THROWS on any Stripe error — the CALLER decides whether to defer
//     (cron) or log-and-continue (delete-workspace). The caller also owns
//     the null-stripe / null-customerId decision; this fn assumes both set.
//   - purgeWorkspaceStorage: recursive prefix purge across all four buckets
//     ('leases'/'executed-leases' per uploader prefix; 'lease-documents'/
//     'lease-reports' under the workspace id). Best-effort per bucket
//     (logs + continues on error). Returns the count of objects removed.

// deno-lint-ignore no-explicit-any
type AnyClient = any;

/**
 * Cancel every surviving Stripe subscription tagged to this workspace
 * (document packs are independent subscriptions — without this they bill
 * forever against a deleted workspace). Returns the canceled subscription
 * ids. THROWS on any Stripe error so the caller can defer/handle.
 *
 * The caller decides what to do when there is no Stripe client or no
 * customer id — this function is only invoked when both are present.
 */
export async function cancelWorkspaceSubscriptions(
  // deno-lint-ignore no-explicit-any
  stripe: any,
  customerId: string,
  workspaceId: string,
): Promise<string[]> {
  const canceled: string[] = [];
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });
  for (const sub of subs.data) {
    if (
      sub.metadata?.workspace_id === workspaceId &&
      sub.status !== "canceled" &&
      sub.status !== "incomplete_expired"
    ) {
      await stripe.subscriptions.cancel(sub.id);
      canceled.push(sub.id);
    }
  }
  return canceled;
}

/**
 * Recursively purge a workspace's storage across all four buckets. Storage
 * conventions (verified against UploadDocumentDialog + generate-lease-report
 * + LeaseRequestForm):
 *   - 'leases' / 'executed-leases': {uploader_user_id}/{lease_id}/...
 *   - 'lease-documents' / 'lease-reports': {workspace_id}/{child}/...
 *
 * Best-effort: a single bucket/prefix error is logged and skipped so a
 * storage hiccup never aborts the destruction. Returns the count of objects
 * removed.
 */
export async function purgeWorkspaceStorage(
  supabaseAdmin: AnyClient,
  opts: { workspaceId: string; uploaderPrefixes: string[] },
): Promise<number> {
  const { workspaceId, uploaderPrefixes } = opts;
  let storagePurged = 0;

  async function removePrefix(bucket: string, prefix: string) {
    try {
      const { data: entries } = await supabaseAdmin.storage.from(bucket).list(prefix);
      if (!entries || entries.length === 0) return;
      const files = entries.filter((e: { id?: string | null }) => e.id !== null);
      const folders = entries.filter((e: { id?: string | null }) => e.id === null);
      if (files.length > 0) {
        const paths = files.map((f: { name: string }) => `${prefix}/${f.name}`);
        const { error: rmErr } = await supabaseAdmin.storage.from(bucket).remove(paths);
        if (rmErr) {
          console.error(`[workspace-purge] storage remove error in ${bucket}/${prefix}: ${rmErr.message}`);
        } else {
          storagePurged += paths.length;
        }
      }
      for (const folder of folders) {
        await removePrefix(bucket, `${prefix}/${folder.name}`);
      }
    } catch (err) {
      console.error("[workspace-purge] storage purge error:", bucket, prefix, (err as Error)?.message);
    }
  }

  for (const prefix of uploaderPrefixes) {
    await removePrefix("leases", prefix);
    await removePrefix("executed-leases", prefix);
  }
  await removePrefix("lease-documents", workspaceId);
  await removePrefix("lease-reports", workspaceId);

  return storagePurged;
}
