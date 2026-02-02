import { useState } from 'react';
import { XCircle, RotateCcw, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface FailedLeaseBannerProps {
  leaseId: string;
  errorMessage: string | null;
  storagePath: string | null;
  onRetrySuccess?: () => void;
  className?: string;
}

export function FailedLeaseBanner({
  leaseId,
  errorMessage,
  storagePath,
  onRetrySuccess,
  className,
}: FailedLeaseBannerProps) {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    if (!storagePath) {
      toast.error('Cannot retry: original file not found in storage');
      return;
    }

    setIsRetrying(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Please log in to retry');
        return;
      }

      const response = await supabase.functions.invoke('retry_lease', {
        body: { leaseId },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      toast.success('Re-processing started');
      onRetrySuccess?.();
    } catch (error) {
      console.error('Retry error:', error);
      toast.error('Failed to retry processing');
    } finally {
      setIsRetrying(false);
    }
  };

  const canRetry = !!storagePath;

  return (
    <Alert variant="destructive" className={cn('mb-4', className)}>
      <XCircle className="h-4 w-4" />
      <AlertTitle>Processing Failed</AlertTitle>
      <AlertDescription>
        <p className="text-sm mb-3">
          {errorMessage || 'An error occurred while processing this lease document.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRetry}
          disabled={isRetrying || !canRetry}
          className="border-destructive/50 hover:bg-destructive/10"
        >
          {isRetrying ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Retrying...
            </>
          ) : (
            <>
              <RotateCcw className="h-4 w-4 mr-2" />
              Retry Processing
            </>
          )}
        </Button>
        {!canRetry && (
          <p className="text-xs mt-2 text-muted-foreground">
            {/* TODO: Allow re-upload when storage_path is missing */}
            Original file not available for retry. Please upload a new document.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
