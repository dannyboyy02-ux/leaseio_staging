import { Link } from 'react-router-dom';
import { AlertCircle, Edit } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

interface RejectedLease {
  id: string;
  filename: string;
  rejection_comment: string | null;
}

interface RejectedLeaseCalloutProps {
  leases: RejectedLease[];
}

export function RejectedLeaseCallout({ leases }: RejectedLeaseCalloutProps) {
  if (leases.length === 0) return null;

  return (
    <Alert variant="destructive" className="mb-6">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Rejected Leases</AlertTitle>
      <AlertDescription>
        <div className="mt-2 space-y-2">
          {leases.map((lease) => (
            <div
              key={lease.id}
              className="flex items-center justify-between gap-4 py-2 border-t border-destructive/20 first:border-0 first:pt-0"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{lease.filename}</p>
                {lease.rejection_comment && (
                  <p className="text-sm opacity-80 truncate">
                    {lease.rejection_comment}
                  </p>
                )}
              </div>
              <Button size="sm" variant="outline" asChild>
                <Link to={`/app/leases/${lease.id}`}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit & Resubmit
                </Link>
              </Button>
            </div>
          ))}
        </div>
      </AlertDescription>
    </Alert>
  );
}
