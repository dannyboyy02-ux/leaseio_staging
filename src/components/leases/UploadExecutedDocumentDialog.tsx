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
    if (!file) { toast.error('Please upload the executed lease PDF'); return; }
    setIsSubmitting(true);
    setStage('uploading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) { toast.error('Session expired. Please log in again.'); return; }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('extractionMode', 'executed');
      formData.append('leaseId', leaseId);
      setStage('extracting');

      const { data: result, error: invokeError } = await supabase.functions.invoke('process_lease', { body: formData });
      if (invokeError) throw new Error(`Upload failed: ${invokeError.message}`);
      if (result?.error) throw new Error(result.error);

      const { error: statusError } = await supabase
        .from('leases').update({ lifecycle_status: 'executed' }).eq('id', leaseId);
      if (statusError) console.error('[UploadExecutedDocumentDialog] status update error:', statusError);
      queryClient.invalidateQueries({ queryKey: ['needs-action'] });

      setStage('done');
      toast.success('Executed document uploaded and terms extracted');
      setTimeout(() => {
        setOpen(false); setFile(null); setStage('idle');
        onSuccess?.(result.executedData ?? {}, result.variance ?? {});
      }, 800);
    } catch (error: any) {
      console.error('[UploadExecutedDocumentDialog]', error);
      toast.error(error.message || 'Failed to upload executed document');
      setStage('idle');
    } finally {
      setIsSubmitting(false);
    }
  };

  const stageLabel = { idle: 'Upload & Extract Terms', uploading: 'Uploading...', extracting: 'Extracting Terms...', done: 'Done' }[stage];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isSubmitting) setOpen(v); }}>
      <DialogTrigger asChild>
        <Button variant="default" size="sm" className="gap-1.5">
          <FileCheck size={14} />
          Upload Executed Copy
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Executed Document</DialogTitle>
          <DialogDescription>
            Upload the fully executed (signed) copy of "{leaseFilename}". Terms will be extracted
            and compared against the pipeline record.
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
                  {isDragActive ? 'Drop the PDF here...' : 'Drag & drop the executed PDF, or click to select'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">PDF only · Max 50 MB</p>
              </>
            )}
          </div>
          {stage === 'extracting' && (
            <p className="text-xs text-muted-foreground text-center mt-3 animate-pulse">
              Extracting terms with AI — this may take 30–60 seconds...
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !file}>
            {isSubmitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{stageLabel}</>
            ) : stage === 'done' ? (
              <><CheckCircle className="h-4 w-4 mr-2 text-green-500" />Done</>
            ) : stageLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
