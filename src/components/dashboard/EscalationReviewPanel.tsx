import { useState } from 'react';
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
import { useToast } from '@/hooks/use-toast';

interface EscalationLease {
  id: string;
  tenant_name: string | null;
  request_title: string | null;
  filename: string | null;
  escalation_type: string | null;
  rent_escalation_type: string | null;
  escalation_rate: number | null;
  monthly_payment: number | null;
}

export function EscalationReviewPanel() {
  const { workspace } = useApp();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editingLease, setEditingLease] = useState<EscalationLease | null>(null);
  const [newEscalationType, setNewEscalationType] = useState('');
  const [newEscalationRate, setNewEscalationRate] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: leases = [] } = useQuery({
    queryKey: ['escalation-review', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: async (): Promise<EscalationLease[]> => {
      const { data, error } = await supabase
        .from('leases')
        .select(
          'id, tenant_name, request_title, filename, escalation_type, rent_escalation_type, escalation_rate, monthly_payment'
        )
        .eq('workspace_id', workspace!.id)
        .eq('needs_escalation_review', true)
        .in('lifecycle_status', ['submitted', 'under_review', 'approved', 'executed', 'active']);
      if (error) throw error;
      return (data || []) as EscalationLease[];
    },
  });

  if (leases.length === 0) return null;

  const displayName = (lease: EscalationLease) =>
    lease.tenant_name || lease.request_title || lease.filename || 'Unnamed Lease';

  const openEdit = (lease: EscalationLease) => {
    setEditingLease(lease);
    setNewEscalationType(lease.escalation_type || 'index');
    setNewEscalationRate(lease.escalation_rate != null ? String(lease.escalation_rate) : '');
  };

  const handleSave = async () => {
    if (!editingLease) return;
    setSaving(true);
    try {
      const escalationType = newEscalationType === 'none' ? null : newEscalationType;
      const escalationRate =
        newEscalationType === 'fixed' && newEscalationRate ? Number(newEscalationRate) : null;

      const { error } = await supabase
        .from('leases')
        .update({
          escalation_type: escalationType,
          escalation_rate: escalationRate,
          needs_escalation_review: false,
        })
        .eq('id', editingLease.id)
        .eq('workspace_id', workspace!.id);

      if (error) throw error;

      toast({
        title: 'Escalation updated',
        description: 'Rent schedule will recalculate on next lease processing.',
      });
      queryClient.invalidateQueries({ queryKey: ['escalation-review', workspace?.id] });
      queryClient.invalidateQueries({ queryKey: ['financial-summary', workspace?.id] });
      setEditingLease(null);
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
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
            Escalation Clauses \u2014 Review Required
            <Badge variant="secondary" className="ml-auto text-xs">
              {leases.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">
            The following leases have CPI/index-based escalation terms that require manual review
            before rent schedules can be projected.
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
                      Raw clause: {lease.rent_escalation_type}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 text-xs"
                  onClick={() => openEdit(lease)}
                >
                  Edit Escalation
                  <ChevronRight className="h-3 w-3 ml-1" />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editingLease} onOpenChange={open => !open && setEditingLease(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Escalation</DialogTitle>
          </DialogHeader>
          {editingLease && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">{displayName(editingLease)}</p>
              {editingLease.rent_escalation_type && (
                <div className="rounded-md bg-muted px-3 py-2">
                  <p className="text-xs text-muted-foreground">Raw lease clause</p>
                  <p className="text-sm font-mono mt-0.5">{editingLease.rent_escalation_type}</p>
                </div>
              )}
              <div className="space-y-2">
                <Label>Escalation Type</Label>
                <Select value={newEscalationType} onValueChange={setNewEscalationType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="fixed">Fixed %</SelectItem>
                    <SelectItem value="index">CPI / Index</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {newEscalationType === 'fixed' && (
                <div className="space-y-2">
                  <Label>Annual Escalation Rate (%)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="e.g. 3.0"
                    value={newEscalationRate}
                    onChange={e => setNewEscalationRate(e.target.value)}
                  />
                </div>
              )}
              {newEscalationType === 'index' && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  CPI/Index escalation \u2014 rent schedule will use baseline rent until a fixed rate is set.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingLease(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving\u2026' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
