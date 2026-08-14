// Per-lease discount rate (IBR) editor.
//
// ASC 842 requires the lessee to assess a discount rate at lease
// inception that reflects the lease term, collateral, the lessee's
// credit standing, and the prevailing economic environment. A single
// workspace-wide rate is at best a starting point — it is NOT
// compliant for the underlying measurement.
//
// This card lives on the lease detail page (LeaseReview financial
// section) and lets editors / admins / owner override the rate on a
// per-lease basis with an audit trail. Effective rate displayed below
// is what `generate-lease-report` will use when producing the ASC 842
// disclosure report.

import { useEffect, useState } from 'react';
import { Loader2, Save, X } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { formatLocalizedDateTime } from '@/lib/dateFormatters';

interface Props {
  leaseId: string;
  workspaceId: string;
  canEdit: boolean;
}

interface State {
  perLeaseRate: number | null;
  basis: string | null;
  setAt: string | null;
  setByLabel: string | null;
  workspaceRate: number | null;
}

export function LeaseDiscountRateCard({ leaseId, workspaceId, canEdit }: Props) {
  const { t, language } = useAppTranslation();
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draftRate, setDraftRate] = useState('');
  const [draftBasis, setDraftBasis] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [leaseRes, workspaceRes] = await Promise.all([
          supabase
            .from('leases')
            .select('discount_rate, discount_rate_basis, discount_rate_set_at, discount_rate_set_by')
            .eq('id', leaseId)
            .maybeSingle(),
          supabase
            .from('workspaces')
            .select('discount_rate')
            .eq('id', workspaceId)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        const lease = (leaseRes.data ?? {}) as any;
        const workspace = (workspaceRes.data ?? {}) as any;

        let setByLabel: string | null = null;
        if (lease.discount_rate_set_by) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('email, full_name')
            .eq('id', lease.discount_rate_set_by)
            .maybeSingle();
          if (cancelled) return;
          setByLabel = (profile as any)?.full_name || (profile as any)?.email || null;
        }

        setState({
          perLeaseRate: lease.discount_rate ?? null,
          basis: lease.discount_rate_basis ?? null,
          setAt: lease.discount_rate_set_at ?? null,
          setByLabel,
          workspaceRate: workspace.discount_rate ?? null,
        });
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error('[LeaseDiscountRateCard] load failed', e);
        toast.error(e?.message ?? t('leases.discount.load_failed'));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId, workspaceId]);

  function startEdit() {
    setDraftRate(state?.perLeaseRate !== null && state?.perLeaseRate !== undefined ? String(state.perLeaseRate) : '');
    setDraftBasis(state?.basis ?? '');
    setEditing(true);
  }

  async function handleSave() {
    const rate = Number(draftRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 50) {
      toast.error(t('leases.discount.rate_invalid'));
      return;
    }
    const basis = draftBasis.trim();
    if (basis.length < 10) {
      toast.error(t('leases.discount.basis_min'));
      return;
    }
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t('leases.errors.not_authenticated'));

      const now = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('leases')
        .update({
          discount_rate: rate,
          discount_rate_basis: basis,
          discount_rate_set_at: now,
          discount_rate_set_by: user.id,
        })
        .eq('id', leaseId);
      if (updateError) throw new Error(updateError.message);

      const { error: logError } = await supabase
        .from('lease_activity_log')
        .insert({
          lease_id: leaseId,
          user_id: user.id,
          activity_type: 'discount_rate_set',
          details: {
            new_rate: rate,
            previous_rate: state?.perLeaseRate ?? null,
            basis,
            workspace_default: state?.workspaceRate ?? null,
          },
        });
      if (logError) {
        // eslint-disable-next-line no-console
        console.warn('[LeaseDiscountRateCard] activity log insert failed', logError);
      }

      setState((s) =>
        s
          ? { ...s, perLeaseRate: rate, basis, setAt: now, setByLabel: user.email ?? null }
          : s,
      );
      setEditing(false);
      toast.success(t('leases.discount.updated'));
    } catch (e: any) {
      toast.error(e?.message ?? t('leases.errors.save_failed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearOverride() {
    if (!state?.perLeaseRate) return;
    setClearing(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error(t('leases.errors.not_authenticated'));

      const previous = state.perLeaseRate;
      const previousBasis = state.basis;

      const { error: updateError } = await supabase
        .from('leases')
        .update({
          discount_rate: null,
          discount_rate_basis: null,
          discount_rate_set_at: null,
          discount_rate_set_by: null,
        })
        .eq('id', leaseId);
      if (updateError) throw new Error(updateError.message);

      const { error: logError } = await supabase
        .from('lease_activity_log')
        .insert({
          lease_id: leaseId,
          user_id: user.id,
          activity_type: 'discount_rate_cleared',
          details: {
            previous_rate: previous,
            previous_basis: previousBasis,
            falls_back_to_workspace_default: state.workspaceRate,
          },
        });
      if (logError) {
        // eslint-disable-next-line no-console
        console.warn('[LeaseDiscountRateCard] activity log insert failed', logError);
      }

      setState((s) =>
        s
          ? {
              ...s,
              perLeaseRate: null,
              basis: null,
              setAt: null,
              setByLabel: null,
            }
          : s,
      );
      toast.success(t('leases.discount.cleared'));
    } catch (e: any) {
      toast.error(e?.message ?? t('leases.discount.clear_failed'));
    } finally {
      setClearing(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('leases.discount.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('workspace.watchlist.loading')}</p>
        </CardContent>
      </Card>
    );
  }

  const effective = state?.perLeaseRate ?? state?.workspaceRate ?? null;
  const isOverridden = state?.perLeaseRate !== null && state?.perLeaseRate !== undefined;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{t('leases.discount.title')}</CardTitle>
            <CardDescription>
              {t('leases.discount.desc')}
            </CardDescription>
          </div>
          {isOverridden ? (
            <Badge variant="default">{t('leases.discount.badge_override')}</Badge>
          ) : (
            <Badge variant="outline">{t('leases.discount.workspace_default')}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {t('leases.discount.effective_rate')}
            </p>
            <p className="text-2xl font-bold mt-1">
              {effective !== null ? `${Number(effective).toFixed(2)}%` : '—'}
            </p>
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              {t('leases.discount.workspace_default')}
            </p>
            <p className="text-2xl font-bold mt-1 text-muted-foreground">
              {state?.workspaceRate !== null && state?.workspaceRate !== undefined
                ? `${Number(state.workspaceRate).toFixed(2)}%`
                : '—'}
            </p>
          </div>
        </div>

        {isOverridden && state?.basis && (
          <div className="rounded-md border px-3 py-2 text-sm">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
              {t('leases.discount.methodology')}
            </p>
            <p>{state.basis}</p>
            {state.setAt && (
              <p className="text-xs text-muted-foreground mt-2">
                {state.setByLabel
                  ? t('leases.discount.set_at_by', {
                      date: formatLocalizedDateTime(state.setAt, language),
                      name: state.setByLabel,
                    })
                  : t('leases.discount.set_at', {
                      date: formatLocalizedDateTime(state.setAt, language),
                    })}
              </p>
            )}
          </div>
        )}

        {!editing && canEdit && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={startEdit}>
              {isOverridden ? t('leases.discount.edit_override') : t('leases.discount.override_cta')}
            </Button>
            {isOverridden && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleClearOverride}
                disabled={clearing}
              >
                {clearing ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t('leases.discount.clear_override')}
              </Button>
            )}
          </div>
        )}

        {editing && (
          <div className="space-y-3 rounded-md border border-blue-300 bg-blue-50 p-3">
            <div className="space-y-2">
              <Label htmlFor="lease-discount-rate">{t('leases.discount.rate_label')}</Label>
              <Input
                id="lease-discount-rate"
                type="number"
                step="0.01"
                min={0}
                max={50}
                value={draftRate}
                onChange={(e) => setDraftRate(e.target.value)}
                placeholder={t('leases.discount.rate_placeholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('leases.discount.rate_help')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lease-discount-basis">
                {t('leases.discount.basis_label')}
              </Label>
              <Textarea
                id="lease-discount-basis"
                value={draftBasis}
                onChange={(e) => setDraftBasis(e.target.value)}
                rows={3}
                placeholder={t('leases.discount.basis_placeholder')}
              />
              <p className="text-xs text-muted-foreground">
                {t('leases.discount.basis_help')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t('common.save')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            {t('leases.discount.readonly_note')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
