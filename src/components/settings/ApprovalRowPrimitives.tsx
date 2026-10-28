// ─────────────────────────────────────────────────────────────────────────
// Shared row primitives for the "How requests are routed" list.
//
// Both ApprovalRuleRow and ApprovalEverythingElseRow render the SAME grid
// (`responsivePlan`): one shape at every width — ordinal gutter / content /
// kebab — with no breakpoint-conditional layout and nothing that can push a
// sibling off-screen. A row's HEIGHT varies; its width never overflows.
//
// Two hard rules encoded here, because they are the ones that get eroded:
//   • NO `truncate` / `line-clamp` anywhere on a row. A clamped approver line
//     is a lie on the one surface whose thesis is naming who approves.
//   • NO color-only or opacity-only meaning. Every tone pairs an ICON with a
//     WORD; tone classes below never ship a color without a paired icon at the
//     call site (RowNote enforces this by requiring an icon).
// ─────────────────────────────────────────────────────────────────────────

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Severity of one note line under a row. `blocking` is destructive — a
 *  request would be turned away; `caution` is amber — someone should look;
 *  `muted` is a plain factual statement and is deliberately NOT amber. */
export type RowNoteTone = 'blocking' | 'caution' | 'muted';

const NOTE_TONE_CLASS: Record<RowNoteTone, string> = {
  blocking: 'text-destructive',
  caution: 'text-amber-700 dark:text-amber-400',
  muted: 'text-muted-foreground',
};

interface RowNoteProps {
  /** Required: meaning is never carried by color alone. */
  icon: LucideIcon;
  tone: RowNoteTone;
  children: ReactNode;
  /** Inline one-click fix. Rendered above the row's overlay link. */
  action?: ReactNode;
  className?: string;
}

/**
 * One warning / explainer line under a row. Wraps freely and is never
 * clamped. The icon is `aria-hidden` because the sentence beside it already
 * carries the whole meaning — the icon is redundancy for sighted users, not
 * the signal itself.
 */
export function RowNote({ icon: Icon, tone, children, action, className }: RowNoteProps) {
  return (
    <p
      className={cn(
        'flex flex-wrap items-start gap-x-1.5 gap-y-1 text-xs leading-relaxed break-words',
        NOTE_TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
      {action ? <span className="relative z-10 shrink-0">{action}</span> : null}
    </p>
  );
}

interface RowShellProps {
  /** Ordinal gutter cell. Pass `null` when ordering is irrelevant — the
   *  gutter then narrows to 1rem and renders a `•` marker instead of a
   *  number, so the order model recedes to nothing where it decides nothing. */
  gutter: ReactNode;
  /** true when the gutter carries a real ordinal (wider column). */
  wideGutter: boolean;
  /** Absolutely-positioned overlay link, or null for a non-navigable row. */
  overlay?: ReactNode;
  /** Kebab / trailing action cell. Rendered ABOVE the overlay in z-order. */
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Rendered as an <li>; the caller supplies the <ul role="list">. */
  id?: string;
}

/**
 * The row chrome. `focus-within` + `has-[:focus-visible]` both draw the ring:
 * the `has-` variant is the precise one (keyboard only) and `focus-within` is
 * the fallback for browsers without `:has()` support.
 */
export function RowShell({
  gutter,
  wideGutter,
  overlay,
  trailing,
  children,
  className,
  id,
}: RowShellProps) {
  return (
    <li
      id={id}
      className={cn(
        'relative rounded-md border bg-card p-3',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2',
        className,
      )}
    >
      {overlay}
      <div
        className={cn(
          'grid gap-2 items-start',
          wideGutter
            ? 'grid-cols-[1.5rem_minmax(0,1fr)_2.5rem]'
            : 'grid-cols-[1rem_minmax(0,1fr)_2.5rem]',
        )}
      >
        <div className="pt-0.5 text-xs tabular-nums text-muted-foreground select-none">
          {gutter}
        </div>
        <div className="min-w-0 space-y-1.5">{children}</div>
        <div className="relative z-10 flex justify-end">{trailing}</div>
      </div>
    </li>
  );
}
