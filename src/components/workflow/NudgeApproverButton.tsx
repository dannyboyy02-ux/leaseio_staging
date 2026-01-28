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

const COOLDOWN_SECONDS = 60;

export function NudgeApproverButton({ 
  leaseId, 
  lastNudgedAt,
  disabled = false 
}: NudgeApproverButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Calculate initial cooldown based on lastNudgedAt
  useEffect(() => {
    if (!lastNudgedAt) {
      setSecondsLeft(0);
      return;
    }

    const nudgeTime = new Date(lastNudgedAt).getTime();
    const now = Date.now();
    const elapsed = Math.floor((now - nudgeTime) / 1000);
    const remaining = Math.max(0, COOLDOWN_SECONDS - elapsed);
    setSecondsLeft(remaining);
  }, [lastNudgedAt]);

  // Countdown timer
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
      const { error } = await supabase
        .from('leases')
        .update({ last_nudged_at: new Date().toISOString() })
        .eq('id', leaseId);

      if (error) throw error;

      toast.success('Nudge sent to approver!');
      setSecondsLeft(COOLDOWN_SECONDS);
    } catch (error: any) {
      console.error('Error sending nudge:', error);
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
          {isOnCooldown ? `Wait ${secondsLeft}s` : 'Nudge Approver'}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {isOnCooldown
          ? `You can nudge again in ${secondsLeft} seconds`
          : 'Send a reminder to the approver'
        }
      </TooltipContent>
    </Tooltip>
  );
}
