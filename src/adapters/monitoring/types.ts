// Module: Operational Monitoring — adapter contract
//
// Each vendor adapter under src/adapters/monitoring/<vendor>.ts
// implements MonitoringAdapter and returns one or more
// VendorUsageSnapshot rows from a single fetchSnapshots() call.
//
// Stay in sync with supabase/functions/_shared/monitoring/types.ts.
// The Deno mirror is required because edge functions cannot import
// from src/. Any change to these interfaces must be applied to both.

export type SnapshotCategory = 'soft_quota' | 'hard_cliff' | 'cost_runaway';

export interface VendorUsageSnapshot {
  vendor: string;
  metric: string;
  current_value: number;
  /** null when no hard limit (cost-runaway category) */
  limit_value: number | null;
  tier: string;
  category: SnapshotCategory;
  /** Vendor-specific raw payload for forensics. Stored as jsonb in
   *  vendor_usage_snapshots.metadata. */
  metadata?: Record<string, unknown>;
}

export interface MonitoringAdapter {
  vendor: string;
  /** Fetch current usage from the vendor's API. Should never throw —
   *  adapters that fail return an empty array and log warning. The
   *  edge function continues with the other vendors. */
  fetchSnapshots(): Promise<VendorUsageSnapshot[]>;
}

export type AlertThreshold = 'warn' | 'alert' | 'critical';

export interface ThresholdLadder {
  warn: number;     // pct of limit, e.g. 70
  alert: number;    // e.g. 85
  critical: number; // e.g. 95
}

/** Threshold ladders by category, per OPERATIONAL_MONITORING_SPEC.md. */
export const LADDERS: Record<SnapshotCategory, ThresholdLadder> = {
  soft_quota:   { warn: 70, alert: 85, critical: 95 },
  hard_cliff:   { warn: 50, alert: 75, critical: 90 },
  cost_runaway: { warn: 50, alert: 75, critical: 90 },
};

/** Returns the highest threshold crossed by the snapshot, or null
 *  if none. Snapshots without a limit_value can't cross thresholds
 *  (used by cost_runaway adapters that defer ceiling to vendor-side). */
export function thresholdCrossed(s: VendorUsageSnapshot): AlertThreshold | null {
  if (s.limit_value === null || s.limit_value <= 0) return null;
  const pct = (s.current_value / s.limit_value) * 100;
  const ladder = LADDERS[s.category];
  if (pct >= ladder.critical) return 'critical';
  if (pct >= ladder.alert) return 'alert';
  if (pct >= ladder.warn) return 'warn';
  return null;
}
