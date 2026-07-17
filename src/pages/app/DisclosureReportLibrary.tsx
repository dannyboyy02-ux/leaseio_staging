// Phase 8 — Disclosure report library page.
//
// Route: /app/reports/disclosure
//
// Lists all single-lease + portfolio disclosure reports the user can
// access in the current workspace, sortable by date and filterable by
// type. Single-lease rows link to the per-report detail page; portfolio
// rows surface inline download links.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileJson, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate } from '@/lib/dateFormatters';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { supabase } from '@/integrations/supabase/client';
import { useGenerateWorkspaceAsc842Report } from '@/hooks/useGenerateWorkspaceAsc842Report';

interface ReportRow {
  id: string;
  report_type: string;
  report_scope: string;
  lease_id: string | null;
  generated_at: string;
  status: string;
  pdf_storage_path: string | null;
  json_storage_path: string | null;
  organization_name_at_gen: string | null;
  period_start: string | null;
  period_end: string | null;
  lease_count: number;
  excluded_lease_count: number;
}

type Filter = 'all' | 'lease_disclosure' | 'portfolio_period';

export default function DisclosureReportLibrary() {
  const { t } = useAppTranslation();
  const { language } = useLanguage();
  const { workspace, userRole } = useApp();
  const isAdminRole = userRole === 'admin' || userRole === 'owner';
  const workspaceId = workspace?.id;
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const {
    generate: generateConsolidated,
    stage: consolidatedStage,
    isWorking: consolidatedWorking,
    reset: resetConsolidated,
  } = useGenerateWorkspaceAsc842Report();

  async function handleGenerateConsolidated() {
    if (!workspaceId) return;
    try {
      const result = await generateConsolidated(workspaceId);
      if (result.leaseCount === 0) {
        toast.message(t('reports.no_finalized_leases'));
      } else {
        toast.success(t('reports.consolidated_ready', { count: result.leaseCount }));
      }
    } catch (e: any) {
      toast.error(e?.message ?? t('reports.consolidated_failed'));
      resetConsolidated();
    }
  }

  function consolidatedLabel(): string {
    switch (consolidatedStage) {
      case 'requesting':
        return t('reports.assembling_data');
      case 'rendering':
        return t('reports.rendering_pdf');
      case 'downloading':
        return t('reports.downloading');
      default:
        return t('reports.generate_consolidated');
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (!workspaceId) {
          if (!cancelled) {
            setLoadError(t('reports.no_workspace_selected'));
            setLoading(false);
          }
          return;
        }
        setLoading(true);
        const { data, error } = await supabase
          .from('lease_reports')
          .select(
            'id, report_type, report_scope, lease_id, generated_at, status, pdf_storage_path, json_storage_path, organization_name_at_gen, period_start, period_end, lease_count, excluded_lease_count',
          )
          .eq('workspace_id', workspaceId!)
          .order('generated_at', { ascending: false })
          .limit(200);
        if (cancelled) return;
        if (error) {
          // eslint-disable-next-line no-console
          console.error('[DisclosureReportLibrary] load error', error);
          setLoadError(error.message);
          toast.error(error.message);
          setLoading(false);
          return;
        }
        setRows((data ?? []) as ReportRow[]);
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[DisclosureReportLibrary] load threw', e);
        setLoadError(e?.message ?? String(e));
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const filtered = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.report_type === filter)),
    [rows, filter],
  );

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
        title={t('reports.disclosure_reports_title')}
        subtitle={t('reports.disclosure_reports_subtitle')}
      />
      <div className="px-6 py-6 space-y-4 max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('reports.consolidated_workspace_report')}</CardTitle>
            <CardDescription>
              {t('reports.consolidated_desc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleGenerateConsolidated}
              disabled={consolidatedWorking || !workspaceId}
            >
              {consolidatedWorking ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileText className="h-4 w-4 mr-2" />
              )}
              {consolidatedLabel()}
            </Button>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('reports.filter_label')}</span>
          <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('reports.filter_all')}</SelectItem>
              <SelectItem value="lease_disclosure">{t('reports.filter_single_lease')}</SelectItem>
              <SelectItem value="portfolio_period">{t('reports.filter_portfolio_period')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {loading ? t('workspace.watchlist.loading') : t('reports.report_count', { count: filtered.length })}
            </CardTitle>
            {loadError && (
              <p className="text-xs text-red-700 font-mono mt-2">{loadError}</p>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {!loading && filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {/* Viewers can't generate — don't promise them a button that
                    isn't there. */}
                {userRole === 'viewer' ? t('reports.no_reports_viewer') : t('reports.no_reports_empty')}{userRole === 'viewer' ? '' : ' '}
                {isAdminRole ? (
                  <>
                    {t('reports.no_reports_admin_suffix')}{' '}
                    <Link to="/app/admin/reports" className="underline">
                      {t('reports.portfolio_admin_page')}
                    </Link>
                    .
                  </>
                ) : (
                  t('reports.no_reports_member_suffix')
                )}
              </p>
            ) : (
              filtered.map((r) => {
                const isLease = r.report_type === 'lease_disclosure';
                return (
                  <div
                    key={r.id}
                    className="flex flex-col md:flex-row md:items-center md:justify-between rounded-md border px-3 py-2.5 gap-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {/* One axis, one badge: the localized scope carries it
                            (the old type badge just repeated it in lowercase). */}
                        <Badge variant="secondary">{t(`reports.scope.${r.report_scope}`, { defaultValue: r.report_scope })}</Badge>
                        <Badge variant={r.status === 'ready' ? 'default' : 'secondary'}>
                          {t(`reports.status.${r.status}`, { defaultValue: r.status })}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatLocalizedDate(r.generated_at, language, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        {!isLease && r.period_start && (
                          <>
                            {' · '}
                            {formatLocalizedDate(r.period_start, language)} → {formatLocalizedDate(r.period_end, language)}
                            {' · '}
                            {t('reports.included_count', { count: r.lease_count })}
                            {r.excluded_lease_count
                              ? `, ${t('reports.excluded_count', { count: r.excluded_lease_count })}`
                              : ''}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isLease && r.lease_id && (
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/app/leases/${r.lease_id}/reports/${r.id}`}>
                            {t('common.open')}
                          </Link>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!r.pdf_storage_path}
                        onClick={() =>
                          handleDownload(
                            r.pdf_storage_path,
                            `${isLease ? 'lease' : 'portfolio'}-${r.id.slice(0, 8)}.pdf`,
                          )
                        }
                      >
                        <FileText className="h-3.5 w-3.5 mr-1.5" /> PDF
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!r.json_storage_path}
                        onClick={() =>
                          handleDownload(
                            r.json_storage_path,
                            `${isLease ? 'lease' : 'portfolio'}-${r.id.slice(0, 8)}.json`,
                          )
                        }
                      >
                        <FileJson className="h-3.5 w-3.5 mr-1.5" /> JSON
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
