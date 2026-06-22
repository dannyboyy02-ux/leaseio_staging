import { useState, useRef } from 'react';
import { XCircle, RotateCcw, Loader2, Upload } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface FailedLeaseBannerProps {
  leaseId: string;
  errorMessage: string | null;
  storagePath: string | null;
  onRetrySuccess?: () => void;
  className?: string;
  /** Vault read-only: hide the retry/upload controls (re-invokes process_lease
   *  = AI spend). Default false → non-Vault behavior is unchanged. */
  readOnly?: boolean;
}

export function FailedLeaseBanner({
  leaseId,
  errorMessage,
  storagePath,
  onRetrySuccess,
  className,
  readOnly = false,
}: FailedLeaseBannerProps) {
  const { t } = useAppTranslation();
  const [isRetrying, setIsRetrying] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // In-place re-upload: when the original file is missing, the user supplies a
  // fresh PDF. retry_lease stores it server-side under this lease's path and
  // reprocesses in place — no new lease, no stranded record.
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires onChange again.
    e.target.value = '';
    if (!file) return;

    const isPdf =
      file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      toast.error(t('failed_lease.reupload_not_pdf'));
      return;
    }
    // Mirror the server cap (50MB) so the common fixable case fails fast with
    // a clear message instead of a generic post-upload rejection.
    if (file.size > 50 * 1024 * 1024) {
      toast.error(t('failed_lease.reupload_too_large'));
      return;
    }

    setIsUploading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('Please log in to retry');
        return;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('leaseId', leaseId);

      const response = await supabase.functions.invoke('retry_lease', {
        body: formData,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }
      const data = response.data as { error?: string } | null;
      if (data?.error) {
        throw new Error(data.error);
      }

      toast.success(t('failed_lease.reupload_started'));
      onRetrySuccess?.();
    } catch (error) {
      console.error('Re-upload error:', error);
      toast.error(t('failed_lease.reupload_failed'));
    } finally {
      setIsUploading(false);
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
        {readOnly ? (
          <p className="text-xs text-muted-foreground">{t('readonly.lease_note')}</p>
        ) : canRetry ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            disabled={isRetrying}
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
        ) : (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={handleFileSelected}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="border-destructive/50 hover:bg-destructive/10"
            >
              {isUploading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('failed_lease.uploading')}
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-2" />
                  {t('failed_lease.reupload_button')}
                </>
              )}
            </Button>
            <p className="text-xs mt-2 text-muted-foreground">
              {t('failed_lease.reupload_hint')}
            </p>
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
