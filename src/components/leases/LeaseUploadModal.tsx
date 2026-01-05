import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, X, ChevronRight, HelpCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

interface LeaseUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Mock existing leases for amendment parent selection
const mockLeases = [
  { id: '1', name: 'Suite 100, 123 Main St - Master Lease' },
  { id: '2', name: '456 Oak Avenue - Master Lease' },
  { id: '3', name: '789 Pine Boulevard - Master Lease' },
];

type Step = 'upload' | 'classify' | 'processing';

export function LeaseUploadModal({ open, onOpenChange }: LeaseUploadModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [leaseType, setLeaseType] = useState<LeaseType>('master');
  const [parentLeaseId, setParentLeaseId] = useState<string>('');
  const [isUploading, setIsUploading] = useState(false);

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

    // Simulate upload and AI processing
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Reset and close
    setIsUploading(false);
    setStep('upload');
    setFile(null);
    setLeaseType('master');
    setParentLeaseId('');
    onOpenChange(false);
  };

  const handleClose = () => {
    if (!isUploading) {
      setStep('upload');
      setFile(null);
      setLeaseType('master');
      setParentLeaseId('');
      onOpenChange(false);
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
          </DialogTitle>
          <DialogDescription>
            {step === 'upload' && 'Upload a PDF lease document to begin extraction'}
            {step === 'classify' && 'Help us understand what type of document this is'}
            {step === 'processing' && 'Our AI is analyzing your document...'}
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
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
                <Select value={parentLeaseId} onValueChange={setParentLeaseId}>
                  <SelectTrigger id="parent-lease">
                    <SelectValue placeholder="Search or select a lease..." />
                  </SelectTrigger>
                  <SelectContent>
                    {mockLeases.map((lease) => (
                      <SelectItem key={lease.id} value={lease.id}>
                        {lease.name}
                      </SelectItem>
                    ))}
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
              <div className="h-16 w-16 rounded-full border-4 border-muted" />
              <div className="absolute inset-0 h-16 w-16 rounded-full border-4 border-accent border-t-transparent animate-spin" />
            </div>
            <p className="text-sm font-medium mb-2">Analyzing document...</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              Our AI is extracting key terms, dates, and financial information from your lease.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
