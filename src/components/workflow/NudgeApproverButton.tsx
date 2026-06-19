import { useState, useEffect } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface NudgeApproverButtonProps {
  leaseId: string;
  lastNudgedAt: string | null;
  disabled?: boolean;
}

// Mirrors the server-side cooldown in supabase/functions/send-nudge (#109).
// The server is the source of truth; this is just UX debounce + display.
const COOLDOWN_SECONDS = 30 * 60;

function formatWait(s: number): string {
  return s >= 60 ? `${Math.ceil(s / 60)}m` : `${s}s`;
}

export function NudgeApproverButton({
  leaseId,
  lastNudgedAt,
  disabled = false,
}: NudgeApproverButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Initial cooldown from the lease's last_nudged_at.
  useEffect(() => {
    if (!lastNudgedAt) {
      setSecondsLeft(0);
      return;
    }
    const elapsed = Math.floor((Date.now() - new Date(lastNudgedAt).getTime()) / 1000);
    setSecondsLeft(Math.max(0, COOLDOWN_SECONDS - elapsed));
  }, [lastNudgedAt]);

  // Countdown timer.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timer);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  const handleNudge = async () => {
    if (secondsLeft > 0) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-nudge', {
        body: { leaseId },
      });
      const res = data as {
        ok?: boolean;
        reason?: string;
        retryAfterSeconds?: number;
        recipients?: string[];
        notificationsSent?: number;
        error?: string;
      } | null;

      if (error || !res?.ok) {
        if (res?.reason === 'cooldown' && res.retryAfterSeconds) {
          setSecondsLeft(res.retryAfterSeconds);
          toast.message(res.error || 'Already nudged recently.');
        } else if (res?.reason === 'no_approver') {
          toast.error(res.error || 'No pending approver to nudge.');
        } else {
          toast.error(res?.error || error?.message || 'Failed to send nudge');
        }
        return;
      }

      const recipients = res.recipients ?? [];
      if (recipients.length > 0) {
        const shown = recipients.slice(0, 2).join(', ');
        const more = recipients.length > 2 ? ` +${recipients.length - 2} more` : '';
        toast.success(`Nudged ${shown}${more}`);
      } else {
        toast.success('Nudge sent to approver');
      }
      setSecondsLeft(COOLDOWN_SECONDS);
    } catch (err) {
      console.error('Error sending nudge:', err);
      toast.error('Failed to send nudge');
    } finally {
      setIsLoading(false);
    }
  };

  const isOnCooldown = secondsLeft > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={handleNudge}
          disabled={disabled || isLoading || isOnCooldown}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Bell className="h-4 w-4 mr-2" />
          )}
          {isOnCooldown ? `Wait ${formatWait(secondsLeft)}` : 'Nudge Approver'}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isOnCooldown
          ? `You can nudge again in ${formatWait(secondsLeft)}`
          : 'Email the pending approver a reminder'}
      </TooltipContent>
    </Tooltip>
  );
}
