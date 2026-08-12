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
import { PageLayout } from '@/components/layout/PageLayout';
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
import { useAppTranslation } from '@/hooks/useAppTranslation';
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
  const { t } = useAppTranslation();
  const { workspace } = useApp();
  const workspaceId = workspace?.id;

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
      toast.error(t('reports.no_active_workspace'));
      return;
    }
    if (periodStart > periodEnd) {
      toast.error(t('reports.period_order_error'));
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
        t('reports.portfolio_generated_toast', {
          included: result.leaseCount,
          excluded: result.excludedCount,
        }),
      );
    } catch (e: any) {
      toast.error(e?.message ?? t('reports.portfolio_failed'));
    }
  }

  async function handleDownload(path: string | null, name: string) {
    if (!path) {
      toast.error(t('reports.artifact_not_available'));
      return;
    }
    const { data, error } = await supabase.storage
      .from('lease-reports')
      .createSignedUrl(path, 120);
    if (error || !data?.signedUrl) {
      toast.error(t('reports.download_link_failed'));
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
        title={t('reports.portfolio_reports_title')}
        subtitle={t('reports.portfolio_reports_subtitle')}
      />
      <PageLayout>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('reports.generate_report')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label className="text-xs">{t('reports.period_scope')}</Label>
                <Select value={scope} onValueChange={(v) => handleScopeChange(v as ReportScope)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">{t('rent_schedule.monthly')}</SelectItem>
                    <SelectItem value="quarterly">{t('reports.scope_quarterly')}</SelectItem>
                    <SelectItem value="annual">{t('rent_schedule.annual')}</SelectItem>
                    <SelectItem value="custom_range">{t('reports.scope_custom')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">{t('reports.period_start')}</Label>
                <Input
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">{t('reports.period_end')}</Label>
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
                    ? t('reports.rendering_pdf')
                    : stage === 'uploading'
                      ? t('reports.uploading')
                      : stage === 'finalizing'
                        ? t('reports.finalizing')
                        : t('reports.generating_ellipsis')}
                </>
              ) : (
                t('reports.generate_portfolio_report')
              )}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t('reports.portfolio_report_help')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('reports.recent_portfolio_reports')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {historyLoading ? (
              <p className="text-sm text-muted-foreground">{t('workspace.watchlist.loading')}</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('reports.no_portfolio_reports')}
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
                      {t('reports.included_count', { count: r.lease_count })} ·{' '}
                      {t('reports.excluded_count', { count: r.excluded_lease_count })}
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
          {t('reports.single_lease_reports_hint')}{' '}
          <Link to="/app/reports/disclosure" className="underline">
            /app/reports/disclosure
          </Link>
          .
        </p>
      </PageLayout>
    </AppLayout>
  );
}
