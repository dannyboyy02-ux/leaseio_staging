import { describe, it, expect } from 'vitest';
import {
  decideSubmissionOutcome,
  type ChainSuccess,
  type ChainLegacyFallback,
  type ChainFailure,
} from '../leaseSubmissionDecision';

// ─── The four LeaseRequestForm submission scenarios ──────────────────────
//
// These are the customer-visible failure modes for every new lease. They
// MUST stay green — they are the entry-point contract for the chain-driven
// submission flow introduced in Phase 2 / 3.
//
// The form itself is React-heavy and the project has no jsdom or
// testing-library setup; the post-resolution decision is pulled into a
// pure helper (src/lib/leaseSubmissionDecision.ts) so the four outcomes
// are unit-testable here. The form code is now a thin wrapper that
// applies the helper's decision (UPDATE leases + notify + activity log).

const baseChainSuccess: ChainSuccess = {
  ok: true,
  legacyFallback: false,
  policyId: 'p-123',
  policyVersion: 1,
  policyName: 'Default policy',
  stepsCreated: 2,
  firstStepAssignees: [{ userId: 'u-1', role: null }],
  targetLifecycleStatus: 'concept_submitted',
};

// ─── Scenario 1: chain success — uses targetLifecycleStatus ──────────────

describe('decideSubmissionOutcome — chain success', () => {
  it('flips to the targetLifecycleStatus returned by the resolver', () => {
    const out = decideSubmissionOutcome(baseChainSuccess, 'submitted', null);
    expect(out.kind).toBe('proceed');
    if (out.kind !== 'proceed') return;
    expect(out.finalStatus).toBe('concept_submitted');
    expect(out.routingPath).toBe('chain');
    expect(out.chainSuccess).toEqual(baseChainSuccess);
  });

  it('passes through the chain-success payload so the form can notify assignees + write the activity log', () => {
    const out = decideSubmissionOutcome(baseChainSuccess, 'submitted', null);
    if (out.kind !== 'proceed') throw new Error('expected proceed');
    expect(out.chainSuccess?.policyId).toBe('p-123');
    expect(out.chainSuccess?.firstStepAssignees).toHaveLength(1);
  });

  it('falls back to "submitted" if a pre-Phase-3 edge function build is somehow live (no targetLifecycleStatus field)', () => {
    const legacyResolver = { ...baseChainSuccess, targetLifecycleStatus: undefined };
    const out = decideSubmissionOutcome(legacyResolver, 'submitted', null);
    if (out.kind !== 'proceed') throw new Error('expected proceed');
    expect(out.finalStatus).toBe('submitted');
    expect(out.routingPath).toBe('chain');
  });

  it('does NOT fall back to legacyInitialStatus when chain succeeds — chain decisions override legacy', () => {
    const out = decideSubmissionOutcome(baseChainSuccess, 'approved', null);
    if (out.kind !== 'proceed') throw new Error('expected proceed');
    // legacyInitialStatus = 'approved' is ignored in chain mode
    expect(out.finalStatus).toBe('concept_submitted');
  });
});

// ─── Scenario 2: legacy fallback — uses legacyInitialStatus ──────────────

describe('decideSubmissionOutcome — legacy fallback', () => {
  const legacyFallback: ChainLegacyFallback = {
    ok: true,
    legacyFallback: true,
    message: 'No approval policies configured',
  };

  it('flips to the legacyInitialStatus from approvalRouting when no policies exist', () => {
    const out = decideSubmissionOutcome(legacyFallback, 'submitted', null);
    expect(out.kind).toBe('proceed');
    if (out.kind !== 'proceed') return;
    expect(out.finalStatus).toBe('submitted');
    expect(out.routingPath).toBe('legacy');
    expect(out.chainSuccess).toBeUndefined();
  });

  it('honors any legacy initial status the routing helper picked (under_review)', () => {
    const out = decideSubmissionOutcome(legacyFallback, 'under_review', null);
    if (out.kind !== 'proceed') throw new Error('expected proceed');
    expect(out.finalStatus).toBe('under_review');
    expect(out.routingPath).toBe('legacy');
  });

  it('honors auto-approve case (approved)', () => {
    const out = decideSubmissionOutcome(legacyFallback, 'approved', null);
    if (out.kind !== 'proceed') throw new Error('expected proceed');
    expect(out.finalStatus).toBe('approved');
    expect(out.routingPath).toBe('legacy');
  });
});

