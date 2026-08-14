import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PORTFOLIO_STATES,
  isPortfolioLease,
  classifyLease,
  currentMonthlyRent,
  partitionPortfolio,
} from '../../../supabase/functions/_shared/ai_portfolio';

// #187 — Leo (ai-assistant) must mirror the UI scope: count/sum only the live
// portfolio (active/executed/fully_executed, archived excluded at the fetch),
// use schedule-aware rent, and never count drafts/pipeline as active. These pure
// helpers back that contract and are unit-tested here even though the edge
// function runs on Deno.

const ASOF = new Date('2026-08-11T00:00:00Z');

describe('ai_portfolio — PORTFOLIO_STATES / isPortfolioLease', () => {
  it('the live portfolio is exactly active/executed/fully_executed', () => {
    expect([...PORTFOLIO_STATES]).toEqual(['active', 'executed', 'fully_executed']);
  });

  it('counts active/executed/fully_executed as portfolio, everything else not', () => {
    expect(isPortfolioLease({ lifecycle_status: 'active' })).toBe(true);
    expect(isPortfolioLease({ lifecycle_status: 'executed' })).toBe(true);
    expect(isPortfolioLease({ lifecycle_status: 'fully_executed' })).toBe(true);
    for (const s of ['draft', 'in_negotiation', 'rejected', 'concept_submitted', 'final_review']) {
      expect(isPortfolioLease({ lifecycle_status: s }), `${s} must NOT be portfolio`).toBe(false);
    }
    expect(isPortfolioLease({ lifecycle_status: null })).toBe(false);
  });
});

describe('ai_portfolio — classifyLease (pipeline vs closed, integrity #187 follow-up)', () => {
  it('classifies live portfolio states as portfolio', () => {
    for (const s of ['active', 'executed', 'fully_executed']) {
      expect(classifyLease({ lifecycle_status: s })).toBe('portfolio');
    }
  });

  it('classifies in-flight request/approval states as pipeline', () => {
    for (const s of ['draft', 'submitted', 'under_review', 'concept_submitted', 'in_negotiation', 'final_review', 'pending_counter_signature', 'approved']) {
      expect(classifyLease({ lifecycle_status: s }), `${s} should be pipeline`).toBe('pipeline');
    }
  });

  it('classifies terminal/exception states as closed — NOT pipeline (the mislabel bug)', () => {
    for (const s of ['rejected', 'expired', 'chain_violation']) {
      expect(classifyLease({ lifecycle_status: s }), `${s} must be closed, not pipeline`).toBe('closed');
    }
  });
});

describe('ai_portfolio — currentMonthlyRent (schedule-aware, matches the dashboard)', () => {
  it('prefers the rent-schedule step covering the as-of date (the escalated step)', () => {
    // A 3 Latitude-style lease: base current_monthly_rent is the low year-1
    // number, but the schedule step covering today is the escalated amount.
    const lease = {
      current_monthly_rent: 69491.15,
      rent_schedules: [
        { period_start: '2023-03-01', period_end: '2024-02-29', monthly_amount: 69491.15 },
        { period_start: '2026-03-01', period_end: '2027-02-28', monthly_amount: 77646.08 },
      ],
    };
    expect(currentMonthlyRent(lease, ASOF)).toBe(77646.08);
  });

  it('falls back executed → current → base when no schedule covers the date', () => {
    expect(currentMonthlyRent({ current_monthly_rent: 8400 }, ASOF)).toBe(8400);
    expect(
      currentMonthlyRent({ executed_monthly_payment: 12000, current_monthly_rent: 8400 }, ASOF),
    ).toBe(12000);
    expect(currentMonthlyRent({ monthly_payment: 500 }, ASOF)).toBe(500);
    expect(
      currentMonthlyRent({ rent_schedules: [], current_monthly_rent: 8400 }, ASOF),
    ).toBe(8400);
  });

  it('returns 0 when nothing is set (a draft with no rent yet)', () => {
    expect(currentMonthlyRent({}, ASOF)).toBe(0);
    expect(currentMonthlyRent({ current_monthly_rent: null }, ASOF)).toBe(0);
  });
});

