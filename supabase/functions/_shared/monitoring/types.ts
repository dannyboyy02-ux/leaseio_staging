// Deno mirror of src/adapters/monitoring/types.ts. Keep in sync.
// Edge functions cannot import from src/, so this file duplicates
// the same interfaces verbatim.

export type SnapshotCategory = 'soft_quota' | 'hard_cliff' | 'cost_runaway';

export interface VendorUsageSnapshot {
  vendor: string;
  metric: string;
  current_value: number;
  limit_value: number | null;
  tier: string;
  category: SnapshotCategory;
  metadata?: Record<string, unknown>;
}

export interface MonitoringAdapter {
  vendor: string;
  fetchSnapshots(): Promise<VendorUsageSnapshot[]>;
}

export type AlertThreshold = 'warn' | 'alert' | 'critical';

export interface ThresholdLadder {
  warn: number;
  alert: number;
  critical: number;
}

export const LADDERS: Record<SnapshotCategory, ThresholdLadder> = {
  soft_quota:   { warn: 70, alert: 85, critical: 95 },
  hard_cliff:   { warn: 50, alert: 75, critical: 90 },
  cost_runaway: { warn: 50, alert: 75, critical: 90 },
};

export function thresholdCrossed(s: VendorUsageSnapshot): AlertThreshold | null {
  if (s.limit_value === null || s.limit_value <= 0) return null;
  const pct = (s.current_value / s.limit_value) * 100;
  const ladder = LADDERS[s.category];
  if (pct >= ladder.critical) return 'critical';
  if (pct >= ladder.alert) return 'alert';
  if (pct >= ladder.warn) return 'warn';
  return null;
}
