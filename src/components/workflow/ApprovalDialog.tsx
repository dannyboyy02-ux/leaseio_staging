import { useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface ApprovalDialogProps {
  leaseId: string;
  leaseFilename: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

// Mock abstraction data to simulate AI processing
const MOCK_ABSTRACTION_DATA = {
  property_address: { value: '123 Main Street, Suite 100', confidence: 95 },
  landlord_name: { value: 'ABC Properties LLC', confidence: 88 },
  tenant_name: { value: 'Demo Company Inc', confidence: 72 },
  lease_start: { value: '2025-02-01', confidence: 91 },
  lease_end: { value: '2028-02-01', confidence: 85 },
  monthly_rent: { value: 5000, confidence: 65 },
  security_deposit: { value: 10000, confidence: 78 },
};

const MOCK_CONFIDENCE_SCORES = {
  property_address: 95,
  landlord_name: 88,
  tenant_name: 72,
  lease_start: 91,
  lease_end: 85,
  monthly_rent: 65,
  security_deposit: 78,
};

export function ApprovalDialog({
  leaseId,
  leaseFilename,
  open,
  onOpenChange,
  onComplete,
}: ApprovalDialogProps) {
  const [mode, setMode] = useState<'choose' | 'reject'>('choose');
  const [rejectionComment, setRejectionComment] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleApprove = async () => {
    setIsProcessing(true);
    try {
      // Set status to "Abstracting"
      await supabase
        .from('leases')
        .update({
          status: 'Abstracting',
          lifecycle_status: 'Abstracting',
        })
        .eq('id', leaseId);

      toast.info('Processing lease with AI...', { duration: 5000 });

      // Simulate 5-second AI abstraction process
      setTimeout(async () => {
        try {
          await supabase
            .from('leases')
            .update({
              status: 'Review Required',
              lifecycle_status: 'Review Required',
              extracted_json: MOCK_ABSTRACTION_DATA,
              confidence_scores: MOCK_CONFIDENCE_SCORES,
            })
            .eq('id', leaseId);

          toast.success('AI abstraction complete! Lease is ready for review.');
          onComplete?.();
        } catch (error) {
          console.error('Error completing abstraction:', error);
          toast.error('Abstraction failed');
        }
      }, 5000);

      onOpenChange(false);
    } catch (error: any) {
      console.error('Error approving lease:', error);
      toast.error('Failed to approve lease');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!rejectionComment.trim()) {
      toast.error('Please provide a reason for rejection');
      return;
    }

    setIsProcessing(true);
    try {
      const { error } = await supabase
        .from('leases')
        .update({
          status: 'Rejected',
          lifecycle_status: 'Rejected',
          rejection_comment: rejectionComment.trim(),
        })
        .eq('id', leaseId);

      if (error) throw error;

      toast.success('Lease rejected');
      onOpenChange(false);
      setMode('choose');
      setRejectionComment('');
      onComplete?.();
    } catch (error: any) {
      console.error('Error rejecting lease:', error);
      toast.error('Failed to reject lease');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    if (!isProcessing) {
      onOpenChange(false);
      setMode('choose');
      setRejectionComment('');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {mode === 'choose' ? 'Review Lease Submission' : 'Reject Lease'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {mode === 'choose' ? (
              <>
                <span className="font-medium">{leaseFilename}</span>
                <br />
                Review this lease submission and approve or reject it.
              </>
            ) : (
              'Please provide a reason for rejecting this lease. The initiator will be able to see this comment and make corrections.'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {mode === 'reject' && (
          <div className="space-y-2">
            <Label htmlFor="rejection-comment">Rejection Reason</Label>
            <Textarea
              id="rejection-comment"
              placeholder="Please explain why this lease is being rejected..."
              value={rejectionComment}
              onChange={(e) => setRejectionComment(e.target.value)}
              rows={4}
            />
          </div>
        )}

        <AlertDialogFooter>
          {mode === 'choose' ? (
            <>
              <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => setMode('reject')}
                disabled={isProcessing}
              >
                <X className="h-4 w-4 mr-2" />
                Reject
              </Button>
              <Button onClick={handleApprove} disabled={isProcessing}>
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Check className="h-4 w-4 mr-2" />
                )}
                Approve
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setMode('choose')}
                disabled={isProcessing}
              >
                Back
              </Button>
              <Button
                variant="destructive"
                onClick={handleReject}
                disabled={isProcessing || !rejectionComment.trim()}
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <X className="h-4 w-4 mr-2" />
                )}
                Confirm Rejection
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