// ─── Scenario 3: ambiguous match — toast + lease stays in draft ──────────
//
// resolve-approval-chain returns { ok: false, reason: 'ambiguous_match', ... }
// when two policies tie at top priority. Form must surface a toast and
// leave the lease in 'draft' so the admin can disambiguate; the resolver
// is idempotent on initialResolution=true so the user can retry.

describe('decideSubmissionOutcome — ambiguous match (and other ok=false reasons)', () => {
  it('returns leave_draft with the resolver error message for ambiguous_match', () => {
    const ambiguous: ChainFailure = {
      ok: false,
      error: 'Multiple policies tied at top priority. Ask an admin to disambiguate.',
      reason: 'ambiguous_match',
    };
    const out = decideSubmissionOutcome(ambiguous, 'submitted', null);
    expect(out.kind).toBe('leave_draft');
    if (out.kind !== 'leave_draft') return;
    expect(out.errorMessage).toContain('Multiple policies');
  });

  it('returns leave_draft for no_match_no_fallback', () => {
    const noMatch: ChainFailure = {
      ok: false,
      error: 'No matching policy and no default fallback configured.',
      reason: 'no_match_no_fallback',
    };
    const out = decideSubmissionOutcome(noMatch, 'submitted', null);
    expect(out.kind).toBe('leave_draft');
    if (out.kind !== 'leave_draft') return;
    expect(out.errorMessage).toContain('No matching policy');
  });

  it('returns leave_draft for separation_violation', () => {
    const sod: ChainFailure = {
      ok: false,
      error: 'Separation of duties violated: the same user appears in multiple steps.',
      reason: 'separation_violation',
    };
    const out = decideSubmissionOutcome(sod, 'submitted', null);
    expect(out.kind).toBe('leave_draft');
    if (out.kind !== 'leave_draft') return;
    expect(out.errorMessage).toContain('Separation');
  });

  it('falls back to a generic message if the resolver returned ok=false but no error string', () => {
    const noMessage = { ok: false, error: '', reason: 'invalid_lease' } as ChainFailure;
    const out = decideSubmissionOutcome(noMessage, 'submitted', null);
    if (out.kind !== 'leave_draft') throw new Error('expected leave_draft');
    expect(out.errorMessage).toBe('Could not route this request for approval. Contact your admin.');
  });

  // legacyInitialStatus is irrelevant when the resolver fails — the lease
  // stays in 'draft' regardless. Verify the helper does not silently
  // promote a failure to a legacy-path success.
  it('does NOT promote a failure to a legacy-path success even if legacyInitialStatus is supplied', () => {
    const ambiguous: ChainFailure = {
      ok: false,
      error: 'tie',
      reason: 'ambiguous_match',
    };
    const out = decideSubmissionOutcome(ambiguous, 'approved', null);
    expect(out.kind).toBe('leave_draft');
  });
});

// ─── Scenario 4: network error during resolve — toast + lease stays in draft

describe('decideSubmissionOutcome — network error during resolve', () => {
  it('returns leave_draft when supabase.functions.invoke surfaces a network error', () => {
    const netErr = { message: 'Failed to fetch' };
    // chainResult is null when invoke errors
    const out = decideSubmissionOutcome(null, 'submitted', netErr);
    expect(out.kind).toBe('leave_draft');
    if (out.kind !== 'leave_draft') return;
    expect(out.errorMessage).toBe('Failed to fetch');
  });

  it('uses the generic message when the network error has no message', () => {
    const out = decideSubmissionOutcome(null, 'submitted', {});
    if (out.kind !== 'leave_draft') throw new Error('expected leave_draft');
    expect(out.errorMessage).toBe('Could not route this request for approval. Contact your admin.');
  });

  it('returns leave_draft when chainResult is null AND no chainError (defensive — should not happen)', () => {
    const out = decideSubmissionOutcome(null, 'submitted', null);
    expect(out.kind).toBe('leave_draft');
    if (out.kind !== 'leave_draft') return;
    expect(out.errorMessage).toBe('Could not route this request for approval. Contact your admin.');
  });

  // Edge case: the resolver responded successfully but the network layer ALSO
  // surfaced an error (some flaky proxy scenarios). chainError takes
  // precedence — we don't want to act on a partial response.
  it('treats chainError as authoritative even when chainResult was returned', () => {
    const out = decideSubmissionOutcome(baseChainSuccess, 'submitted', { message: 'flaky proxy' });
    if (out.kind !== 'leave_draft') throw new Error('expected leave_draft');
    expect(out.errorMessage).toBe('flaky proxy');
  });
});
