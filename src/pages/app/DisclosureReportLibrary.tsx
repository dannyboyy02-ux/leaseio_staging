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
  const { workspace } = useApp();
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
        toast.message('No finalized leases yet — lock a lease first.');
      } else {
        toast.success(`Consolidated report ready (${result.leaseCount} leases)`);
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not generate consolidated report');
      resetConsolidated();
    }
  }

  function consolidatedLabel(): string {
    switch (consolidatedStage) {
      case 'requesting':
        return 'Assembling lease data…';
      case 'rendering':
        return 'Rendering PDF…';
      case 'downloading':
        return 'Downloading…';
      default:
        return 'Generate consolidated report';
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (!workspaceId) {
          if (!cancelled) {
            setLoadError('No active workspace selected.');
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
        title="Disclosure Reports"
        subtitle="ASC 842 disclosure reports generated for this workspace."
      />
      <div className="px-6 py-6 space-y-4 max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Consolidated workspace report</CardTitle>
            <CardDescription>
              One PDF covering every finalized lease in this workspace. Includes a cover page,
              table of contents, and the full ASC 842 disclosure for each lease.
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
          <span className="text-sm text-muted-foreground">Filter:</span>
          <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="lease_disclosure">Single lease</SelectItem>
              <SelectItem value="portfolio_period">Portfolio period</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {loading ? 'Loading…' : `${filtered.length} report(s)`}
            </CardTitle>
            {loadError && (
              <p className="text-xs text-red-700 font-mono mt-2">{loadError}</p>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            {!loading && filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No reports yet. Generate from a lease's Documents tab or the{' '}
                <Link to="/app/admin/reports" className="underline">
                  portfolio admin page
                </Link>
                .
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
                        <Badge variant="outline">{isLease ? 'lease' : 'portfolio'}</Badge>
                        <Badge variant="secondary">{r.report_scope}</Badge>
                        <Badge variant={r.status === 'ready' ? 'default' : 'secondary'}>
                          {r.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(r.generated_at).toLocaleString()}
                        {!isLease && r.period_start && (
                          <>
                            {' · '}
                            {r.period_start} → {r.period_end}
                            {' · '}
                            {r.lease_count} included
                            {r.excluded_lease_count
                              ? `, ${r.excluded_lease_count} excluded`
                              : ''}
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {isLease && r.lease_id && (
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/app/leases/${r.lease_id}/reports/${r.id}`}>
                            Open
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
