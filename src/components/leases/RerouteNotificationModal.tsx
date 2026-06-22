// RerouteNotificationModal — Phase 6 Checkpoint 4.
//
// Shown to the lease submitter (requestor_id or user_id matches the
// current user) when their lease has unseen reroute events. Tracks
// "seen" via a localStorage key per event id, so the modal appears
// once per event per browser.
//
// Spec: "An in-app notification is created. A modal appears the next
// time they view the lease, explaining what changed and why. The modal
// links to the chain reroute history for full transparency."

import { useEffect, useMemo, useState } from 'react';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';
import { format } from 'date-fns';
import { ArrowDown, GitBranch, Shield } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

const SEEN_PREFIX = 'leaseio.reroute_seen.';

interface RerouteEventLite {
  id: string;
  triggered_at: string;
  changed_attributes: Record<string, { from: unknown; to: unknown }> | null;
  prior_lifecycle_status: string;
  new_lifecycle_status: string;
  steps_added_count: number;
  steps_superseded_count: number;
  resulted_in_chain_violation: boolean;
  detection_mode: 'auto' | 'manual_admin' | 'manual_audit';
}

interface Props {
  leaseId: string;
  /** lease.requestor_id — primary submitter identity */
  requestorId: string | null;
  /** lease.user_id — fallback submitter identity (legacy uploader) */
  userId: string | null;
}

export function RerouteNotificationModal({
  leaseId,
  requestorId,
  userId,
}: Props) {
  const { user } = useApp();
  const [unseenEvent, setUnseenEvent] = useState<RerouteEventLite | null>(null);
  const [open, setOpen] = useState(false);

  const isSubmitter = useMemo(
    () => !!user && (user.id === requestorId || user.id === userId),
    [user, requestorId, userId],
  );

  useEffect(() => {
    if (!isSubmitter) return;
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from('lease_reroute_events')
        .select(
          'id, triggered_at, changed_attributes, prior_lifecycle_status, new_lifecycle_status, steps_added_count, steps_superseded_count, resulted_in_chain_violation, detection_mode',
        )
        .eq('lease_id', leaseId)
        .order('triggered_at', { ascending: false })
        .limit(5);
      if (cancelled) return;
      const list = (rows ?? []) as RerouteEventLite[];
      // Find the most recent event the submitter hasn't acknowledged.
      const firstUnseen = list.find((e) => {
        try {
          return localStorage.getItem(`${SEEN_PREFIX}${e.id}`) !== '1';
        } catch {
          // localStorage might be unavailable (private mode, etc.); fall
          // back to "show once per session" by treating as unseen.
          return true;
        }
      });
      if (firstUnseen) {
        setUnseenEvent(firstUnseen);
        setOpen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leaseId, isSubmitter]);

  const dismiss = () => {
    if (unseenEvent) {
      try {
        localStorage.setItem(`${SEEN_PREFIX}${unseenEvent.id}`, '1');
      } catch {
        // Best-effort. If localStorage is unavailable the modal will
        // re-appear next page load — minor UX cost, not a correctness bug.
      }
    }
    setOpen(false);
  };

  const handleScrollToHistory = () => {
    dismiss();
    // Defer one tick so the dialog has a chance to close before scrolling.
    setTimeout(() => {
      const el = document.querySelector('[data-reroute-history]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  if (!isSubmitter || !unseenEvent) return null;

  const changedKeys = unseenEvent.changed_attributes
    ? Object.keys(unseenEvent.changed_attributes)
    : [];

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(o) : dismiss())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Your lease was rerouted
          </DialogTitle>
          <DialogDescription>
            An attribute change on your lease triggered a reroute. The
            approval chain has been adjusted to match the new policy. This
            is the audit-defensibility flow working as designed — your
            submission was preserved, the chain just expanded to include
            the right approvers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">When</p>
            <p>{format(new Date(unseenEvent.triggered_at), 'MMM d, yyyy h:mm a')}</p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">Lifecycle</p>
            <p className="flex items-center gap-2">
              <span>{displayLabel(unseenEvent.prior_lifecycle_status as LifecycleStatus)}</span>
              <ArrowDown className="h-3 w-3 -rotate-90" />
              <span className="font-medium">{displayLabel(unseenEvent.new_lifecycle_status as LifecycleStatus)}</span>
              {unseenEvent.resulted_in_chain_violation && (
                <Badge variant="destructive" className="text-[10px] gap-0.5">
                  <Shield className="h-2.5 w-2.5" />
                  Chain violation
                </Badge>
              )}
            </p>
          </div>

          {changedKeys.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">What changed</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {changedKeys.map((k) => (
                  <Badge key={k} variant="outline" className="text-[10px]">
                    {k}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="text-xs text-muted-foreground">Chain impact</p>
            <p className="text-xs">
              <span className="text-success">
                +{unseenEvent.steps_added_count} new approvers required
              </span>
              {unseenEvent.steps_superseded_count > 0 && (
                <span className="text-muted-foreground">
                  {' '}· {unseenEvent.steps_superseded_count} prior steps superseded
                </span>
              )}
            </p>
          </div>

          {unseenEvent.resulted_in_chain_violation && (
            <p className="text-xs text-destructive">
              The reroute happened after this lease executed, so it has
              entered the chain_violation state. Required retroactive
              approvers will be notified, or an admin can acknowledge and
              override.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            Got it
          </Button>
          <Button onClick={handleScrollToHistory}>
            View Chain Reroute History
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
