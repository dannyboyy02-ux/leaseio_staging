// Page-level status strip for LeaseReview.tsx.
//
// Sits below the title and tells the reviewer what's blocking the next
// gesture. Computes a single primary message from the lease's lifecycle
// state + field-review progress and (when there's work to do) exposes a
// "Review" action that jumps to the first unreviewed low-confidence
// field.
//
// The action is intentionally singular. Other actions still exist in
// the header toolbar, but this strip's job is to remove the "what do I
// do next?" question entirely.

import { AlertTriangle, CheckCircle2, Lock, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Props {
  isProcessing: boolean;
  modelLocked: boolean;
  isApproved: boolean;
  isPendingApproval: boolean;
  canApprove: boolean;
  lowConfidenceCount: number;
  unreviewedLowConfCount: number;
  onReview: () => void;
}

type Tone = 'info' | 'attention' | 'ready' | 'success';

interface DerivedState {
  tone: Tone;
  label: string;
  detail: string;
  cta?: { label: string; onClick: () => void };
}

function deriveState(props: Props): DerivedState {
  const {
    isProcessing,
    modelLocked,
    isApproved,
    isPendingApproval,
    canApprove,
    lowConfidenceCount,
    unreviewedLowConfCount,
    onReview,
  } = props;

  if (isProcessing) {
    return {
      tone: 'info',
      label: 'Extracting',
      detail: 'Reading the document. Fields will populate when extraction completes.',
    };
  }

  if (unreviewedLowConfCount > 0) {
    return {
      tone: 'attention',
      label: `${unreviewedLowConfCount} fields need attention`,
      detail: 'AI is unsure about these — verify them before approving.',
      cta: { label: 'Review now', onClick: onReview },
    };
  }

  if (!canApprove) {
    return {
      tone: 'info',
      label: 'Confirm required sections',
      detail: 'Mark each required section reviewed to enable approval.',
    };
  }

  if (!isApproved) {
    return {
      tone: 'ready',
      label: 'Ready to approve',
      detail: lowConfidenceCount > 0
        ? 'All flagged fields reviewed. Approve to advance the lease.'
        : 'All required fields verified. Approve to advance the lease.',
    };
  }

  if (isApproved && !modelLocked) {
    return {
      tone: 'ready',
      label: 'Ready to lock',
      detail: 'Approved. Lock the model to finalize the lease record.',
    };
  }

  if (modelLocked && isPendingApproval) {
    return {
      tone: 'info',
      label: 'Awaiting approval',
      detail: 'Lease is locked and routed to approvers.',
    };
  }

  return {
    tone: 'success',
    label: 'Approved & locked',
    detail: 'Lease record is finalized.',
  };
}

const TONE_STYLES: Record<Tone, { container: string; badge: string; icon: typeof AlertTriangle }> = {
  info: {
    container: 'border-border bg-muted/30',
    badge: 'bg-muted text-muted-foreground',
    icon: Loader2,
  },
  attention: {
    container: 'border-amber-300 bg-amber-50 dark:bg-amber-950/20',
    badge: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
    icon: AlertTriangle,
  },
  ready: {
    container: 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20',
    badge: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200',
    icon: CheckCircle2,
  },
  success: {
    container: 'border-border bg-muted/20',
    badge: 'bg-muted text-muted-foreground',
    icon: Lock,
  },
};

export function LeaseReviewStatusStrip(props: Props) {
  const state = deriveState(props);

  // Terminal "Approved & locked" state has no decision for the user —
  // the lifecycle badge in the title carries the same signal. Suppress
  // the strip so the page stops talking when there's nothing to say.
  if (state.tone === 'success' && !state.cta && !props.isProcessing) {
    return null;
  }

  const styles = TONE_STYLES[state.tone];
  const Icon = styles.icon;
  const iconClasses = state.tone === 'info' && props.isProcessing ? 'h-4 w-4 animate-spin' : 'h-4 w-4';

  return (
    <div
      className={`flex items-center justify-between gap-4 border rounded-lg px-4 py-2.5 mx-6 mt-3 ${styles.container}`}
      role="status"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge className={`gap-1.5 ${styles.badge}`} variant="secondary">
          <Icon className={iconClasses} />
          {state.label}
        </Badge>
        <span className="text-sm text-muted-foreground truncate">{state.detail}</span>
      </div>
      {state.cta && (
        <Button size="sm" onClick={state.cta.onClick}>
          {state.cta.label}
        </Button>
      )}
    </div>
  );
}
