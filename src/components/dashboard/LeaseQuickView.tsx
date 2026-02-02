import { Link } from 'react-router-dom';
import { FileText, ChevronRight, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { format, differenceInDays, parseISO } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getPropertyDisplayName } from '@/lib/extractedFieldHelpers';

interface LeaseRow {
  id: string;
  filename: string | null;
  current_monthly_rent: number | null;
  lease_end: string | null;
  status: string | null;
  extracted_json: Record<string, unknown> | null;
}

function formatCurrency(amount: number | null): string {
  if (!amount) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function getStatusBadge(status: string | null, endDate: string | null) {
  const now = new Date();
  const expirationDate = endDate ? new Date(endDate) : null;
  const daysUntilExpiration = expirationDate ? differenceInDays(expirationDate, now) : null;

  if (daysUntilExpiration !== null && daysUntilExpiration < 0) {
    return <Badge variant="destructive">Expired</Badge>;
  }
  if (daysUntilExpiration !== null && daysUntilExpiration <= 90) {
    return <Badge variant="warning">Expiring Soon</Badge>;
  }
  if (status === 'final') {
    return <Badge variant="success">Active</Badge>;
  }
  if (status === 'review') {
    return <Badge variant="info">In Review</Badge>;
  }
  if (status === 'processing') {
    return <Badge variant="secondary">Processing</Badge>;
  }
  return <Badge variant="outline">{status || 'Draft'}</Badge>;
}

export function LeaseQuickView() {
  const { data: leases, isLoading } = useQuery({
    queryKey: ['leases-quick-view'],
    queryFn: async (): Promise<LeaseRow[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('leases')
        .select('id, filename, current_monthly_rent, lease_end, status, extracted_json')
        .eq('user_id', user.id)
        .order('lease_end', { ascending: true, nullsFirst: false })
        .limit(5);

      if (error) throw error;
      return (data || []) as LeaseRow[];
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            My Leases
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!leases || leases.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4" />
              My Leases
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FileText className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-4">No leases yet</p>
            <Button variant="outline" size="sm" asChild>
              <Link to="/app/leases?action=upload">Upload your first lease</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="animate-fade-up" style={{ animationDelay: '100ms' }}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            My Leases
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/app/leases">
              View all <ChevronRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-2 pb-2">
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="text-xs">Property</TableHead>
                <TableHead className="text-xs text-right">Monthly Rent</TableHead>
                <TableHead className="text-xs text-right hidden sm:table-cell">Expires</TableHead>
                <TableHead className="text-xs text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leases.map((lease, index) => {
                const propertyDisplay = getPropertyDisplayName(
                  lease.extracted_json,
                  lease.filename,
                  'Unnamed Property'
                );
                return (
                <TableRow
                  key={lease.id}
                  className="cursor-pointer hover:bg-muted/50 transition-colors animate-fade-up"
                  style={{ animationDelay: `${(index + 2) * 50}ms` }}
                  onClick={() => window.location.href = `/app/leases/${lease.id}`}
                >
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate max-w-[200px]">
                        {propertyDisplay}
                      </span>
                      <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm font-medium">
                    {formatCurrency(lease.current_monthly_rent)}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground hidden sm:table-cell">
                    {lease.lease_end
                      ? format(new Date(lease.lease_end), 'MMM d, yyyy')
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {getStatusBadge(lease.status, lease.lease_end)}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
