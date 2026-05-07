// Phase 8 — Admin portfolio reports page.
//
// Route: /app/admin/reports
//
// Lets workspace admins/editors generate portfolio-period reports
// covering all eligible (model_locked + active + period-overlapping)
// leases in the workspace. Lists historical portfolio reports with
// download links.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileJson, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import {
  useGeneratePortfolioReport,
  type ReportScope,
} from '@/hooks/useGeneratePortfolioReport';

interface PortfolioReportRow {
  id: string;
  generated_at: string;
  report_scope: string;
  period_start: string | null;
  period_end: string | null;
  status: string;
  pdf_storage_path: string | null;
  json_storage_path: string | null;
  lease_count: number;
  excluded_lease_count: number;
}

function shortcutForScope(scope: ReportScope): { start: string; end: string } {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (scope) {
    case 'monthly': {
      const start = new Date(Date.UTC(yyyy, m, 1));
      const end = new Date(Date.UTC(yyyy, m + 1, 0));
      return { start: iso(start), end: iso(end) };
    }
    case 'quarterly': {
      const qStart = m - (m % 3);
      const start = new Date(Date.UTC(yyyy, qStart, 1));
      const end = new Date(Date.UTC(yyyy, qStart + 3, 0));
      return { start: iso(start), end: iso(end) };
    }
    case 'annual': {
      return { start: `${yyyy}-01-01`, end: `${yyyy}-12-31` };
    }
    case 'custom_range':
    default:
      return { start: `${yyyy}-01-01`, end: `${yyyy}-12-31` };
  }
}

function iso(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function PortfolioReportsAdmin() {
  const { currentWorkspace } = useApp();
  const workspaceId = currentWorkspace?.id;

  const [scope, setScope] = useState<ReportScope>('quarterly');
  const initial = useMemo(() => shortcutForScope('quarterly'), []);
  const [periodStart, setPeriodStart] = useState(initial.start);
  const [periodEnd, setPeriodEnd] = useState(initial.end);
  const [history, setHistory] = useState<PortfolioReportRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const { generate, isWorking, stage } = useGeneratePortfolioReport();

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    async function load() {
      setHistoryLoading(true);
      const { data, error } = await supabase
        .from('lease_reports')
        .select(
          'id, generated_at, report_scope, period_start, period_end, status, pdf_storage_path, json_storage_path, lease_count, excluded_lease_count',
        )
        .eq('workspace_id', workspaceId!)
        .eq('report_type', 'portfolio_period')
        .order('generated_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (error) {
        toast.error(error.message);
        setHistoryLoading(false);
        return;
      }
      setHistory((data ?? []) as PortfolioReportRow[]);
      setHistoryLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, isWorking]);

  function handleScopeChange(next: ReportScope) {
    setScope(next);
    if (next !== 'custom_range') {
      const sc = shortcutForScope(next);
      setPeriodStart(sc.start);
      setPeriodEnd(sc.end);
    }
  }

  async function handleGenerate() {
    if (!workspaceId) {
      toast.error('No active workspace');
      return;
    }
    if (periodStart > periodEnd) {
      toast.error('Period start must be on or before period end');
      return;
    }
    try {
      const result = await generate({
        workspaceId,
        reportScope: scope,
        periodStart,
        periodEnd,
      });
      toast.success(
        `Portfolio report generated · ${result.leaseCount} included, ${result.excludedCount} excluded`,
      );
    } catch (e: any) {
      toast.error(e?.message ?? 'Portfolio report failed');
    }
  }

  async function handleDownload(path: string | null, name: string) {
    if (!path) {
      toast.error('Artifact not yet available');
      return;
    }
    const { data, error } = await supabase.storage
      .from('lease-reports')
      .createSignedUrl(path, 120);
    if (error || !data?.signedUrl) {
      toast.error('Could not generate download link');
      return;
    }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = name;
    a.target = '_blank';
    a.click();
  }

  return (
    <AppLayout>
      <AppHeader
        title="Portfolio Reports"
        subtitle="Generate ASC 842 disclosure reports across all eligible leases for a period."
      />
      <div className="px-6 py-6 space-y-6 max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Generate report</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label className="text-xs">Period scope</Label>
                <Select value={scope} onValueChange={(v) => handleScopeChange(v as ReportScope)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="annual">Annual</SelectItem>
                    <SelectItem value="custom_range">Custom range</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Period start</Label>
                <Input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Period end</Label>
                <Input
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
            <Button onClick={handleGenerate} disabled={isWorking}>
              {isWorking ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  {stage === 'rendering'
                    ? 'Rendering PDF…'
                    : stage === 'uploading'
                      ? 'Uploading…'
                      : stage === 'finalizing'
                        ? 'Finalizing…'
                        : 'Generating…'}
                </>
              ) : (
                'Generate Portfolio Report'
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              Includes only model-locked + active leases whose term overlaps
              the selected period. Other leases are surfaced in the report's
              exclusions section.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent portfolio reports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {historyLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No portfolio reports yet. Generate one above.
              </p>
            ) : (
              history.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-col md:flex-row md:items-center md:justify-between rounded-md border px-3 py-2.5 gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{r.report_scope}</Badge>
                      <Badge
                        variant={r.status === 'ready' ? 'default' : 'secondary'}
                      >
                        {r.status}
                      </Badge>
                      <span className="text-sm font-medium">
                        {r.period_start} → {r.period_end}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(r.generated_at).toLocaleString()} ·{' '}
                      {r.lease_count} included · {r.excluded_lease_count}{' '}
                      excluded
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        handleDownload(
                          r.pdf_storage_path,
                          `portfolio-${r.report_scope}-${r.period_start}.pdf`,
                        )
                      }
                      disabled={!r.pdf_storage_path}
                    >
                      <FileText className="h-3.5 w-3.5 mr-1.5" /> PDF
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        handleDownload(
                          r.json_storage_path,
                          `portfolio-${r.report_scope}-${r.period_start}.json`,
                        )
                      }
                      disabled={!r.json_storage_path}
                    >
                      <FileJson className="h-3.5 w-3.5 mr-1.5" /> JSON
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Looking for single-lease reports? Generate them from the lease
          detail page's Documents tab. View the full report library at{' '}
          <Link to="/app/reports/disclosure" className="underline">
            /app/reports/disclosure
          </Link>
          .
        </p>
      </div>
    </AppLayout>
  );
}
