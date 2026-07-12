import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import { FileCheck, Upload, FileText, X, Loader2, CheckCircle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface UploadExecutedDocumentDialogProps {
  leaseId: string;
  leaseFilename: string;
  onSuccess?: (executedData: Record<string, unknown>, variance: Record<string, unknown>) => void;
}

export function UploadExecutedDocumentDialog({
  leaseId,
  leaseFilename,
  onSuccess,
}: UploadExecutedDocumentDialogProps) {
  const { t } = useAppTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'extracting' | 'done'>('idle');

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) setFile(acceptedFiles[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    maxSize: 50 * 1024 * 1024,
  });

  const handleSubmit = async () => {
    if (!file) { toast.error(t('documents.executed_upload.no_file')); return; }
    setIsSubmitting(true);
    setStage('uploading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { toast.error(t('common.session_expired')); return; }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('extractionMode', 'executed');
      formData.append('leaseId', leaseId);
      setStage('extracting');

      const { data: result, error: invokeError } = await supabase.functions.invoke('process_lease', { body: formData });
      if (invokeError) throw new Error(t('documents.executed_upload.upload_failed_with', { message: invokeError.message }));
      if (result?.error) throw new Error(result.error);

      // process_lease flips lifecycle_status -> 'executed' server-side (with
      // status_changed_at + a convention status_change audit row); see #94. The
      // client no longer writes the lifecycle change (it set no status_changed_at
      // and no activity row, leaving the transition unattributable). onSuccess
      // -> refetchLease pulls the server-flipped status.
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });

      setStage('done');
      toast.success(t('documents.executed_upload.success'));
      setTimeout(() => {
        setOpen(false); setFile(null); setStage('idle');
        onSuccess?.(result.executedData ?? {}, result.variance ?? {});
      }, 800);
    } catch (error: any) {
      console.error('[UploadExecutedDocumentDialog]', error);
      toast.error(error.message || t('documents.executed_upload.failed'));
      setStage('idle');
    } finally {
      setIsSubmitting(false);
    }
  };

  const stageLabel = {
    idle: t('documents.executed_upload.stage_idle'),
    uploading: t('documents.executed_upload.stage_uploading'),
    extracting: t('documents.executed_upload.stage_extracting'),
    done: t('common.done'),
  }[stage];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isSubmitting) setOpen(v); }}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm" className="gap-1.5">
          <FileCheck size={14} />
          {t('documents.executed_upload.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('documents.executed_upload.title')}</DialogTitle>
          <DialogDescription>
            {t('documents.executed_upload.desc', { name: leaseFilename })}
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <div
            {...getRootProps()}
            className={cn(
              'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
              isDragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50',
              file && 'border-green-500 bg-green-50 dark:bg-green-950/20',
            )}
          >
            <input {...getInputProps()} />
            {file ? (
              <div className="flex items-center justify-center gap-3">
                <FileText className="h-8 w-8 text-green-600" />
                <div className="text-left">
                  <p className="font-medium text-green-700 dark:text-green-400">{file.name}</p>
                  <p className="text-sm text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
                <Button type="button" variant="ghost" size="icon" className="ml-auto"
                  onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <>
                <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {isDragActive ? t('amendments.upload.drop_here') : t('documents.executed_upload.drag_drop')}
                </p>
                <p className="text-xs text-muted-foreground mt-1">{t('documents.executed_upload.max_size')}</p>
              </>
            )}
          </div>
          {stage === 'extracting' && (
            <p className="text-xs text-muted-foreground text-center mt-3 animate-pulse">
              {t('documents.executed_upload.extracting_note')}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>{t('common.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !file}>
            {isSubmitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{stageLabel}</>
            ) : stage === 'done' ? (
              <><CheckCircle className="h-4 w-4 mr-2 text-green-500" />{t('common.done')}</>
            ) : stageLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
