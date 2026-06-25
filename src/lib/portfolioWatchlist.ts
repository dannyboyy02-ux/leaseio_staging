/**
 * Lease Watchlist — a deterministic rules engine that surfaces FACTUAL flags
 * from abstracted lease terms (dates, rates). Observational only: no scoring,
 * no projections, no advice (Hard Rule #2 / the design's voice guardrail).
 *
 * Pure and declarative: each rule is one entry in {@link RULES}. Two rules are
 * live on today's data (earliest term expiry, highest cost/sqft); two read
 * structured critical dates (`renewalNoticeDeadline`, `escalationCapEndDate`)
 * that are NULL until a Tier-1 extraction enhancement captures them — those
 * rules are fully written and simply emit nothing until the data arrives.
 */

import {
  costPerSqftByLocation,
  daysUntil,
  parseIso,
  type PortfolioLease,
} from '@/lib/portfolioIntelligence';

export type Severity = 'warning' | 'info' | 'muted';

export interface WatchFlag {
  leaseId: string;
  severity: Severity;
  /** lucide icon name. */
  icon: string;
  title: string;
  /** Literal fact — dates/rates only, never advice. */
  description: string;
  /** Short badge value (e.g. "47 days", "Sep 2026", "$43.60/sqft"). */
  value: string;
  department: string | null;
  /** The abstracted clause this came from — provenance + deep-link anchor. */
  sourceField: string;
  /** The relevant date (ISO) for secondary sort; null for non-dated flags. */
  date: string | null;
}

export interface WatchConfig {
  asOf: Date;
  /** Renewal-notice rule fires within this many days of the deadline. */
  noticeWindowDays?: number;
  /** Upcoming-expiry rule also fires for any lease ending within this window. */
  expiryWindowDays?: number;
  /** Highest-cost rule fires when the top rate exceeds avg × this factor. */
  highCostFactor?: number;
  /** Max flags returned (with a "view all" affordance beyond it in the UI). */
  cap?: number;
}

type ResolvedConfig = Required<WatchConfig>;
type WatchRule = (leases: PortfolioLease[], cfg: ResolvedConfig) => WatchFlag[];

const DEFAULTS: Omit<ResolvedConfig, 'asOf'> = {
  noticeWindowDays: 90,
  expiryWindowDays: 180,
  highCostFactor: 1,
  cap: 8,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonthYear = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const fmtLongDate = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

// --- Rules ----------------------------------------------------------------

/** LIVE — renewal notice deadline approaching. Dormant until the date is captured. */
const renewalNoticeDeadline: WatchRule = (leases, cfg) =>
  leases.flatMap((l) => {
    const days = daysUntil(cfg.asOf, l.renewalNoticeDeadline);
    if (days == null || days < 0 || days > cfg.noticeWindowDays) return [];
    const due = parseIso(l.renewalNoticeDeadline)!;
    return [{
      leaseId: l.id, severity: 'warning', icon: 'calendar-clock',
      title: `${l.propertyName} — renewal notice deadline approaching`,
      description: `Notice to renew is due ${fmtLongDate(due)} (${Math.round(days)} days out).`,
      value: `${Math.round(days)} days`, department: l.department,
      sourceField: 'renewalOptions', date: l.renewalNoticeDeadline,
    }];
  });

/** LIVE — the soonest expiry, plus any lease ending within the expiry window. */
const upcomingTermExpiry: WatchRule = (leases, cfg) => {
  const future = leases
    .map((l) => ({ l, end: parseIso(l.endDate) }))
    .filter((x): x is { l: PortfolioLease; end: Date } => !!x.end && x.end > cfg.asOf);
  if (!future.length) return [];
  const soonest = Math.min(...future.map((x) => x.end.getTime()));
  return future
    .filter((x) => x.end.getTime() === soonest || daysUntil(cfg.asOf, x.l.endDate)! <= cfg.expiryWindowDays)
    .map((x) => ({
      leaseId: x.l.id, severity: 'info' as const, icon: 'calendar',
      title: `${x.l.propertyName} — ${x.end.getTime() === soonest ? 'earliest term expiry' : 'upcoming term expiry'}`,
      description: `Lease term ends ${fmtLongDate(x.end)}${x.end.getTime() === soonest ? ' — the first in the portfolio to come up.' : '.'}`,
      value: fmtMonthYear(x.end), department: x.l.department,
      sourceField: 'expirationDate', date: x.l.endDate,
    }));
};

/** LIVE — the single highest cost-per-sqft lease, when above the blended average. */
const highestCostPerSqft: WatchRule = (leases, cfg) => {
  const { rows, averageRatePerSqft } = costPerSqftByLocation(leases);
  if (!rows.length || !averageRatePerSqft) return [];
  const top = rows[0];
  if (top.ratePerSqft <= averageRatePerSqft * cfg.highCostFactor) return [];
  const dept = leases.find((l) => l.id === top.id)?.department ?? null;
  return [{
    leaseId: top.id, severity: 'muted', icon: 'arrow-up-right',
    title: `${top.name} — highest cost per sqft`,
    description: `At $${top.ratePerSqft.toFixed(2)}/sqft, ${Math.round(top.deltaVsAvg * 100)}% above the $${averageRatePerSqft.toFixed(2)} portfolio blended average.`,
    value: `$${top.ratePerSqft.toFixed(2)}/sqft`, department: dept,
    sourceField: 'squareFootage', date: null,
  }];
};

/** LIVE — escalation cap expiring within the term horizon. Dormant until captured. */
const escalationCapExpiring: WatchRule = (leases, cfg) =>
  leases.flatMap((l) => {
    const days = daysUntil(cfg.asOf, l.escalationCapEndDate);
    if (days == null || days < 0) return [];
    const end = parseIso(l.escalationCapEndDate)!;
    return [{
      leaseId: l.id, severity: 'muted', icon: 'trending-up',
      title: `${l.propertyName} — escalation cap expires`,
      description: `The escalation cap in the current term ends ${fmtMonthYear(end)}.`,
      value: fmtMonthYear(end), department: l.department,
      sourceField: 'escalations', date: l.escalationCapEndDate,
    }];
  });

/** Order matters only for display grouping; sort below is the real ordering. */
const RULES: WatchRule[] = [
  renewalNoticeDeadline,
  upcomingTermExpiry,
  highestCostPerSqft,
  escalationCapExpiring,
];

const SEVERITY_RANK: Record<Severity, number> = { warning: 0, info: 1, muted: 2 };

/**
 * Run every rule, sort by severity then soonest date, cap the list. Adding a
 * rule is adding one entry to {@link RULES} — never hardcode flags in JSX.
 */
export function buildWatchlist(leases: PortfolioLease[], config: WatchConfig): WatchFlag[] {
  const cfg: ResolvedConfig = { ...DEFAULTS, ...config };
  return RULES.flatMap((rule) => rule(leases, cfg))
    .sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sev !== 0) return sev;
      const da = a.date ? parseIso(a.date)!.getTime() : Infinity;
      const db = b.date ? parseIso(b.date)!.getTime() : Infinity;
      return da - db;
    })
    .slice(0, cfg.cap);
}
