import { useMemo } from 'react';
import { format, differenceInCalendarDays } from 'date-fns';
import { parseToLocalDate } from '@/lib/dateFormatters';
import { Calendar, AlertCircle, TrendingUp, Bell } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface Props {
  lease: any;
}

type ChipTone = 'urgent' | 'soon' | 'neutral';

interface Chip {
  key: string;
  icon: typeof Calendar;
  label: string;
  date: Date;
  tone: ChipTone;
  /** Tooltip body — usually the source-text excerpt from extraction. */
  tooltip?: string;
}

const toneClass: Record<ChipTone, string> = {
  urgent: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300',
  soon: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
  neutral: 'border-border bg-muted/40 text-foreground',
};

const toneFromDays = (days: number): ChipTone => {
  if (days <= 90) return 'urgent';
  if (days <= 180) return 'soon';
  return 'neutral';
};

const formatDistance = (target: Date, t: (k: string) => string): string => {
  const days = differenceInCalendarDays(target, new Date());
  if (days <= 0) return t('locked_lease.critical_dates.today');
  if (days < 60) return `${days} ${days === 1 ? t('locked_lease.critical_dates.day') : t('locked_lease.critical_dates.days')}`;
  const months = Math.round(days / 30.4);
  return `${months} ${months === 1 ? t('locked_lease.critical_dates.month') : t('locked_lease.critical_dates.months')}`;
};

/**
 * Pull a value out of an extracted_json node (may be string or {value} shape).
 */
const extractedValue = (node: any): string | null => {
  if (!node) return null;
  if (typeof node === 'string') return node || null;
  if (typeof node === 'object' && 'value' in node) return node.value ?? null;
  return null;
};

/**
 * Look at a renewal_options text blob and try to extract the latest-allowed
 * notice window (months or days "prior to expiration"). Returns the deadline
 * date or null when no recognizable pattern is present. Examples it handles:
 *   "no later than 6 months prior to lease expiration"
 *   "at least 9 months before the expiration date"
 *   "between 12 and 6 months prior to expiration"  → uses the smaller (latest) window
 */
const renewalNoticeDeadline = (
  renewalText: string | null,
  leaseEnd: string | null
): { deadline: Date | null; matchedText: string | null } => {
  if (!renewalText || !leaseEnd) return { deadline: null, matchedText: null };
  const end = parseToLocalDate(leaseEnd);
  if (Number.isNaN(end.getTime())) return { deadline: null, matchedText: null };

  const patterns = [
    /no\s+later\s+than\s+(\d+)\s+(months?|days?)\s+prior/i,
    /at\s+least\s+(\d+)\s+(months?|days?)\s+(?:prior|before)/i,
    /not\s+less\s+than\s+(\d+)\s+(months?|days?)\s+prior/i,
    /(\d+)\s+(months?|days?)\s+(?:prior|before)\s+(?:to\s+)?(?:the\s+)?(?:then-current\s+)?(?:lease\s+)?(?:expiration|termination)/i,
  ];

  let bestUnits = Infinity;
  let bestUnit: 'days' | 'months' | null = null;
  let matchedText: string | null = null;
  for (const pat of patterns) {
    const m = pat.exec(renewalText);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = /day/i.test(m[2]) ? 'days' : 'months';
    // The smallest "must give notice by N units before expiry" is the latest-allowed
    // deadline — i.e. the closer date the operator must beat.
    if (n < bestUnits) {
      bestUnits = n;
      bestUnit = unit;
      matchedText = m[0];
    }
  }

  if (bestUnit == null || !Number.isFinite(bestUnits)) return { deadline: null, matchedText: null };

  const deadline = new Date(end);
  if (bestUnit === 'days') deadline.setDate(deadline.getDate() - bestUnits);
  else deadline.setMonth(deadline.getMonth() - bestUnits);

  return { deadline, matchedText };
};

