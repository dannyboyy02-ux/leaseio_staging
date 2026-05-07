// Phase 8 — Workspace report-settings card.
//
// Surfaces the five workspace report-settings columns added by the
// Phase 8 migration:
//   report_organization_name           (defaults to workspace.name)
//   report_fiscal_year_start_month     (1..12, default 1)
//   report_rounding_precision          (0..6, default 2)
//   report_artifact_retention_days     (1..730, default 90)
//   report_default_discount_method     (workspace_default | risk_free_rate
//                                       | incremental_borrowing_rate | custom)
//
// Self-contained: loads its own state from the workspaces row and
// writes back via the supabase client. Only admin/owner can save (the
// component disables when canEdit is false).

import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';

const DISCOUNT_METHODS: Array<{ value: string; label: string }> = [
  { value: 'workspace_default', label: 'Workspace default' },
  { value: 'risk_free_rate', label: 'Risk-free rate' },
  { value: 'incremental_borrowing_rate', label: 'Incremental borrowing rate' },
  { value: 'custom', label: 'Custom' },
];

interface Props {
  workspaceId: string;
  canEdit: boolean;
}

export function ReportSettingsCard({ workspaceId, canEdit }: Props) {
  const [orgName, setOrgName] = useState('');
  const [fiscalStart, setFiscalStart] = useState('1');
  const [rounding, setRounding] = useState('2');
  const [retention, setRetention] = useState('90');
  const [method, setMethod] = useState('workspace_default');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('workspaces')
        .select(
          'name, report_organization_name, report_fiscal_year_start_month, report_rounding_precision, report_artifact_retention_days, report_default_discount_method',
        )
        .eq('id', workspaceId)
        .maybeSingle();
      if (cancelled || !data) {
        setLoading(false);
        return;
      }
      const w = data as any;
      setOrgName(w.report_organization_name ?? w.name ?? '');
      setFiscalStart(String(w.report_fiscal_year_start_month ?? 1));
      setRounding(String(w.report_rounding_precision ?? 2));
      setRetention(String(w.report_artifact_retention_days ?? 90));
      setMethod(w.report_default_discount_method ?? 'workspace_default');
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  async function handleSave() {
    const fiscal = Number(fiscalStart);
    const round = Number(rounding);
    const retain = Number(retention);
    if (!Number.isInteger(fiscal) || fiscal < 1 || fiscal > 12) {
      toast.error('Fiscal year start month must be between 1 and 12');
      return;
    }
    if (!Number.isInteger(round) || round < 0 || round > 6) {
      toast.error('Rounding precision must be between 0 and 6');
      return;
    }
    if (!Number.isInteger(retain) || retain < 1 || retain > 730) {
      toast.error('Retention days must be between 1 and 730');
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from('workspaces')
      .update({
        report_organization_name: orgName.trim() || null,
        report_fiscal_year_start_month: fiscal,
        report_rounding_precision: round,
        report_artifact_retention_days: retain,
        report_default_discount_method: method,
      })
      .eq('id', workspaceId);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Report settings saved');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Disclosure Reports</CardTitle>
        <CardDescription>
          Defaults applied to ASC 842 disclosure reports generated from
          this workspace. Each report snapshots these values at
          generation time, so reports stay reproducible after settings
          change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="report-org-name">Organization name on reports</Label>
              <Input
                id="report-org-name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                disabled={!canEdit}
                placeholder="Defaults to workspace name"
              />
              <p className="text-xs text-muted-foreground">
                Appears in the report header and JSON metadata.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="report-fiscal">Fiscal year start month</Label>
                <Input
                  id="report-fiscal"
                  type="number"
                  min={1}
                  max={12}
                  value={fiscalStart}
                  onChange={(e) => setFiscalStart(e.target.value)}
                  disabled={!canEdit}
                />
                <p className="text-xs text-muted-foreground">
                  1 = January (default for calendar-year fiscal).
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="report-rounding">Rounding precision (decimals)</Label>
                <Input
                  id="report-rounding"
                  type="number"
                  min={0}
                  max={6}
                  value={rounding}
                  onChange={(e) => setRounding(e.target.value)}
                  disabled={!canEdit}
                />
                <p className="text-xs text-muted-foreground">
                  Default 2. Range 0–6.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="report-retention">Artifact retention (days)</Label>
                <Input
                  id="report-retention"
                  type="number"
                  min={1}
                  max={730}
                  value={retention}
                  onChange={(e) => setRetention(e.target.value)}
                  disabled={!canEdit}
                />
                <p className="text-xs text-muted-foreground">
                  Reports older than this become eligible for cleanup
                  (cron not yet implemented; tracked in KNOWN_ISSUES #12).
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="report-method">Default discount-rate method</Label>
                <Select value={method} onValueChange={setMethod} disabled={!canEdit}>
                  <SelectTrigger id="report-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DISCOUNT_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Methodology label captured on each report.
                </p>
              </div>
            </div>

            <Button
              variant="accent"
              onClick={handleSave}
              disabled={!canEdit || saving}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              {saving ? 'Saving…' : 'Save report settings'}
            </Button>
            {!canEdit && (
              <p className="text-xs text-muted-foreground">
                Read-only — only workspace admins or the owner can edit.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
