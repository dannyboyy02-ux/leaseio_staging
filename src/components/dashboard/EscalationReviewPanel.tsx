import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { useToast } from '@/hooks/use-toast';
import { isWorkspaceReadOnly } from '@/lib/workspaceReadOnly';

interface EscalationLease {
  id: string;
  tenant_name: string | null;
  request_title: string | null;
  filename: string | null;
  escalation_type: string | null;
  rent_escalation_type: string | null;
  escalation_rate: number | null;
  monthly_payment: number | null;
  model_locked: boolean | null;
}

export function EscalationReviewPanel() {
  const { t } = useAppTranslation();
  const { workspace } = useApp();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Vault / cancellation-grace / soft-deleted workspaces are read-only — the
  // escalation edit would hit an RLS error, so hide the panel entirely.
  const isReadOnly = isWorkspaceReadOnly(workspace);

  const [editingLease, setEditingLease] = useState<EscalationLease | null>(null);
  const [newEscalationType, setNewEscalationType] = useState('');
  const [newEscalationRate, setNewEscalationRate] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: leases = [] } = useQuery({
    queryKey: ['escalation-review', workspace?.id],
    enabled: !!workspace?.id && !isReadOnly,
    queryFn: async (): Promise<EscalationLease[]> => {
      const { data, error } = await supabase
        .from('leases')
        .select(
          'id, tenant_name, request_title, filename, escalation_type, rent_escalation_type, escalation_rate, monthly_payment, model_locked'
        )
        .eq('workspace_id', workspace!.id)
        .eq('needs_escalation_review', true)
        // Phase 3: extend with chain vocabulary equivalents (active is
        // identical in both vocabularies).
        .in('lifecycle_status', [
          'submitted', 'under_review', 'approved', 'executed', 'active',
          'concept_submitted', 'concept_under_review', 'in_negotiation',
          'final_review', 'pending_counter_signature', 'fully_executed',
        ]);
      if (error) throw error;
      return (data || []) as EscalationLease[];
    },
  });

  if (isReadOnly || leases.length === 0) return null;

  const displayName = (lease: EscalationLease) =>
    lease.tenant_name || lease.request_title || lease.filename || t('dashboard.unnamed_lease');

  const openEdit = (lease: EscalationLease) => {
    setEditingLease(lease);
    setNewEscalationType(lease.escalation_type || 'index');
    setNewEscalationRate(lease.escalation_rate != null ? String(lease.escalation_rate) : '');
  };

  const handleSave = async () => {
    if (!editingLease) return;
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;
      const escalationType = newEscalationType === 'none' ? null : newEscalationType;
      const escalationRate =
        newEscalationType === 'percent' && newEscalationRate ? Number(newEscalationRate) : null;

      const { data: updatedRows, error } = await supabase
        .from('leases')
        .update({
          // NB: do NOT write rent_escalation_type — that column holds the raw
          // extracted clause text (shown in the Rent Roll export + locked view
          // as the audit source). The false CPI-risk signal is cleared at the
          // reader instead: UpcomingRisks/UpcomingEvents ignore the raw hint
          // once needs_escalation_review is false (a human has confirmed).
          escalation_type: escalationType,
          escalation_rate: escalationRate,
          needs_escalation_review: false,
        })
        .eq('id', editingLease.id)
        .eq('workspace_id', workspace!.id)
        .select('id');

      if (error) throw error;
      if (!updatedRows || updatedRows.length === 0) throw new Error('no_rows');

      // Attribute the financial-data edit; best-effort (primary write committed).
      const { error: auditError } = await supabase.from('lease_activity_log').insert({
        lease_id: editingLease.id,
        user_id: userId,
        activity_type: 'escalation_review_resolved',
        details: {
          escalation_type: escalationType,
          escalation_rate: escalationRate,
          previous_escalation_type: editingLease.escalation_type,
          previous_rent_escalation_type: editingLease.rent_escalation_type,
          source: 'dashboard_escalation_review_panel',
        },
      });
      if (auditError) console.error('Failed to log escalation resolution:', auditError);

      toast({
        title: t('dashboard.escalation_updated'),
        description: t('dashboard.escalation_updated_desc'),
      });
      queryClient.invalidateQueries({ queryKey: ['escalation-review', workspace?.id] });
      queryClient.invalidateQueries({ queryKey: ['financial-summary', workspace?.id] });
      setEditingLease(null);
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      const description = /lock/i.test(msg)
        ? t('dashboard.escalation_save_locked')
        : t('dashboard.escalation_save_failed');
      toast({ title: t('dashboard.save_failed'), description, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card className="border-l-4 border-l-amber-400 bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            {t('dashboard.escalation_review_title')}
            <Badge variant="secondary" className="ml-auto text-xs">
              {leases.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">
            {t('dashboard.escalation_review_desc')}
          </p>
          <div className="space-y-2">
            {leases.map(lease => (
              <div
                key={lease.id}
                className="flex items-center justify-between gap-3 rounded-md border border-amber-200 dark:border-amber-800 bg-white dark:bg-background px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{displayName(lease)}</p>
                  {lease.rent_escalation_type && (
                    <p className="text-xs text-muted-foreground truncate">
                      {t('dashboard.raw_clause', { value: lease.rent_escalation_type })}
                    </p>
                  )}
                </div>
                {lease.model_locked ? (
                  // Locked: edits are trigger-rejected — route to the
                  // workbench's unlock-request flow instead (#178).
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 text-xs"
                    onClick={() => navigate(`/app/leases/${lease.id}`)}
                  >
                    {t('notifications.view_lease')}
                    <ChevronRight className="h-3 w-3 ml-1" />
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 text-xs"
                    onClick={() => openEdit(lease)}
                  >
                    {t('dashboard.edit_escalation')}
                    <ChevronRight className="h-3 w-3 ml-1" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editingLease} onOpenChange={open => !open && setEditingLease(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('dashboard.edit_escalation')}</DialogTitle>
          </DialogHeader>
          {editingLease && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">{displayName(editingLease)}</p>
              {editingLease.rent_escalation_type && (
                <div className="rounded-md bg-muted px-3 py-2">
                  <p className="text-xs text-muted-foreground">{t('dashboard.raw_lease_clause')}</p>
                  <p className="text-sm font-mono mt-0.5">{editingLease.rent_escalation_type}</p>
                </div>
              )}
              <div className="space-y-2">
                <Label>{t('review.escalation_type')}</Label>
                <Select value={newEscalationType} onValueChange={setNewEscalationType}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('dashboard.select_type')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('dashboard.escalation_none')}</SelectItem>
                    <SelectItem value="percent">{t('dashboard.escalation_percent')}</SelectItem>
                    <SelectItem value="index">{t('dashboard.escalation_cpi_index')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {newEscalationType === 'percent' && (
                <div className="space-y-2">
                  <Label>{t('dashboard.annual_escalation_rate')}</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder={t('dashboard.rate_placeholder')}
                    value={newEscalationRate}
                    onChange={e => setNewEscalationRate(e.target.value)}
                  />
                </div>
              )}
              {newEscalationType === 'index' && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {t('dashboard.cpi_note')}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingLease(null)}>{t('common.cancel')}</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t('account.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
