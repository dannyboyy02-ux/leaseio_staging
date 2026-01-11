import { useState } from 'react';
import { Check, X, RotateCcw, Pause, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApprovalType, ApprovalAction } from '@/types/lifecycle';

interface ApprovalActionsProps {
  approvalType: ApprovalType;
  onAction: (action: ApprovalAction, comment?: string) => Promise<boolean>;
  isLoading?: boolean;
  disabled?: boolean;
}

export function ApprovalActions({
  approvalType,
  onAction,
  isLoading = false,
  disabled = false,
}: ApprovalActionsProps) {
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<ApprovalAction | null>(null);
  const [comment, setComment] = useState('');

  const handleAction = async (action: ApprovalAction) => {
    if (action === 'send_back' || action === 'pause' || action === 'reject') {
      setPendingAction(action);
      setCommentDialogOpen(true);
    } else {
      const success = await onAction(action);
      if (success) {
        // Action completed
      }
    }
  };

  const handleConfirmWithComment = async () => {
    if (!pendingAction) return;
    
    const success = await onAction(pendingAction, comment);
    if (success) {
      setCommentDialogOpen(false);
      setComment('');
      setPendingAction(null);
    }
  };

  const isInternal = approvalType === 'internal';

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => handleAction('approve')}
          disabled={disabled || isLoading}
          className="bg-success hover:bg-success/90 text-success-foreground"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Check className="h-4 w-4 mr-2" />
          )}
          {isInternal ? 'Approve' : 'Approve for Execution'}
        </Button>

        <Button
          variant="outline"
          onClick={() => handleAction('send_back')}
          disabled={disabled || isLoading}
        >
          <RotateCcw className="h-4 w-4 mr-2" />
          Send Back
        </Button>

        {!isInternal && (
          <Button
            variant="outline"
            onClick={() => handleAction('pause')}
            disabled={disabled || isLoading}
          >
            <Pause className="h-4 w-4 mr-2" />
            Pause
          </Button>
        )}

        <Button
          variant="destructive"
          onClick={() => handleAction('reject')}
          disabled={disabled || isLoading}
        >
          <X className="h-4 w-4 mr-2" />
          Reject
        </Button>
      </div>

      <Dialog open={commentDialogOpen} onOpenChange={setCommentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingAction === 'send_back' && 'Send Back for Revision'}
              {pendingAction === 'pause' && 'Pause Approval'}
              {pendingAction === 'reject' && 'Reject Lease'}
            </DialogTitle>
            <DialogDescription>
              {pendingAction === 'send_back' && 'Provide feedback for the lease owner to address.'}
              {pendingAction === 'pause' && 'Explain why this approval is being paused.'}
              {pendingAction === 'reject' && 'Provide a reason for rejecting this lease.'}
            </DialogDescription>
          </DialogHeader>

          <Textarea
            placeholder="Enter your comment (required)..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
          />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCommentDialogOpen(false);
                setComment('');
                setPendingAction(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmWithComment}
              disabled={!comment.trim() || isLoading}
              variant={pendingAction === 'reject' ? 'destructive' : 'default'}
            >
              {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
