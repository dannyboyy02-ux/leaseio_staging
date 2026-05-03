import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileEdit, ExternalLink, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';

interface Amendment {
  id: string;
  filename: string;
  status: string;
  lifecycle_status: string | null;
  uploaded_at: string;
}

interface AmendmentsListProps {
  parentLeaseId: string;
  refreshTrigger?: number;
}

export function AmendmentsList({ parentLeaseId, refreshTrigger }: AmendmentsListProps) {
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAmendments = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('leases')
        .select('id, filename, status, lifecycle_status, uploaded_at')
        .eq('parent_lease_id', parentLeaseId)
        .order('uploaded_at', { ascending: false });

      if (!error && data) {
        setAmendments(data);
      }
      setLoading(false);
    };

    fetchAmendments();
  }, [parentLeaseId, refreshTrigger]);

  const getStatusBadge = (status: string, lifecycleStatus: string | null) => {
    const displayStatus = lifecycleStatus || status;
    switch (displayStatus) {
      case 'Processing':
      case 'Uploaded':
        return <Badge variant="secondary" className="text-xs">Processing</Badge>;
      case 'Ready':
      case 'Review Required':
        return <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">Needs Review</Badge>;
      case 'Posted':
        return <Badge variant="default" className="text-xs bg-green-600">Posted</Badge>;
      case 'Failed':
        return <Badge variant="destructive" className="text-xs">Failed</Badge>;
      default:
        // Phase 3: route lifecycle_status values through displayLabel so
        // chain-vocabulary states (e.g. 'concept_submitted') render with
        // their canonical user-facing label instead of the raw enum.
        return <Badge variant="outline" className="text-xs">{displayLabel(displayStatus as LifecycleStatus)}</Badge>;
    }
  };

  if (loading) {
    return (
      <Card className="shadow-none border overflow-hidden">
        <CardHeader className="bg-muted/30 border-b py-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <FileEdit size={16} className="text-orange-600" />
            Amendments
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-none border overflow-hidden">
      <CardHeader className="bg-muted/30 border-b py-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <FileEdit size={16} className="text-orange-600" />
          Amendments
          {amendments.length > 0 && (
            <Badge variant="outline" className="ml-1 text-xs">
              {amendments.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4">
        {amendments.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No amendments linked to this lease.
          </p>
        ) : (
          <div className="space-y-3">
            {amendments.map((amendment) => (
              <div
                key={amendment.id}
                className="flex items-center justify-between p-3 rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{amendment.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    Uploaded {format(new Date(amendment.uploaded_at), 'MMM d, yyyy')}
                  </p>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  {getStatusBadge(amendment.status, amendment.lifecycle_status)}
                  <Button variant="ghost" size="sm" asChild>
                    <Link to={`/app/leases/${amendment.id}`}>
                      <ExternalLink size={14} />
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
