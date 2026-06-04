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
import { useLanguage } from '@/contexts/LanguageContext';

interface Props {
  isProcessing: boolean;
  modelLocked: boolean;
  isApproved: boolean;
  isPendingApproval: boolean;
  canApprove: boolean;
  lowConfidenceCount: number;
  unreviewedLowConfCount: number;
  onReview: () => void;
  /** Number of required sections currently confirmed. */
  confirmedSectionCount?: number;
  /** Total number of required sections. */
  totalRequiredSections?: number;
  /** Titles of sections still needing review — surfaced inline so the
   * reviewer can see what's left without scrolling. */
  remainingSectionTitles?: string[];
  /** Titles of all required sections (fallback when remaining list is
   * not provided). */
  requiredSectionTitles?: string[];
  /** Bulk action: mark every required section reviewed in one click. */
  onConfirmAllRequired?: () => void;
}

type Tone = 'info' | 'attention' | 'ready' | 'success';

interface DerivedState {
  tone: Tone;
  label: string;
  detail: string;
  cta?: { label: string; onClick: () => void };
}

// Format a list of section titles using the platform's i18n list formatter
// so 1/2/3+ items all read naturally in both English ("Parties and Dates",
// "Parties, Dates, and Rent") and Spanish ("Partes y Fechas", "Partes,
// Fechas y Renta"). Falls back to a comma join if Intl.ListFormat is
// missing.
function formatList(items: string[], language: 'en' | 'es'): string {
  if (items.length === 0) return '';
  const LF = (Intl as unknown as { ListFormat?: new (locale: string, opts: { style: string; type: string }) => { format(items: string[]): string } }).ListFormat;
  if (LF) {
    try {
      return new LF(language === 'es' ? 'es' : 'en', { style: 'long', type: 'conjunction' }).format(items);
    } catch {
      /* fall through to join */
    }
  }
  return items.join(', ');
}

function deriveState(props: Props, t: (key: string, opts?: Record<string, unknown>) => string, language: 'en' | 'es'): DerivedState {
  const {
    isProcessing,
    modelLocked,
    isApproved,
    isPendingApproval,
    canApprove,
    lowConfidenceCount,
    unreviewedLowConfCount,
    onReview,
    confirmedSectionCount,
    totalRequiredSections,
    remainingSectionTitles,
    requiredSectionTitles,
    onConfirmAllRequired,
  } = props;

  if (isProcessing) {
    return {
      tone: 'info',
      label: t('strip.extracting_label'),
      detail: t('strip.extracting_detail'),
    };
  }

  if (unreviewedLowConfCount > 0) {
    return {
      tone: 'attention',
      label: t('strip.flagged_label', { count: unreviewedLowConfCount }),
      detail: t('strip.flagged_detail'),
      cta: { label: t('strip.review_cta'), onClick: onReview },
    };
  }

  if (!canApprove) {
    // Progress meter wording. Names what's left, not what's done — the
    // reviewer needs to know where to go next, not pat themselves on
    // the back.
    const done = confirmedSectionCount ?? 0;
    const total = totalRequiredSections ?? requiredSectionTitles?.length ?? 0;
    const remaining = remainingSectionTitles && remainingSectionTitles.length > 0
      ? formatList(remainingSectionTitles, language)
      : (requiredSectionTitles && requiredSectionTitles.length > 0
        ? formatList(requiredSectionTitles, language)
        : t('strip.required_sections_fallback'));
    return {
      tone: 'info',
      label: total > 0
        ? t('strip.progress_label', { done, total })
        : t('strip.confirm_required_label'),
      detail: t('strip.progress_detail', { sections: remaining }),
      cta: onConfirmAllRequired
        ? { label: t('strip.mark_required_cta'), onClick: onConfirmAllRequired }
        : undefined,
    };
  }

  if (!isApproved) {
    return {
      tone: 'ready',
      label: t('strip.ready_to_approve_label'),
      detail: lowConfidenceCount > 0
        ? t('strip.ready_to_approve_detail_after_flagged')
        : t('strip.ready_to_approve_detail'),
    };
  }

  if (isApproved && !modelLocked) {
    return {
      tone: 'ready',
      label: t('strip.ready_to_lock_label'),
      detail: t('strip.ready_to_lock_detail'),
    };
  }

  if (modelLocked && isPendingApproval) {
    return {
      tone: 'info',
      label: t('strip.awaiting_approval_label'),
      detail: t('strip.awaiting_approval_detail'),
    };
  }

  return {
    tone: 'success',
    label: t('strip.final_label'),
    detail: t('strip.final_detail'),
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
  const { t, language } = useLanguage();
  const state = deriveState(props, (key, opts) => String(t(`lease_review.${key}`, opts as any)), language);

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
      className={`flex items-start justify-between gap-4 border rounded-lg px-4 py-2.5 mx-6 mt-3 ${styles.container}`}
      role="status"
    >
      <div className="flex items-start gap-3 min-w-0 flex-1 flex-wrap">
        <Badge className={`gap-1.5 shrink-0 ${styles.badge}`} variant="secondary">
          <Icon className={iconClasses} />
          {state.label}
        </Badge>
        {/* Wrap rather than truncate — the detail line IS the answer to
            "what should I do next?" and clipping it off the right edge
            of a narrow split-panel viewport is a dead-end. */}
        <span className="text-sm text-muted-foreground break-words" title={state.detail}>
          {state.detail}
        </span>
      </div>
      {state.cta && (
        <Button size="sm" onClick={state.cta.onClick}>
          {state.cta.label}
        </Button>
      )}
    </div>
  );
}