export function CriticalDatesStrip({ lease }: Props) {
  const { t } = useAppTranslation();

  const chips: Chip[] = useMemo(() => {
    const today = new Date();
    const out: Chip[] = [];
    const extracted = lease?.extracted_json ?? null;

    // 1. Lease expiration
    if (lease?.lease_end) {
      const end = parseToLocalDate(lease.lease_end);
      if (!Number.isNaN(end.getTime()) && end >= today) {
        const days = differenceInCalendarDays(end, today);
        out.push({
          key: 'expiration',
          icon: Calendar,
          label: `${t('locked_lease.critical_dates.expires_in')} ${formatDistance(end, t)}`,
          date: end,
          tone: toneFromDays(days),
          tooltip: `${t('locked_lease.critical_dates.expiration_date')}: ${format(end, 'MMM d, yyyy')}`,
        });
      }
    }

    // 2. Renewal notice deadline (parsed from renewal_options text)
    const renewalRaw = extractedValue(extracted?.renewal_options);
    const renewal = renewalNoticeDeadline(renewalRaw, lease?.lease_end ?? null);
    if (renewal.deadline && renewal.deadline >= today) {
      const days = differenceInCalendarDays(renewal.deadline, today);
      out.push({
        key: 'renewal_notice',
        icon: Bell,
        label: `${t('locked_lease.critical_dates.renewal_notice_in')} ${formatDistance(renewal.deadline, t)}`,
        date: renewal.deadline,
        tone: toneFromDays(days),
        tooltip: renewal.matchedText
          ? `${t('locked_lease.critical_dates.parsed_from')} "${renewal.matchedText}"`
          : undefined,
      });
    }

    // 3. Next escalation / rent change from rent_schedule
    const rentSchedule = Array.isArray(extracted?.rent_schedule) ? extracted.rent_schedule : [];
    const nextRentChange = rentSchedule
      .map((entry: any) => {
        const d = entry?.period_start ? parseToLocalDate(entry.period_start) : null;
        return d && !Number.isNaN(d.getTime()) ? { date: d, notes: entry?.notes ?? null } : null;
      })
      .filter((e: any): e is { date: Date; notes: string | null } => !!e && e.date > today)
      .sort((a: any, b: any) => a.date.getTime() - b.date.getTime())[0];
    if (nextRentChange) {
      out.push({
        key: 'next_rent_change',
        icon: TrendingUp,
        label: `${t('locked_lease.critical_dates.next_rent_change_in')} ${formatDistance(nextRentChange.date, t)}`,
        date: nextRentChange.date,
        tone: 'neutral',
        tooltip: nextRentChange.notes ?? `${format(nextRentChange.date, 'MMM d, yyyy')}`,
      });
    }

    // 4. Next high-confidence key_date that we haven't already covered.
    //    Skip entries on/after lease_end — those are post-expiration commentary
    //    (renewal option period starts, MRV adjustment dates, expiration date
    //    itself) and the dedicated expiration chip already conveys that signal.
    const keyDates = Array.isArray(extracted?.key_dates) ? extracted.key_dates : [];
    const claimedTimes = new Set(out.map((c) => c.date.getTime()));
    const leaseEndDate = lease?.lease_end ? parseToLocalDate(lease.lease_end) : null;
    const leaseEndMs = leaseEndDate && !Number.isNaN(leaseEndDate.getTime())
      ? leaseEndDate.getTime()
      : null;
    const nextKeyDate = keyDates
      .map((entry: any) => {
        const d = entry?.date ? parseToLocalDate(entry.date) : null;
        const conf = typeof entry?.confidence === 'number' ? entry.confidence : 0;
        return d && !Number.isNaN(d.getTime()) && conf >= 0.85
          ? { date: d, description: entry?.description ?? null }
          : null;
      })
      .filter(
        (e: any): e is { date: Date; description: string | null } =>
          !!e
          && e.date > today
          && !claimedTimes.has(e.date.getTime())
          && (leaseEndMs == null || e.date.getTime() < leaseEndMs)
      )
      .sort((a: any, b: any) => a.date.getTime() - b.date.getTime())[0];
    if (nextKeyDate) {
      out.push({
        key: 'next_key_date',
        icon: AlertCircle,
        label: `${nextKeyDate.description ?? t('locked_lease.critical_dates.upcoming')} · ${formatDistance(nextKeyDate.date, t)}`,
        date: nextKeyDate.date,
        tone: 'neutral',
        tooltip: format(nextKeyDate.date, 'MMM d, yyyy'),
      });
    }

    return out.sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [lease, t]);

  if (chips.length === 0) return null;

  return (
    <TooltipProvider>
      <div className="border-b border-border bg-muted/10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mr-1">
            {t('locked_lease.critical_dates.label')}
          </span>
          {chips.map((chip) => {
            const Icon = chip.icon;
            const pill = (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium',
                  toneClass[chip.tone]
                )}
              >
                <Icon className="h-3 w-3" />
                {chip.label}
              </span>
            );
            return chip.tooltip ? (
              <Tooltip key={chip.key}>
                <TooltipTrigger asChild>{pill}</TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs text-xs">
                  {chip.tooltip}
                </TooltipContent>
              </Tooltip>
            ) : (
              <span key={chip.key}>{pill}</span>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
}
