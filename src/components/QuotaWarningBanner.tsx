// QuotaWarningBanner — Phase 3 of OPERATIONAL_MONITORING_SPEC.md
//
// Mounted in AppLayout. Reads the latest workspace_quota_snapshots
// for the current workspace, picks the highest pct_of_limit metric,
// and renders a banner if ≥80%.
//
// Behavior tiers per spec:
//   - 80%–94% : informational, dismissible (localStorage-gated per
//               metric so dismissal sticks for that metric until
//               new data crosses the threshold again)
//   - 95%+   : persistent, action-suggesting; cannot be dismissed.
//
// CTA links to billing/upgrade flow.

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { Button } from '@/components/ui/button';

interface QuotaSnapshot {
  metric: string;
  current_value: number;
  limit_value: number | null;
  pct_of_limit: number | null;
  tier: string | null;
  recorded_at: string;
}

const METRIC_LABELS: Record<string, string> = {
  active_leases:        'active leases',
  archived_leases:      'archived leases',
  monthly_extractions:  'extractions this month',
  member_count:         'workspace members',
};

const METRIC_NOUN: Record<string, string> = {
  active_leases:       'active lease cap',
  archived_leases:     'archive cap',
  monthly_extractions: 'monthly extraction cap',
  member_count:        'member cap',
};

function dismissalKey(workspaceId: string, metric: string, pctBucket: number): string {
  // Bucket the pct so a dismissal at 82% sticks until pct crosses
  // a new bucket (90, 95). Returning to 80% later restarts the
  // dismissal lifecycle.
  return `quota-banner-dismissed:${workspaceId}:${metric}:${Math.floor(pctBucket / 5) * 5}`;
}

export function QuotaWarningBanner() {
  const { workspace } = useApp();
  const [snapshots, setSnapshots] = useState<QuotaSnapshot[]>([]);
  const [dismissedTick, setDismissedTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!workspace?.id) return;

    (async () => {
      // Pull latest snapshot per metric for this workspace.
      // workspace_quota_snapshots is append-only; the most recent row
      // per (workspace_id, metric) is the current truth.
      const { data, error } = await supabase
        .from('workspace_quota_snapshots' as any)
        .select('metric, current_value, limit_value, pct_of_limit, tier, recorded_at')
        .eq('workspace_id', workspace.id)
        .order('recorded_at', { ascending: false })
        .limit(50);
      if (cancelled || error) return;
      // Dedupe to most-recent-per-metric
      const seen = new Set<string>();
      const latest: QuotaSnapshot[] = [];
      for (const s of (data ?? []) as unknown as QuotaSnapshot[]) {
        if (seen.has(s.metric)) continue;
        seen.add(s.metric);
        latest.push(s);
      }
      setSnapshots(latest);
    })();

    return () => { cancelled = true; };
  }, [workspace?.id]);

  const banner = useMemo(() => {
    if (!workspace?.id) return null;
    // Find the highest-pct snapshot ≥ 80%, ignoring null pct_of_limit
    const overThreshold = snapshots
      .filter((s) => s.pct_of_limit !== null && s.pct_of_limit >= 80)
      .sort((a, b) => (b.pct_of_limit ?? 0) - (a.pct_of_limit ?? 0));
    return overThreshold[0] ?? null;
    // dismissedTick read here forces a re-evaluation on dismissal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots, workspace?.id, dismissedTick]);

  if (!banner || !workspace?.id) return null;

  const pct = banner.pct_of_limit ?? 0;
  const isCritical = pct >= 95;
  const dismissed = !isCritical && typeof localStorage !== 'undefined'
    ? localStorage.getItem(dismissalKey(workspace.id, banner.metric, pct)) === '1'
    : false;
  if (dismissed) return null;

  const label = METRIC_LABELS[banner.metric] ?? banner.metric.replace(/_/g, ' ');
  const noun = METRIC_NOUN[banner.metric] ?? `${banner.metric} cap`;

  const handleDismiss = () => {
    if (isCritical) return;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(dismissalKey(workspace.id, banner.metric, pct), '1');
    }
    setDismissedTick((t) => t + 1);
  };

  return (
    <div
      className={
        isCritical
          ? 'border-b border-red-300 bg-red-50 px-4 py-3'
          : 'border-b border-amber-300 bg-amber-50 px-4 py-3'
      }
      role="alert"
    >
      <div className="max-w-7xl mx-auto flex items-start gap-3">
        <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${isCritical ? 'text-red-700' : 'text-amber-700'}`} />
        <div className="flex-1">
          <p className={`text-sm font-medium ${isCritical ? 'text-red-900' : 'text-amber-900'}`}>
            {isCritical ? 'Critical: ' : ''}You've used {Math.round(pct)}% of your {noun}
          </p>
          <p className={`text-xs ${isCritical ? 'text-red-800' : 'text-amber-800'}`}>
            {banner.current_value.toLocaleString()} of {banner.limit_value?.toLocaleString()} {label}{banner.tier ? ` on the ${banner.tier} plan` : ''}.
            {isCritical ? ' Upgrade to keep growing without interruption.' : ' Plan ahead for an upgrade.'}
          </p>
        </div>
        {/* Packs raise the abstraction + active-lease caps, so offer a pack CTA
            on exactly those two metrics (not archive/member caps). */}
        {(banner.metric === 'monthly_extractions' || banner.metric === 'active_leases') && (
          <Button asChild size="sm" variant="outline">
            <Link to="/app/settings/account?tab=subscription&packs=1">Add capacity</Link>
          </Button>
        )}
        <Button asChild size="sm" variant={isCritical ? 'destructive' : 'outline'}>
          <Link to="/app/settings/account?tab=subscription">
            {isCritical ? 'Upgrade now' : 'View plans'}
          </Link>
        </Button>
        {!isCritical && (
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="p-1 rounded hover:bg-amber-100 text-amber-700"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
