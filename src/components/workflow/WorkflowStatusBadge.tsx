import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { WORKFLOW_STATUS_CONFIG, type WorkflowStatus } from '@/types/workflow';

interface WorkflowStatusBadgeProps {
  status: WorkflowStatus | string;
  className?: string;
}

export function WorkflowStatusBadge({ status, className }: WorkflowStatusBadgeProps) {
  const config = WORKFLOW_STATUS_CONFIG[status as WorkflowStatus] || {
    label: status,
    variant: 'secondary' as const,
    bgClass: 'bg-muted',
  };

  return (
    <Badge 
      variant={config.variant}
      className={cn(className)}
    >
      {config.label}
    </Badge>
  );
}
