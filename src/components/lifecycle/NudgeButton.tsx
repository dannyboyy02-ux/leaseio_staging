import { useState, useEffect } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';

interface NudgeButtonProps {
  leaseId: string;
  onNudge: () => Promise<boolean>;
  disabled?: boolean;
}

export function NudgeButton({ leaseId, onNudge, disabled = false }: NudgeButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [canNudge, setCanNudge] = useState(true);
  const [lastNudgeTime, setLastNudgeTime] = useState<Date | null>(null);

  useEffect(() => {
    async function checkNudgeStatus() {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      const { data, error } = await supabase
        .from('lease_nudges')
        .select('sent_at')
        .eq('lease_id', leaseId)
        .eq('nudge_type', 'manual')
        .gte('sent_at', yesterday)
        .order('sent_at', { ascending: false })
        .limit(1);

      if (error) {
        console.error('Error checking nudge status:', error);
        return;
      }

      if (data && data.length > 0) {
        setCanNudge(false);
        setLastNudgeTime(new Date(data[0].sent_at));
      } else {
        setCanNudge(true);
        setLastNudgeTime(null);
      }
    }

    checkNudgeStatus();
  }, [leaseId]);

  const handleNudge = async () => {
    if (!canNudge) return;
    
    setIsLoading(true);
    const success = await onNudge();
    if (success) {
      setCanNudge(false);
      setLastNudgeTime(new Date());
    }
    setIsLoading(false);
  };

  const getTimeUntilNextNudge = (): string => {
    if (!lastNudgeTime) return '';
    
    const nextNudgeTime = new Date(lastNudgeTime.getTime() + 24 * 60 * 60 * 1000);
    const now = new Date();
    const diff = nextNudgeTime.getTime() - now.getTime();
    
    if (diff <= 0) return 'Available now';
    
    const hours = Math.floor(diff / (60 * 60 * 1000));
    const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
    
    return `Available in ${hours}h ${minutes}m`;
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          onClick={handleNudge}
          disabled={disabled || isLoading || !canNudge}
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Bell className="h-4 w-4 mr-2" />
          )}
          Send Nudge
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {canNudge 
          ? 'Send a reminder to approvers' 
          : getTimeUntilNextNudge()
        }
      </TooltipContent>
    </Tooltip>
  );
}
