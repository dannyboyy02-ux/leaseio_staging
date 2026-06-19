// ChainViolationBanner — Phase 6 Checkpoint 4.
//
// Renders on the lease detail page when lifecycle_status is
// 'chain_violation'. The lease entered this state because Phase 6's
// reroute mode detected that a now-required approver was not consulted
// before execution. Until all required pending approvers act (or an
// admin overrides), the lease stays in chain_violation.
//
// Resolution paths surfaced here:
//   1. Required approvers act on their pending chain rows via the
//      existing ApprovalQueue / chain step UI (no special handling —
//      act-on-chain-step accepts any pending step regardless of
//      lifecycle context).
//   2. Workspace admin / owner clicks "Acknowledge and Override" which
//      writes a chain_violation_resolved activity row, supersedes
//      remaining required pending steps, and reverts the lease to its
//      pre-violation lifecycle (default: 'active' — recoverable from
//      the most recent reroute_event row's prior_lifecycle_status).
//
// Visibility:
//   - Banner: every workspace member sees it (it's an audit-relevant
//     state that needs broad visibility).
//   - Acknowledge and Override: workspace owner / admin only.

import { useEffect, useMemo, useState } from 'react';
import { roleLabel, stageLabel } from '@/lib/lifecycleStates';
import {
  AlertOctagon,
  ChevronRight,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';

interface PendingStep {
  id: string;
  stage: 'concept' | 'signator';
  approver_user_id: string | null;
  approver_role: string | null;
  approver_name?: string | null;
}

interface ChainViolationBannerProps {
  leaseId: string;
  workspaceId: string;
  lifecycleStatus: string;
  /** Refresh the parent's lease record after resolution. */
  onResolved: () => void;
}

export function ChainViolationBanner({
  leaseId,
  workspaceId,
  lifecycleStatus,
  onResolved,
}: ChainViolationBannerProps) {
  const { user, userRole } = useApp();
  const [pendingSteps, setPendingSteps] = useState<PendingStep[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);

  const visible = lifecycleStatus === 'chain_violation';
  const isAdminOrOwner = userRole === 'admin' || userRole === 'owner';

  // Load pending required chain steps for this lease.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const { data: stepRows } = await supabase
        .from('lease_approval_chain')
        .select('id, stage, approver_user_id, approver_role')
        .eq('lease_id', leaseId)
        .eq('status', 'pending')
        .eq('is_required', true);
      const rows = ((stepRows ?? []) as PendingStep[]).slice();
      if (rows.length > 0) {
        const userIds = Array.from(
          new Set(rows.map((r) => r.approver_user_id).filter(Boolean) as string[]),
        );
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, email, first_name, last_name')
            .in('id', userIds);
          const byId = new Map<string, string>();
          for (const p of (profiles ?? []) as any[]) {
            const fn = (p.first_name as string | null) ?? '';
            const ln = (p.last_name as string | null) ?? '';
            const display = (fn || ln) ? `${fn} ${ln}`.trim() : (p.email ?? 'Unknown');
            byId.set(p.id as string, display);
          }
          for (const r of rows) {
            if (r.approver_user_id) r.approver_name = byId.get(r.approver_user_id) ?? null;
          }
        }
      }
      if (!cancelled) setPendingSteps(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId, visible, busy]);

  const handleAcknowledgeOverride = async () => {
    const reason = overrideReason.trim();
    if (reason.length < 20) {
      toast.error('Override reason must be at least 20 characters.');
      return;
    }
    if (!user) return;
    setBusy(true);
    try {
      // Find the most recent reroute event with resulted_in_chain_violation=true
      // so we can revert to the prior lifecycle. Falls back to 'active' if
      // we somehow can't locate one (defensive — every chain_violation entry
      // wrote a reroute_event row, so this should always succeed).
      const { data: rerouteRows } = await supabase
        .from('lease_reroute_events')
        .select('prior_lifecycle_status')
        .eq('lease_id', leaseId)
        .eq('resulted_in_chain_violation', true)
        .order('triggered_at', { ascending: false })
        .limit(1);
      const priorLifecycle =
        (rerouteRows?.[0] as any)?.prior_lifecycle_status || 'active';

      const nowIso = new Date().toISOString();

      // Lifecycle Transition Convention compliance:
      //   1. UPDATE leases lifecycle + status_changed_at in same statement
      //   2. Insert status_change activity log row with from/to columns
      //      AND nested in details, plus routing_path: 'chain'
      const { error: updateError } = await (supabase as any)
        .from('leases')
        .update({ lifecycle_status: priorLifecycle, status_changed_at: nowIso })
        .eq('id', leaseId);
      if (updateError) {
        toast.error(`Failed to revert lifecycle: ${updateError.message}`);
        return;
      }

      // Mark remaining required pending steps as superseded — admin
      // explicitly chose to bypass them. The audit row below records that
      // choice + the reason.
      if (pendingSteps.length > 0) {
        await supabase
          .from('lease_approval_chain')
          .update({ status: 'superseded' })
          .in('id', pendingSteps.map((s) => s.id));
      }

      await supabase.from('lease_activity_log').insert([
        {
          lease_id: leaseId,
          user_id: user.id,
          activity_type: 'status_change',
          from_status: 'chain_violation',
          to_status: priorLifecycle,
          details: {
            from: 'chain_violation',
            to: priorLifecycle,
            routing_path: 'chain',
            triggered_by: 'chain_violation_acknowledged_and_overridden',
            override_reason: reason,
            steps_superseded: pendingSteps.length,
          },
        },
        {
          lease_id: leaseId,
          user_id: user.id,
          activity_type: 'chain_violation_resolved',
          details: {
            resolution_path: 'admin_override',
            override_reason: reason,
            steps_superseded: pendingSteps.length,
            reverted_to: priorLifecycle,
          },
        },
      ]);

      toast.success('Chain violation acknowledged and overridden.');
      setOverrideOpen(false);
      setOverrideReason('');
      onResolved();
    } catch (err: any) {
      console.error('[ChainViolationBanner] override error:', err);
      toast.error(err?.message || 'Override failed');
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <>
      <Card className="border-l-4 border-l-destructive bg-destructive/5">
        <CardContent className="py-4 space-y-3">
          <div className="flex items-start gap-3">
            <AlertOctagon className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div className="space-y-1 flex-1">
              <p className="font-semibold text-sm text-destructive">
                Chain violation — retroactive approval required
              </p>
              <p className="text-xs text-muted-foreground">
                This lease's policy-required approvers were not all consulted
                before execution. Required approvers must retroactively
                approve before the lease returns to its prior status, or an
                admin can acknowledge and override.
              </p>
            </div>
          </div>

          {pendingSteps.length > 0 && (
            <div className="pl-8 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Required approvers awaiting action:
              </p>
              <ul className="space-y-1">
                {pendingSteps.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Badge variant="outline" className="text-[10px]">
                      {stageLabel(s.stage)}
                    </Badge>
                    <span>
                      {s.approver_name ?? (s.approver_role ? roleLabel(s.approver_role) : 'Unknown approver')}
                    </span>
                    {s.approver_role && s.approver_name && (
                      <span className="text-muted-foreground">
                        ({roleLabel(s.approver_role)})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {pendingSteps.length === 0 && (
            <p className="pl-8 text-xs text-muted-foreground italic">
              No pending required approvers found. The override path may be
              the appropriate resolution.
            </p>
          )}

          {isAdminOrOwner && (
            <div className="pl-8 pt-1 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOverrideOpen(true)}
                disabled={busy}
              >
                <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                Acknowledge and Override
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={overrideOpen} onOpenChange={(o) => !busy && setOverrideOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Acknowledge and Override Chain Violation</DialogTitle>
            <DialogDescription>
              This bypasses the retroactive-approval requirement and reverts
              the lease to its prior lifecycle status. The override reason is
              captured permanently in the audit log. Use only when retroactive
              approval is impractical (e.g., the required approver has left
              the company and the policy needs admin attention separately).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="override-reason">
              Reason (≥20 characters, required)
            </Label>
            <Textarea
              id="override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder="e.g., Required approver left the company; policy is being revised separately and this lease needs to remain active in the meantime."
              disabled={busy}
              className={cn(
                overrideReason.trim().length >= 20
                  ? 'border-success/50'
                  : overrideReason.length > 0
                  ? 'border-warning/50'
                  : '',
              )}
            />
            <p className="text-[11px] text-muted-foreground">
              {overrideReason.trim().length} / 20+ characters
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOverrideOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleAcknowledgeOverride}
              disabled={busy || overrideReason.trim().length < 20}
            >
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              <ChevronRight className="h-4 w-4 mr-2" />
              Override and Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
