import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { FileEdit, Upload, FileText, X, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface UploadAmendmentDialogProps {
  parentLeaseId: string;
  parentFilename: string;
  onSuccess?: (leaseId: string) => void;
  /** Controlled mode — when both provided, the component renders only the
   * dialog content and the caller controls open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function UploadAmendmentDialog({
  parentLeaseId,
  parentFilename,
  onSuccess,
  open: controlledOpen,
  onOpenChange,
}: UploadAmendmentDialogProps) {
  const { t } = useAppTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled ? onOpenChange : setInternalOpen;
  const [file, setFile] = useState<File | null>(null);
  const [approverEmail, setApproverEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    maxSize: 20 * 1024 * 1024,
  });

  const handleSubmit = async () => {
    if (!file) {
      toast.error(t('amendments.upload.no_file'));
      return;
    }

    if (!approverEmail || !approverEmail.includes('@')) {
      toast.error(t('amendments.upload.invalid_email'));
      return;
    }

    setIsSubmitting(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error(t('common.session_expired'));
        return;
      }

      // Create form data for the edge function
      const formData = new FormData();
      formData.append('file', file);
      formData.append('leaseType', 'amendment');
      formData.append('category', 'Lease Amendment');
      formData.append('approverEmail', approverEmail);
      formData.append('parentLeaseId', parentLeaseId);

      // Call the process_lease edge function
      const { data: result, error: invokeError } = await supabase.functions.invoke('process_lease', {
        body: formData,
      });

      if (invokeError) {
        console.error('Edge function invocation error:', invokeError);
        throw new Error(t('amendments.upload.process_failed_with', { message: invokeError.message }));
      }

      if (result?.error) {
        throw new Error(result.error || t('amendments.upload.process_failed'));
      }

      if (result.leaseId) {
        toast.success(t('amendments.upload.success'));
        setOpen(false);
        setFile(null);
        setApproverEmail('');
        onSuccess?.(result.leaseId);
      } else {
        throw new Error(t('amendments.upload.no_lease_id'));
      }
    } catch (error: any) {
      console.error('Error uploading amendment:', error);
      toast.error(error.message || t('amendments.upload.failed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <FileEdit size={14} className="mr-1" />
            {t('amendments.upload.title')}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('amendments.upload.title')}</DialogTitle>
          <DialogDescription>
            {t('amendments.upload.desc', { name: parentFilename })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="approverEmail">{t('amendments.upload.approver_email')}</Label>
            <Input
              id="approverEmail"
              type="email"
              placeholder={t('amendments.upload.approver_placeholder')}
              value={approverEmail}
              onChange={(e) => setApproverEmail(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('amendments.upload.document_label')}</Label>
            <div
              {...getRootProps()}
              className={cn(
                'border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors',
                isDragActive
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50',
                file && 'border-green-500 bg-green-50'
              )}
            >
              <input {...getInputProps()} />
              {file ? (
                <div className="flex items-center justify-center gap-3">
                  <FileText className="h-8 w-8 text-green-600" />
                  <div className="text-left">
                    <p className="font-medium text-green-700">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {isDragActive
                      ? t('amendments.upload.drop_here')
                      : t('amendments.upload.drag_drop')}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('amendments.upload.max_size')}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !file}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('amendments.upload.uploading')}
              </>
            ) : (
              t('amendments.upload.title')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
