import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, X, ChevronRight, HelpCircle, AlertCircle, Sparkles } from 'lucide-react';
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
import { useProcessing } from '@/contexts/ProcessingContext';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface LeaseUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (leaseId: string) => void;
  /**
   * Server backstop for the limit wall: called when process_lease rejects the
   * upload with reason 'quota_exceeded' (the entry-point gate uses client
   * state, which can race the real count — the server is the authority).
   * The parent should close this modal and open LimitReachedDialog.
   */
  onQuotaExceeded?: () => void;
}

// Parent lease interface for amendments
interface ParentLease {
  id: string;
  tenant_name: string | null;
  landlord_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
}

type Step = 'upload' | 'classify' | 'error' | 'tier2_rejected' | 'no_subscription';

export function LeaseUploadModal({ open, onOpenChange, onSuccess, onQuotaExceeded }: LeaseUploadModalProps) {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const { startProcessing } = useProcessing();
  const { workspace } = useApp();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [leaseType, setLeaseType] = useState<LeaseType>('master');
  const [parentLeaseId, setParentLeaseId] = useState<string>('');
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  // Phase 5: Tier 2 rejection detail when AI says "this isn't a lease"
  // with high confidence. User can override and force the upload through
  // — the override is recorded as an is_lease_override correction that
  // feeds Phase 4's per-workspace in-context learning.
  const [tier2RejectDetail, setTier2RejectDetail] = useState<string>('');

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
        if (!user || !workspace?.id) {
          setLoadingParentLeases(false);
          return;
        }

        // Workspace scoping mandatory — amendments can only point at parents
        // in the same workspace.
        const { data, error } = await supabase
          .from('leases')
          .select('id, tenant_name, landlord_name, lease_start, lease_end')
          .eq('workspace_id', workspace.id)
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
  }, [leaseType, workspace?.id]);

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

  // Single upload routine, used by both initial submit and the
  // post-rejection "Override and proceed" retry. When forceOverride
  // is true, process_lease skips the Tier 2 hard-gate and records an
  // is_lease_override correction for the Phase 4 learning loop.
  const performUpload = async (forceOverride: boolean) => {
    if (!file) return;
    if (leaseType === 'amendment' && !parentLeaseId) return;

    setIsUploading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error(t('leases.upload.session_expired'));
        setIsUploading(false);
        return;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('leaseType', leaseType);
      // Pin the lease to the user's currently-active workspace. Without
      // this, process_lease falls into resolveAuthorizedWorkspaceId's
      // LIMIT 1 fallback, which picks a random owned workspace —
      // the lease can silently land in a different workspace than the
      // one the UI is showing. Caught by the 2026-05-13 Tier 3 smoke
      // (lease went to "My Workspace"/pro while the UI was on Labs/business).
      if (workspace?.id) {
        formData.append('workspaceId', workspace.id);
      }
      if (parentLeaseId) {
        formData.append('parentLeaseId', parentLeaseId);
      }
      if (forceOverride) {
        formData.append('forceTier2Override', 'true');
      }

      const { data: result, error: invokeError } = await supabase.functions.invoke('process_lease', {
        body: formData,
      });

      if (invokeError) {
        throw new Error(t('leases.upload.process_failed_with', { message: invokeError.message }));
      }

      // Tier 2 hard rejection — surface the override path instead of
      // a generic error. Only fires on the FIRST submit (forceOverride=false);
      // if the user already overrode and we still get this, it's a bug.
      if (result?.reason === 'tier2_classification_failed' && !forceOverride) {
        const detail = (result as any)?.detail || result.error || t('leases.upload.not_a_lease_fallback');
        setTier2RejectDetail(detail);
        setStep('tier2_rejected');
        return;
      }

      // Quota wall backstop — the server blocked at the cap. Hand off to the
      // limit wall (upgrade / pack / single-lease) instead of a generic error.
      if (result?.reason === 'quota_exceeded' && onQuotaExceeded) {
        handleClose();
        onQuotaExceeded();
        return;
      }

      // Starter monetization gate (Decision 1): a never-subscribed workspace
      // can't process yet. Show the start-trial panel instead of a generic
      // "Processing Failed / Try again" dead-end.
      if (result?.reason === 'no_subscription') {
        setStep('no_subscription');
        return;
      }

      if (result?.error) {
        throw new Error(result.error || t('leases.upload.process_failed'));
      }

      if (result?.leaseId) {
        startProcessing(result.leaseId, file.name);
        if (onSuccess) onSuccess(result.leaseId);
        handleClose();
      }

    } catch (error) {
      console.error('Upload error:', error);
      setErrorMessage(error instanceof Error ? error.message : t('leases.upload.unexpected_error'));
      setStep('error');
      toast.error(t('leases.upload.process_failed'));
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = () => performUpload(false);
  const handleTier2Override = () => performUpload(true);

  // Start-trial CTA from the monetization gate: route to the Billing tab and
  // auto-open checkout for the workspace's intended plan (Starter by default).
  const handleStartTrial = () => {
    const plan = workspace?.intendedPlan === 'business' ? 'business' : 'starter';
    onOpenChange(false);
    navigate(`/app/settings?tab=billing&autoCheckout=1&plan=${plan}`);
  };

  const handleClose = () => {
    setStep('upload');
    setFile(null);
    setLeaseType('master');
    setParentLeaseId('');
    setErrorMessage('');
    setTier2RejectDetail('');
    onOpenChange(false);
  };

  const handleRetry = () => {
    setStep('classify');
    setErrorMessage('');
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && t('lease.upload.title')}
            {step === 'classify' && t('lease.upload.classify_title')}
            {step === 'error' && t('lease.upload.error_title')}
            {step === 'tier2_rejected' && t('leases.upload.tier2_title')}
            {step === 'no_subscription' && t('leases.upload.no_subscription_title')}
          </DialogTitle>
          <DialogDescription>
            {step === 'upload' && t('lease.upload.upload_desc')}
            {step === 'classify' && t('lease.upload.classify_desc')}
            {step === 'error' && t('lease.upload.error_desc')}
            {step === 'tier2_rejected' && t('leases.upload.tier2_desc')}
            {step === 'no_subscription' && t('leases.upload.no_subscription_desc')}
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <>
          <p className="text-xs text-muted-foreground text-center -mt-1 mb-1">
            {t('leases.upload.privacy_note')}
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
              {isDragActive ? t('lease.upload.drop_here') : t('lease.upload.drag_drop')}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              {t('lease.upload.click_browse')}
            </p>
            <Button variant="outline" size="sm" type="button">
              {t('lease.upload.select_file')}
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
                {t('lease.upload.is_new_or_amendment')}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="text-sm">
                      <strong>{t('leases.upload.master_tooltip_label')}</strong> {t('leases.upload.master_tooltip_body')}
                    </p>
                    <p className="text-sm mt-1">
                      <strong>{t('leases.upload.amendment_tooltip_label')}</strong> {t('leases.upload.amendment_tooltip_body')}
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
                  <span className="font-medium">{t('lease.upload.new_lease')}</span>
                  <span className="text-xs text-muted-foreground text-center">
                    {t('lease.upload.original_doc')}
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
                  <span className="font-medium">{t('lease.upload.amendment_label')}</span>
                  <span className="text-xs text-muted-foreground text-center">
                    {t('lease.upload.modifies_existing')}
                  </span>
                </Label>
              </RadioGroup>
            </div>

            {/* Parent Lease Selection */}
            {leaseType === 'amendment' && (
              <div className="space-y-2 animate-fade-up">
                <Label htmlFor="parent-lease">{t('lease.upload.select_master')}</Label>
                <Select value={parentLeaseId} onValueChange={setParentLeaseId} disabled={loadingParentLeases}>
                  <SelectTrigger id="parent-lease">
                    <SelectValue placeholder={loadingParentLeases ? t('leases.upload.loading_leases') : t('lease.upload.search_select')} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableParentLeases.length === 0 && !loadingParentLeases ? (
                      <div className="p-2 text-center text-sm text-muted-foreground">
                        {t('leases.upload.no_posted_leases')}
                      </div>
                    ) : (
                      availableParentLeases.map((lease) => (
                        <SelectItem key={lease.id} value={lease.id}>
                          {lease.tenant_name || t('leases.upload.unknown_tenant')} - {lease.landlord_name || t('leases.upload.unknown_landlord')}
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
                {t('lease.upload.cancel')}
              </Button>
              <Button
                variant="accent"
                onClick={handleSubmit}
                className="flex-1"
                disabled={isUploading || (leaseType === 'amendment' && !parentLeaseId)}
              >
                {isUploading ? t('leases.upload.submitting') : <><span>{t('lease.upload.continue')}</span> <ChevronRight className="h-4 w-4 ml-1" /></>}
              </Button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className="flex flex-col items-center py-10">
            <div className="h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
              <AlertCircle className="h-8 w-8 text-destructive" />
            </div>
            <p className="text-sm font-medium mb-2">{t('lease.upload.error_title')}</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs mb-2">
              {errorMessage}
            </p>
            <p className="text-xs text-muted-foreground text-center max-w-xs mb-6">
              {t('leases.upload.try_again_note')}
            </p>
            <div className="flex gap-3 w-full">
              <Button variant="outline" onClick={handleClose} className="flex-1">
                {t('lease.upload.cancel')}
              </Button>
              <Button variant="accent" onClick={handleRetry} className="flex-1">
                {t('leases.upload.try_again')}
              </Button>
            </div>
          </div>
        )}

        {step === 'tier2_rejected' && (
          <div className="py-2">
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 mb-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-amber-900 mb-1">
                    {t('leases.upload.tier2_banner_title')}
                  </p>
                  <p className="text-xs text-amber-800">{tier2RejectDetail}</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-muted p-4 mb-4 text-xs text-muted-foreground space-y-2">
              <p>
                <strong className="text-foreground">{t('leases.upload.tier2_if_lease_label')}</strong> {t('leases.upload.tier2_if_lease_body')}
              </p>
              <p>
                <strong className="text-foreground">{t('leases.upload.tier2_wrong_file_label')}</strong> {t('leases.upload.tier2_wrong_file_body')}
              </p>
            </div>
            <div className="flex gap-3 w-full">
              <Button variant="outline" onClick={handleClose} className="flex-1" disabled={isUploading}>
                {t('lease.upload.cancel')}
              </Button>
              <Button
                variant="accent"
                onClick={handleTier2Override}
                className="flex-1"
                disabled={isUploading}
              >
                {isUploading ? t('leases.upload.processing') : t('leases.upload.override_proceed')}
              </Button>
            </div>
          </div>
        )}

        {step === 'no_subscription' && (
          <div className="flex flex-col items-center py-8">
            <div className="h-16 w-16 rounded-full bg-accent/10 flex items-center justify-center mb-4">
              <Sparkles className="h-8 w-8 text-accent" />
            </div>
            <p className="text-sm font-medium mb-2">{t('leases.upload.no_subscription_heading')}</p>
            <p className="text-xs text-muted-foreground text-center max-w-xs mb-6">
              {t('leases.upload.no_subscription_body')}
            </p>
            <div className="flex gap-3 w-full">
              <Button variant="outline" onClick={handleClose} className="flex-1">
                {t('lease.upload.cancel')}
              </Button>
              <Button variant="accent" onClick={handleStartTrial} className="flex-1">
                {t('leases.upload.no_subscription_cta')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
