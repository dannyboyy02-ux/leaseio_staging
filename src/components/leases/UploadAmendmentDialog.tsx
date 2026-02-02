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

interface UploadAmendmentDialogProps {
  parentLeaseId: string;
  parentFilename: string;
  onSuccess?: (leaseId: string) => void;
}

export function UploadAmendmentDialog({
  parentLeaseId,
  parentFilename,
  onSuccess,
}: UploadAmendmentDialogProps) {
  const [open, setOpen] = useState(false);
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
      toast.error('Please upload an amendment PDF');
      return;
    }

    if (!approverEmail || !approverEmail.includes('@')) {
      toast.error('Please enter a valid approver email');
      return;
    }

    setIsSubmitting(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error('Session expired. Please log in again.');
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
        throw new Error(`Failed to process amendment: ${invokeError.message}`);
      }

      if (result?.error) {
        throw new Error(result.error || 'Failed to process amendment');
      }

      if (result.leaseId) {
        toast.success('Amendment uploaded and processing started');
        setOpen(false);
        setFile(null);
        setApproverEmail('');
        onSuccess?.(result.leaseId);
      } else {
        throw new Error('No lease ID returned from processing');
      }
    } catch (error: any) {
      console.error('Error uploading amendment:', error);
      toast.error(error.message || 'Failed to upload amendment');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileEdit size={14} className="mr-1" />
          Upload Amendment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Amendment</DialogTitle>
          <DialogDescription>
            Upload an amendment document for "{parentFilename}"
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="approverEmail">Approver Email</Label>
            <Input
              id="approverEmail"
              type="email"
              placeholder="approver@company.com"
              value={approverEmail}
              onChange={(e) => setApproverEmail(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Amendment Document</Label>
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
                      ? 'Drop the PDF here...'
                      : 'Drag & drop a PDF, or click to select'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Max file size: 20MB
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !file}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              'Upload Amendment'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