describe('ai_portfolio — partitionPortfolio (the #187 regression)', () => {
  // Mirrors the Labs Analytix audit fixture that produced the wrong Leo answer:
  // 5 genuine active leases (one schedule-escalated), plus drafts + a rejected
  // lease in the pipeline. NOTE: archived leases are excluded at the DB fetch,
  // so a correct caller never passes them in — the partition here operates on
  // the already-archived-filtered set.
  const leases = [
    { lifecycle_status: 'active', current_monthly_rent: 8400 },
    { lifecycle_status: 'active', current_monthly_rent: 12500 },
    { lifecycle_status: 'active', current_monthly_rent: 52083.33 },
    {
      lifecycle_status: 'active',
      current_monthly_rent: 69491.15,
      rent_schedules: [{ period_start: '2026-03-01', period_end: '2027-02-28', monthly_amount: 77646.08 }],
    },
    {
      lifecycle_status: 'active',
      current_monthly_rent: 69491.15,
      rent_schedules: [{ period_start: '2026-03-01', period_end: '2027-02-28', monthly_amount: 77646.08 }],
    },
    { lifecycle_status: 'draft' },
    { lifecycle_status: 'draft' },
    { lifecycle_status: 'rejected' },
    { lifecycle_status: 'in_negotiation' },
    { lifecycle_status: 'expired' },
  ];

  it('counts only the 5 live leases as portfolio; splits pipeline (draft/in-negotiation) from closed (rejected/expired)', () => {
    const { portfolio, pipeline, closed } = partitionPortfolio(leases, ASOF);
    expect(portfolio.length).toBe(5);
    // 2 draft + 1 in_negotiation are genuine pipeline
    expect(pipeline.length).toBe(3);
    // rejected + expired are closed, never counted as pipeline
    expect(closed.length).toBe(2);
    expect(pipeline.every((l) => l.lifecycle_status !== 'rejected' && l.lifecycle_status !== 'expired')).toBe(true);
  });

  it('sums schedule-aware rent to the dashboard total ($228,275), NOT the ~$293,957 bug', () => {
    const { totalMonthly } = partitionPortfolio(leases, ASOF);
    // 8400 + 12500 + 52083.33 + 77646.08 + 77646.08 (the escalated steps, not base 69491.15)
    expect(totalMonthly).toBeCloseTo(228275.49, 2);
    // Guard against the regression: the base-rent, count-everything answer.
    expect(Math.round(totalMonthly)).not.toBe(293957);
  });

  it('drafts contribute 0 to the total (no rent) and are never counted as active', () => {
    const drafts = [{ lifecycle_status: 'draft' }, { lifecycle_status: 'draft' }];
    const { portfolio, totalMonthly } = partitionPortfolio(drafts, ASOF);
    expect(portfolio.length).toBe(0);
    expect(totalMonthly).toBe(0);
  });
});

// Static pins: the edge function must actually apply the UI scope at the fetch
// and use the shared partition — the unit tests above only prove the helpers.
describe('ai-assistant/index.ts applies the #187 UI scope', () => {
  const src = readFileSync(
    join(process.cwd(), 'supabase/functions/ai-assistant/index.ts'),
    'utf8',
  );

  it('excludes archived leases at the fetch (matches dashboard/Portfolio/Leases)', () => {
    expect(src).toContain(".eq('archived', false)");
  });

  it('joins rent_schedules so the total is schedule-aware', () => {
    expect(src).toContain('rent_schedules(period_start, period_end, monthly_amount)');
  });

  it('still excludes cancelled and soft-deleted leases', () => {
    expect(src).toContain("'(\"cancelled\")'");
    expect(src).toContain(".is('deleted_at', null)");
  });

  it('uses the shared portfolio partition rather than an inline active-bucket', () => {
    expect(src).toContain('partitionPortfolio(leases)');
    expect(src).toContain('from "../_shared/ai_portfolio.ts"');
    // the old bug: draft bucketed as active
    expect(src).not.toContain("['active', 'executed', 'draft']");
  });
});
