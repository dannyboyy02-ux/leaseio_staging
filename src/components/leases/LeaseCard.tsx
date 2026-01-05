import { Link } from 'react-router-dom';
import { FileText, Calendar, MapPin, ChevronRight, AlertCircle, Clock, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Lease, LeaseStatus } from '@/types';

interface LeaseCardProps {
  lease: Lease;
  index?: number;
}

const statusConfig: Record<LeaseStatus, { label: string; variant: 'default' | 'warning' | 'info' | 'success' | 'muted'; icon: React.ComponentType<{ className?: string }> }> = {
  draft: { label: 'Draft', variant: 'muted', icon: FileText },
  processing: { label: 'Processing', variant: 'info', icon: Clock },
  review: { label: 'Needs Review', variant: 'warning', icon: AlertCircle },
  final: { label: 'Finalized', variant: 'success', icon: CheckCircle2 },
  archived: { label: 'Archived', variant: 'muted', icon: FileText },
};

export function LeaseCard({ lease, index = 0 }: LeaseCardProps) {
  const status = statusConfig[lease.status];
  const StatusIcon = status.icon;

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Not set';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <Link to={`/leases/${lease.id}`}>
      <Card
        variant="interactive"
        className={cn('animate-fade-up')}
        style={{ animationDelay: `${index * 50}ms` }}
      >
        <CardContent className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileText className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-medium truncate">{lease.documentName}</h3>
                  {lease.type === 'amendment' && (
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      Amendment
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 text-sm text-muted-foreground mb-3">
                  <MapPin className="h-3.5 w-3.5" />
                  <span className="truncate">{lease.propertyAddress || 'Address pending'}</span>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <span className="font-medium text-foreground">{lease.lessor || 'TBD'}</span>
                    <span>→</span>
                    <span className="font-medium text-foreground">{lease.lessee || 'TBD'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3.5 w-3.5" />
                    <span>{formatDate(lease.commencementDate)} - {formatDate(lease.expirationDate)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <Badge variant={status.variant} className="gap-1">
                <StatusIcon className="h-3 w-3" />
                {status.label}
              </Badge>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
