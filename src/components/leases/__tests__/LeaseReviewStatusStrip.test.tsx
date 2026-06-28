// @vitest-environment jsdom
import '../../workspace/__tests__/_jsdomPolyfills';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Regression coverage for "Phase A — active-edit mode coherence".
//
// The bug this pins: the status strip's deriveState used to drive its label
// purely off the first-time review/approve funnel, so an ALREADY-ACTIVE lease
// (and an active lease unlocked into a governed edit session) could show
// "Ready to approve / Approve to advance the lease" — copy that only makes
// sense on a first-time review. deriveState now takes lifecycleStatus,
// isUnlockedDraft and stagedItemCount, and:
//   - speaks edit-session language while unlocked (Editing / Changes staged),
//   - resolves an already-active lease to the suppressed success tone
//     (NEVER ready_to_approve),
//   - still shows ready_to_approve for a NON-active first-time review.
//
// deriveState is module-internal (not exported), so we exercise it through the
// rendered <LeaseReviewStatusStrip> and assert on the label/detail text. We
// mock useLanguage to ECHO the i18n key (repo convention, see
// NeedsReviewBanner.test.tsx) so assertions pin the STATE→key contract, not the
// English copy — which is free to change. The component calls
// t('lease_review.<key>'), so an "editing" state surfaces as the literal
// string 'lease_review.strip.editing_label'.

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'en' as const,
    setLanguage: () => {},
    // Echo the key + interpolated params so a state maps to a stable, copy-
    // independent string. Mirrors the param-suffix shape other component tests
    // use (e.g. NeedsReviewBanner) for interpolated keys.
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        const params = Object.entries(opts)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',');
        return params ? `${key}(${params})` : key;
      }
      return key;
    },
  }),
}));

import { LeaseReviewStatusStrip } from '../LeaseReviewStatusStrip';

afterEach(cleanup);

// Baseline props for a strip that would otherwise fall through to the
// ready_to_approve branch: not processing, not locked/approved/pending, all
// sections confirmed (canApprove=true), no flagged fields. Each test overrides
// only the axis under test.
const READY_BASE = {
  isProcessing: false,
  modelLocked: false,
  isApproved: false,
  isPendingApproval: false,
  canApprove: true,
  lowConfidenceCount: 0,
  unreviewedLowConfCount: 0,
  onReview: () => {},
  confirmedSectionCount: 4,
  totalRequiredSections: 4,
  remainingSectionTitles: [] as string[],
  requiredSectionTitles: ['Parties', 'Dates', 'Rent', 'Term'] as string[],
  onConfirmAllRequired: () => {},
} as const;

// Keys (prefixed with the component's `lease_review.` namespace) that the echo
// mock will surface for each state.
const EDITING_LABEL = 'lease_review.strip.editing_label';
const STAGED_LABEL = 'lease_review.strip.staged_label';
const READY_LABEL = 'lease_review.strip.ready_to_approve_label';
const FINAL_LABEL = 'lease_review.strip.final_label';

describe('LeaseReviewStatusStrip — unlocked edit session', () => {
  it('isUnlockedDraft + 0 staged → "editing" label, never ready_to_approve', () => {
    render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus="active"
        isUnlockedDraft
        stagedItemCount={0}
      />,
    );
    expect(screen.getByText(EDITING_LABEL)).toBeTruthy();
    expect(screen.queryByText(READY_LABEL)).toBeNull();
    expect(screen.queryByText(STAGED_LABEL)).toBeNull();
  });

  it('isUnlockedDraft + >0 staged → "staged" label, never editing or ready_to_approve', () => {
    render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus="active"
        isUnlockedDraft
        stagedItemCount={3}
      />,
    );
    expect(screen.getByText(STAGED_LABEL)).toBeTruthy();
    expect(screen.queryByText(EDITING_LABEL)).toBeNull();
    expect(screen.queryByText(READY_LABEL)).toBeNull();
  });

  it('treats an undefined stagedItemCount on an unlocked draft as 0 → "editing"', () => {
    // stagedItemCount omitted entirely (?? 0 fallback) — guards the nullish
    // coalescing so a missing count doesn't accidentally read as "staged".
    render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus="active"
        isUnlockedDraft
      />,
    );
    expect(screen.getByText(EDITING_LABEL)).toBeTruthy();
    expect(screen.queryByText(STAGED_LABEL)).toBeNull();
  });

  it('unlocked-draft wins even with unreviewed flagged fields present', () => {
    // The unlocked-draft branch sits ABOVE the flagged-fields branch, so an
    // active lease in an edit session must never regress into "X flagged
    // fields / Review" funnel copy.
    render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus="active"
        isUnlockedDraft
        stagedItemCount={0}
        canApprove={false}
        unreviewedLowConfCount={2}
        lowConfidenceCount={2}
      />,
    );
    expect(screen.getByText(EDITING_LABEL)).toBeTruthy();
    expect(screen.queryByText(/lease_review\.strip\.flagged_label/)).toBeNull();
    expect(screen.queryByText(READY_LABEL)).toBeNull();
  });
});

describe('LeaseReviewStatusStrip — already-active lease (not unlocked)', () => {
  it('active + canApprove + !isApproved → suppressed (no strip, no ready_to_approve)', () => {
    // The pre-fix bug: this exact state rendered "Ready to approve / Approve to
    // advance the lease" on a lease that had already advanced past approval.
    // deriveState now resolves it to the success tone, which the render-level
    // guard suppresses entirely (the lifecycle badge already carries state).
    const { container } = render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus="active"
        isUnlockedDraft={false}
        stagedItemCount={0}
      />,
    );
    // Whole strip suppressed: success tone + no cta + not processing → null.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(READY_LABEL)).toBeNull();
    expect(screen.queryByText(FINAL_LABEL)).toBeNull();
  });

  it('active branch sits above the first-time funnel even with sections incomplete', () => {
    // canApprove=false (sections unconfirmed) on an active lease must NOT drop
    // into the "X of Y sections" progress meter — the active short-circuit wins.
    const { container } = render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus="active"
        isUnlockedDraft={false}
        canApprove={false}
        confirmedSectionCount={1}
        unreviewedLowConfCount={0}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/lease_review\.strip\.progress_label/)).toBeNull();
    expect(screen.queryByText(READY_LABEL)).toBeNull();
  });
});

describe('LeaseReviewStatusStrip — first-time review regression guard (NOT broken)', () => {
  it('non-active (undefined lifecycle) + canApprove + !isApproved → ready_to_approve', () => {
    render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus={undefined}
        isUnlockedDraft={false}
        stagedItemCount={0}
      />,
    );
    expect(screen.getByText(READY_LABEL)).toBeTruthy();
  });

  it("lifecycleStatus='executed' + canApprove + !isApproved → ready_to_approve", () => {
    // 'executed' is a pre-active first-time-review state — it must still funnel
    // toward approval. Only the literal 'active' short-circuits.
    render(
      <LeaseReviewStatusStrip
        {...READY_BASE}
        lifecycleStatus="executed"
        isUnlockedDraft={false}
        stagedItemCount={0}
      />,
    );
    expect(screen.getByText(READY_LABEL)).toBeTruthy();
  });
});
