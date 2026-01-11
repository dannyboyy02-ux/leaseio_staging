import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { LifecycleStatus } from '@/types/lifecycle';
import { LIFECYCLE_STATUS_CONFIG } from '@/types/lifecycle';

interface LifecycleStatusBadgeProps {
  status: LifecycleStatus;
  className?: string;
  size?: 'sm' | 'default';
}

export function LifecycleStatusBadge({ 
  status, 
  className,
  size = 'default' 
}: LifecycleStatusBadgeProps) {
  const config = LIFECYCLE_STATUS_CONFIG[status];
  
  return (
    <Badge
      variant={config.color}
      className={cn(
        config.bgClass,
        config.textClass,
        'border-0 font-medium',
        size === 'sm' && 'text-xs px-2 py-0.5',
        className
      )}
    >
      {size === 'sm' ? config.shortLabel : config.label}
    </Badge>
  );
}
