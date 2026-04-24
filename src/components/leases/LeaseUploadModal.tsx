import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, X, ChevronRight, HelpCircle, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { LeaseType } from '@/types';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface LeaseUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (leaseId: string) => void;
}

// Parent lease interface for amendments
interface ParentLease {
  id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
}

type Step = 'upload' | 'classify' | 'processing' | 'success' | 'error';

type ProcessingStatus = {
  stage: 'uploading' | 'analyzing' | 'extracting' | 'saving';
  message: string;
};

export function LeaseUploadModal({ open, onOpenChange, onSuccess }: LeaseUploadModalProps) {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [leaseType, setLeaseType] = useState<LeaseType>('master');
  const [parentLeaseId, setParentLeaseId] = useState<string>('');
  const [isUploading, setIsUploading] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({ 
    stage: 'uploading', 
    message: 'Uploading document...' 
  });
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [resultLeaseId, setResultLeaseId] = useState<string>('');
  const [pendingLeaseId, setPendingLeaseId] = useState<string | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  
  // Real parent leases from database
  const [availableParentLeases, setAvailableParentLeases] = useState<ParentLease[]>([]);
  const [loadingParentLeases, setLoadingParentLeases] = useState(false);

  // Fetch posted leases for amendment parent selection
  useEffect(() => {
    async function fetchPostedLeases() {
      if (leaseType !== 'amendment') {
        setAvailableParentLeases([]);
        return;
      }
      
      setLoadingParentLeases(true);
      
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          setLoadingParentLeases(false);
          return;
        }

        const { data, error } = await supabase
          .from('leases')
          .select('id, tenant_name, landlord_name, lease_start, lease_end')
          .eq('lifecycle_status', 'active')
          .order('uploaded_at', { ascending: false });
        
        if (error) {
          console.error('Error fetching parent leases:', error);
          setAvailableParentLeases([]);
        } else {
          setAvailableParentLeases(data || []);
        }
      } catch (err) {
        console.error('Error fetching parent leases:', err);
        setAvailableParentLeases([]);
      }
      
      setLoadingParentLeases(false);
    }
    
    fetchPostedLeases();
  }, [leaseType]);

  // Polling for lease status updates
  useEffect(() => {
    if (!pendingLeaseId || step !== 'processing') {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    const pollStatus = async () => {
      try {
        const { data: lease, error } = await supabase
          .from('leases')
          .select('status, error_message')
          .eq('id', pendingLeaseId)
          .single();

        if (error) return;

        if (lease.status === 'Ready') {
          setProcessingStatus({ stage: 'saving', message: 'Processing complete!' });
          setResultLeaseId(pendingLeaseId);
          setStep('success');
          toast.success('Lease processed successfully!');
          setPendingLeaseId(null);
          if (onSuccess) {
            onSuccess(pendingLeaseId);
          }
        } else if (lease.status === 'Failed') {
          setErrorMessage(lease.error_message || 'Processing failed');
          setStep('error');
          toast.error('Failed to process lease');
          setPendingLeaseId(null);
        } else if (lease.status === 'Processing') {
          setProcessingStatus({ stage: 'extracting', message: 'Extracting lease data...' });
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    };

    pollingRef.current = setInterval(pollStatus, 2000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [pendingLeaseId, step]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setStep('classify');
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    maxSize: 50 * 1024 * 1024, // 50MB
  });

  const handleSubmit = async () => {
    if (!file) return;
    if (leaseType === 'amendment' && !parentLeaseId) return;

    setIsUploading(true);
    setStep('processing');
    setProcessingStatus({ stage: 'uploading', message: 'Uploading document...' });

    try {
      // Get the current session for auth
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error('Session expired. Please log in again.');
        navigate('/login');
        return;
      }

      // Create form data
      const formData = new FormData();
      formData.append('file', file);
      formData.append('leaseType', leaseType);
      if (parentLeaseId) {
        formData.append('parentLeaseId', parentLeaseId);
      }

      setProcessingStatus({ stage: 'analyzing', message: 'Analyzing document with AI...' });

      // Call the edge function using the Supabase client method
      const { data: result, error: invokeError } = await supabase.functions.invoke('process_lease', {
        body: formData,
      });

      if (invokeError) {
        console.error('Edge function invocation error:', invokeError);
        throw new Error(`Failed to process lease: ${invokeError.message}`);
      }

      if (result?.error) {
        throw new Error(result.error || 'Failed to process lease');
      }

      // If the edge function returns a leaseId, start polling for status updates
      if (result.leaseId) {
        setPendingLeaseId(result.leaseId);
        setProcessingStatus({ stage: 'extracting', message: 'Extracting lease data...' });
        
        // If result.success is true, the processing completed synchronously
        if (result.success) {
          setResultLeaseId(result.leaseId);
          setStep('success');
          toast.success('Lease processed successfully!');
          setPendingLeaseId(null);
          
          if (onSuccess) {
            onSuccess(result.leaseId);
          }
        }
        // Otherwise polling will handle success/error states
      }

    } catch (error) {
      console.error('Upload error:', error);
      setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
      setStep('error');
      toast.error('Failed to process lease');
    } finally {
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    if (!isUploading) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      setStep('upload');
      setFile(null);
      setLeaseType('master');
      setParentLeaseId('');
      setErrorMessage('');
      setResultLeaseId('');
      setPendingLeaseId(null);
      onOpenChange(false);
    }
  };

  const handleViewLease = () => {
    handleClose();
    navigate(`/app/leases/${resultLeaseId}/review`);
  };

  const handleRetry = () => {
    setStep('classify');
    setErrorMessage('');
  };

  const getProcessingIcon = () => {
    switch (processingStatus.stage) {
      case 'uploading':
        return <Upload className="h-6 w-6 text-primary animate-pulse" />;
      case 'analyzing':
        return <FileText className="h-6 w-6 text-primary animate-pulse" />;
      case 'extracting':
        return <Loader2 className="h-6 w-6 text-primary animate-spin" />;
      case 'saving':
        return <CheckCircle className="h-6 w-6 text-primary" />;
      default:
        return <Loader2 className="h-6 w-6 text-primary animate-spin" />;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && 'Upload Lease Document'}
            {step === 'classify' && 'Classify Document'}
            {step === 'processing' && 'Processing Document'}
            {step === 'success' && 'Processing Complete'}
            {step === 'error' && 'Processing Failed'}
          </DialogTitle>
          <DialogDescription>
            {step === 'upload' && 'Upload a PDF lease document to begin extraction'}
            {step === 'classify' && 'Help us understand what type of document this is'}
            {step === 'processing' && 'Our AI is analyzing your document...'}
            {step === 'success' && 'Your lease has been successfully extracted'}
            {step === 'error' && 'There was a problem processing your document'}
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <>
          <p className="text-xs text-muted-foreground text-center -mt-1 mb-1">
            Documents are processed by AI to extract key terms. We never use your data for AI training.
          </p>
          <div
            {...getRootProps()}
            className={cn(
              'flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-all cursor-pointer',
              isDragActive
                ? 'border-accent bg-accent/5'
                : 'border-border hover:border-accent/50 hover:bg-muted/50'
            )}
          >
            <input {...getInputProps()} />
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
              <Upload className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium mb-1">
              {isDragActive ? 'Drop your file here' : 'Drag & drop your lease PDF'}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              or click to browse (max 50MB)
            </p>
            <Button variant="outline" size="sm" type="button">
              Select File
            </Button>
          </div>
          </>
        )}

        {step === 'classify' && file && (
          <div className="space-y-6">
            {/* Selected File */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileText className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setFile(null);
                  setStep('upload');
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Document Type */}
            <div className="space-y-3">
              <Label className="flex items-center gap-2">
                Is this a new lease or an amendment?
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-sm">
                      <strong>Master Lease:</strong> The original, standalone lease agreement.
                    </p>
                    <p className="text-sm mt-1">
                      <strong>Amendment:</strong> A modification to an existing master lease.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </Label>
              <RadioGroup
                value={leaseType}
                onValueChange={(v) => setLeaseType(v as LeaseType)}
                className="grid grid-cols-2 gap-3"
              >
                <Label
                  htmlFor="master"
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border-2 p-4 cursor-pointer transition-all',
                    leaseType === 'master'
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-accent/50'
                  )}
                >
                  <RadioGroupItem value="master" id="master" className="sr-only" />
                  <FileText className="h-6 w-6" />
                  <span className="font-medium">New Lease</span>
                  <span className="text-xs text-muted-foreground text-center">
                    Original lease document
                  </span>
                </Label>
                <Label
                  htmlFor="amendment"
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border-2 p-4 cursor-pointer transition-all',
                    leaseType === 'amendment'
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-accent/50'
                  )}
                >
                  <RadioGroupItem value="amendment" id="amendment" className="sr-only" />
                  <FileText className="h-6 w-6" />
                  <span className="font-medium">Amendment</span>
                  <span className="text-xs text-muted-foreground text-center">
                    Modifies existing lease
                  </span>
                </Label>
              </RadioGroup>
            </div>

            {/* Parent Lease Selection */}
            {leaseType === 'amendment' && (
              <div className="space-y-2 animate-fade-up">
                <Label htmlFor="parent-lease">Select the master lease this amends</Label>
                <Select value={parentLeaseId} onValueChange={setParentLeaseId} disabled={loadingParentLeases}>
                  <SelectTrigger id="parent-lease">
                    <SelectValue placeholder={loadingParentLeases ? "Loading leases..." : "Search or select a lease..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableParentLeases.length === 0 && !loadingParentLeases ? (
                      <div className="p-2 text-center text-sm text-muted-foreground">
                        No posted leases available
                      </div>
                    ) : (
                      availableParentLeases.map((lease) => (
                        <SelectItem key={lease.id} value={lease.id}>
                          {lease.tenant_name || 'Unknown Tenant'} - {lease.landlord_name || 'Unknown Landlord'}
                          {lease.lease_start && ` (${lease.lease_start})`}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={handleClose} className="flex-1">
                Cancel
              </Button>
              <Button
                variant="accent"
                onClick={handleSubmit}
                className="flex-1"
                disabled={leaseType === 'amendment' && !parentLeaseId}
              >
                Continue <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {step === 'processing' && (
          <div className="flex flex-col items-center py-10">
            <div className="relative mb-6">
              <div className="h-16 w-16 rounded-full border-4 border-muted flex items-center justify-center">
                {getProcessingIcon()}
              </div>
              <div className="absolute inset-0 h-16 w-16 rounded-full border-4 border-accent border-t-transparent animate-spin" />
            </div>
            <p className="text-sm font-medium mb-2">{processingStatus.message}</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              {processingStatus.stage === 'uploading' && 'Securely uploading your document...'}
              {processingStatus.stage === 'analyzing' && 'Using Azure Document Intelligence to extract text and tables...'}
              {processingStatus.stage === 'extracting' && 'Our AI is identifying key lease terms and dates...'}
              {processingStatus.stage === 'saving' && 'Finalizing and saving your lease data...'}
            </p>
            
            {/* Progress Steps */}
            <div className="mt-6 flex items-center gap-2">
              <div className={cn(
                'h-2 w-2 rounded-full transition-colors',
                processingStatus.stage === 'uploading' ? 'bg-accent' : 'bg-accent/30'
              )} />
              <div className={cn(
                'h-2 w-2 rounded-full transition-colors',
                processingStatus.stage === 'analyzing' ? 'bg-accent' : 
                  ['extracting', 'saving'].includes(processingStatus.stage) ? 'bg-accent/30' : 'bg-muted'
              )} />
              <div className={cn(
                'h-2 w-2 rounded-full transition-colors',
                processingStatus.stage === 'extracting' ? 'bg-accent' : 
                  processingStatus.stage === 'saving' ? 'bg-accent/30' : 'bg-muted'
              )} />
              <div className={cn(
                'h-2 w-2 rounded-full transition-colors',
                processingStatus.stage === 'saving' ? 'bg-accent' : 'bg-muted'
              )} />
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center py-10">
            <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center mb-4">
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
            <p className="text-sm font-medium mb-2">Lease Extracted Successfully!</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs mb-4">
              Your lease document has been analyzed and the key information has been extracted.
            </p>
            <p className="text-sm font-medium mb-4">Would you like to upload another lease?</p>
            <div className="flex gap-3 w-full">
              <Button 
                variant="outline" 
                onClick={() => {
                  setFile(null);
                  setLeaseType('master');
                  setParentLeaseId('');
                  setErrorMessage('');
                  setResultLeaseId('');
                  setStep('upload');
                }} 
                className="flex-1"
              >
                Yes, Upload Another
              </Button>
              <Button variant="accent" onClick={handleViewLease} className="flex-1">
                Review Extracted Data
              </Button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center py-10">
            <div className="h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
              <AlertCircle className="h-8 w-8 text-destructive" />
            </div>
            <p className="text-sm font-medium mb-2">Processing Failed</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs mb-2">
              {errorMessage}
            </p>
            <p className="text-xs text-muted-foreground text-center max-w-xs mb-6">
              Please try again or contact support if the issue persists.
            </p>
            <div className="flex gap-3 w-full">
              <Button variant="outline" onClick={handleClose} className="flex-1">
                Cancel
              </Button>
              <Button variant="accent" onClick={handleRetry} className="flex-1">
                Try Again
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
