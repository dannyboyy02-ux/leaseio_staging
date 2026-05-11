// Anthropic monitoring adapter — REWRITTEN 2026-05-11 after Phase 3
// probe revealed every admin endpoint returns 401 "invalid x-api-key"
// for the operator-provided key. Diagnosis: the key likely IS a
// valid Anthropic key but is the WRONG TYPE — admin endpoints
// (/v1/organizations/...) require an admin-scoped key. Runtime keys
// (sk-ant-api...) work for /v1/messages but not the admin paths.
//
// What this means: until an actual admin key is provided, the
// adapter cannot read usage. The Stop 1 vendor-side spending cap
// is the actual cost protection; this adapter is an early-warning
// layer on top. The cap stops bleeding at $200 (or whatever was
// set); without admin-key access, the early warning is silent.
//
// What we observed via the live probe:
//   - /v1/organizations              → 404 "Not found"
//   - /v1/organizations/me           → 401 "invalid x-api-key"
//   - /v1/organizations/usage_report/messages → 401
//   - /v1/organizations/cost_report  → 401
//   - /v1/organizations/workspaces   → 401
//
// 401 across all admin paths is the signature of "wrong key type."
// 404 on /organizations is consistent with "endpoint exists but
// requires org_id" which would still 401 anyway if the key is wrong.
//
// To fix from the operator side:
//   1. Open https://console.anthropic.com/settings/keys
//   2. Look for "Admin Keys" section (vs the regular "API Keys")
//   3. Admin keys typically start with sk-ant-admin-... (vs
//      sk-ant-api... for runtime keys)
//   4. Generate a new admin key with Organization Reports scope
//   5. Replace ANTHROPIC_ADMIN_API_KEY in Supabase Dashboard
//
// Until that's done, this adapter writes a single synthetic
// snapshot under metric `admin_key_invalid` so the operator
// dashboard surfaces the configuration gap explicitly instead of
// silently returning nothing.

import type { MonitoringAdapter, VendorUsageSnapshot } from './types.ts';

const ANTHROPIC_API = 'https://api.anthropic.com/v1';

export class AnthropicAdapter implements MonitoringAdapter {
  readonly vendor = 'anthropic';
  private readonly adminKey: string;
  private readonly monthlyCap: number | null;

  constructor(opts: { adminApiKey: string; monthlyCapUsd?: number | null }) {
    this.adminKey = opts.adminApiKey;
    this.monthlyCap = opts.monthlyCapUsd ?? null;
  }

  async fetchSnapshots(): Promise<VendorUsageSnapshot[]> {
    // First, probe a minimal admin endpoint to see if the key is
    // actually admin-scoped. If 401, surface that as a config-error
    // snapshot rather than silently writing nothing.
    let authOk = false;
    let authStatus: number | null = null;
    let authErrorMessage: string | null = null;

    try {
      const probe = await fetch(`${ANTHROPIC_API}/organizations/cost_report?starting_at=${new Date(Date.now() - 86400000).toISOString()}`, {
        headers: {
          'x-api-key': this.adminKey,
          'anthropic-version': '2023-06-01',
        },
      });
      authStatus = probe.status;
      if (probe.ok) {
        authOk = true;
      } else {
        const errBody = await probe.json().catch(() => ({})) as any;
        authErrorMessage = errBody?.error?.message ?? `HTTP ${probe.status}`;
      }
    } catch (err) {
      authErrorMessage = err instanceof Error ? err.message : String(err);
    }

    if (!authOk) {
      // Emit the diagnostic snapshot so the dashboard shows that
      // the integration is configured but not functional.
      return [{
        vendor: 'anthropic',
        metric: 'admin_key_invalid',
        current_value: 1,
        limit_value: 0.5,
        tier: 'pay-as-you-go',
        category: 'hard_cliff',
        metadata: {
          probe_status: authStatus,
          probe_error: authErrorMessage,
          remediation: 'Verify ANTHROPIC_ADMIN_API_KEY is an admin-scoped key (sk-ant-admin-...), not a runtime key (sk-ant-api...). Generate at https://console.anthropic.com/settings/keys under the Admin Keys section.',
        },
      }];
    }

    // Auth is good — attempt the actual usage fetch. (This branch
    // only runs once an admin key is properly configured; the
    // happy-path response shape is unknown until then. When this
    // first runs successfully, capture the response shape and
    // update the parsing below.)
    const snapshots: VendorUsageSnapshot[] = [];
    const now = Date.now();
    const since30d = new Date(now - 30 * 86400000).toISOString();

    try {
      const res = await fetch(`${ANTHROPIC_API}/organizations/cost_report?starting_at=${since30d}`, {
        headers: {
          'x-api-key': this.adminKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (res.ok) {
        const data = await res.json() as any;
        // Best-effort spend extraction. The exact shape will firm up
        // on first successful run; for now, search several
        // candidate paths.
        let totalUsd = 0;
        const rows = Array.isArray(data?.data) ? data.data
                    : Array.isArray(data?.results) ? data.results
                    : Array.isArray(data) ? data
                    : [];
        for (const row of rows) {
          const cost = row?.cost_usd ?? row?.total_cost ?? row?.amount ?? row?.cost;
          const n = Number(cost);
          if (Number.isFinite(n)) totalUsd += n;
        }
        if (totalUsd > 0 || rows.length > 0) {
          snapshots.push({
            vendor: 'anthropic',
            metric: 'spend_30d_usd',
            current_value: Math.round(totalUsd * 100) / 100,
            limit_value: this.monthlyCap,
            tier: 'pay-as-you-go',
            category: 'cost_runaway',
            metadata: { row_count: rows.length, since: since30d, shape_keys: Object.keys(data ?? {}) },
          });
        }
      } else {
        console.warn(`[monitoring:anthropic] cost_report returned ${res.status}`);
      }
    } catch (err) {
      console.warn('[monitoring:anthropic] cost_report fetch threw:', err);
    }

    return snapshots;
  }
}
