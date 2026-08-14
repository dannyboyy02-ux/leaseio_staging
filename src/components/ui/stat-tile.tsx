import { type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// StatTile — the one labeled-stat-value tile (FS-8).
//
// Consolidates the three hand-rolled KPI tiles that made the dashboards feel
// authored by three people: SummaryStrip's interactive StatBox (Dashboard),
// Portfolio's KpiTile, and FirmDashboard's stat() helper. Each had a different
// value font/weight and container. This is the single treatment:
// font-display / text-2xl / bold / tabular-nums, in a shadcn Card.
//
// Static use is trivial — <StatTile label value sub />. The interactive Dashboard
// tiles opt into the rest: `accent` tints the card, `onClick` makes the whole
// card a clickable target with a hover affordance, and `trailing` is a top-right
// slot (SummaryStrip's dismiss button).

export type StatTileAccent = 'default' | 'blue' | 'orange' | 'red';

// Dark pairs required (Wave 5): these light-only tints rendered as washed
// bright patches on the dark theme — on the KPI strip, the alert-accented
// tiles were the LEAST readable ones. One constant fixes every StatTile
// surface (Dashboard, Portfolio, FirmDashboard) at once.
const ACCENT_CLASS: Record<StatTileAccent, string> = {
  default: '',
  blue: 'border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30',
  orange: 'border-orange-200 bg-orange-50/50 dark:border-orange-900 dark:bg-orange-950/30',
  red: 'border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/30',
};

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** Leading icon before the label (FirmDashboard style). */
  icon?: ReactNode;
  /** Native title on the value — reveals the full figure on hover when it truncates. */
  valueTitle?: string;
  /** Native title on the label — reveals the full label on hover when it truncates
   *  (labels are truncated to keep tile heights equal across a row). */
  labelTitle?: string;
  accent?: StatTileAccent;
  /** When set, the whole tile becomes a clickable card with a hover affordance. */
  onClick?: () => void;
  /** Extra top-right slot (e.g. a dismiss button), rendered before the affordance. */
  trailing?: ReactNode;
  className?: string;
}

export function StatTile({
  label,
  value,
  sub,
  icon,
  valueTitle,
  labelTitle,
  accent = 'default',
  onClick,
  trailing,
  className,
}: StatTileProps) {
  const interactive = onClick != null;
  return (
    <Card
      variant={interactive ? 'interactive' : 'default'}
      onClick={onClick}
      // A clickable tile must be keyboard-operable: expose it as a button and
      // activate on Enter/Space (Card is a plain div, so this doesn't come for
      // free). Fixes the KPI shortcuts for keyboard users in one place.
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        'group p-4',
        interactive &&
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        ACCENT_CLASS[accent],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          {icon}
          <span className="truncate text-xs" title={labelTitle}>
            {label}
          </span>
        </div>
        {(trailing || interactive) && (
          <div className="flex shrink-0 items-center gap-1">
            {trailing}
            {interactive && (
              <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground" />
            )}
          </div>
        )}
      </div>
      <p
        className="mt-1.5 truncate font-display text-2xl font-bold tracking-tight tabular-nums"
        title={valueTitle}
      >
        {value}
      </p>
      {sub != null && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}
