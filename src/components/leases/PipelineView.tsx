import { differenceInCalendarDays, parseISO } from 'date-fns';
import { Building2, Car, CircleDollarSign, Cpu, FileQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type PipelineStatus = 'requested' | 'negotiating' | 'pending_review' | 'executed' | 'active';

export interface PipelineLease {
  id: string;
  request_title: string | null;
  category: string | null;
  requesting_department: string | null;
  request_urgency: string | null;
  estimated_monthly_cost_min: number | null;
  estimated_monthly_cost_max: number | null;
  uploaded_at: string;
  status_changed_at: string | null;
  lifecycle_status: string | null;
}

interface PipelineViewProps {
  leases: PipelineLease[];
  onOpenLease: (leaseId: string) => void;
}

const COLUMNS: Array<{ key: PipelineStatus; label: string }> = [
  { key: 'requested', label: 'Requested' },
  { key: 'negotiating', label: 'Negotiating' },
  { key: 'pending_review', label: 'Pending Review' },
  { key: 'executed', label: 'Executed' },
  { key: 'active', label: 'Active' },
];

const getCategoryIcon = (category: string | null) => {
  switch (category) {
    case 'property':
      return Building2;
    case 'equipment':
      return Cpu;
    case 'vehicle':
      return Car;
    default:
      return FileQuestion;
  }
};

const getCostText = (lease: PipelineLease) => {
  const min = lease.estimated_monthly_cost_min;
  const max = lease.estimated_monthly_cost_max;
  if (min === null && max === null) return 'Cost TBD';
  if (min !== null && max !== null) return `$${min.toLocaleString()} - $${max.toLocaleString()} / mo`;
  if (min !== null) return `From $${min.toLocaleString()} / mo`;
  return `Up to $${max!.toLocaleString()} / mo`;
};

const getDaysInStage = (lease: PipelineLease) => {
  const dateStr = lease.status_changed_at || lease.uploaded_at;
  try {
    const start = parseISO(dateStr);
    return Math.max(0, differenceInCalendarDays(new Date(), start));
  } catch {
    return 0;
  }
};

export function PipelineView({ leases, onOpenLease }: PipelineViewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
      {COLUMNS.map((column) => {
        const columnLeases = leases.filter((lease) => lease.lifecycle_status === column.key);

        return (
          <div key={column.key} className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold">{column.label}</p>
              <Badge variant="secondary">{columnLeases.length}</Badge>
            </div>

            <div className="space-y-3">
              {columnLeases.map((lease) => {
                const Icon = getCategoryIcon(lease.category);
                const days = getDaysInStage(lease);
                return (
                  <Card
                    key={lease.id}
                    role="button"
                    onClick={() => onOpenLease(lease.id)}
                    className={cn('cursor-pointer p-3 transition-colors hover:bg-accent')}
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{lease.request_title || 'Untitled Request'}</p>
                          <p className="truncate text-xs text-muted-foreground">{lease.requesting_department || 'Unknown department'}</p>
                        </div>
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </div>

                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{days}d in stage</span>
                        {lease.request_urgency === 'urgent' && (
                          <Badge variant="destructive" className="text-[10px]">Urgent</Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <CircleDollarSign className="h-3.5 w-3.5" />
                        <span>{getCostText(lease)}</span>
                      </div>
                    </div>
                  </Card>
                );
              })}

              {columnLeases.length === 0 && (
                <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  No requests
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
