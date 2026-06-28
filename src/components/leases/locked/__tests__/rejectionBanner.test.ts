import { describe, expect, it } from 'vitest';
import { shouldShowRejectionBanner } from '../rejectionBanner';

// Regression coverage for the H7 verdict banner on the locked-lease page
// (Phase B). The banner is the submitter's ONLY signal that a governed edit
// was declined, so its gate must hold exactly: show iff the most-recent
// terminal change set is rejected AND submitted by the current user AND not
// dismissed. This logic was inline in LockedLeaseDetail's effect; it was
// hoisted into shouldShowRejectionBanner() so the truth table is pinned here
// without a DB or render harness.

const UID = 'user-1';

describe('shouldShowRejectionBanner — truth table', () => {
  it('shows when rejected + mine + undismissed', () => {
    expect(
      shouldShowRejectionBanner({ status: 'rejected', submitted_by: UID }, UID, false),
    ).toBe(true);
  });

  it('hides when the verdict is approved (even if mine + undismissed)', () => {
    expect(
      shouldShowRejectionBanner({ status: 'approved', submitted_by: UID }, UID, false),
    ).toBe(false);
  });

  it('hides when rejected but submitted by someone else', () => {
    expect(
      shouldShowRejectionBanner({ status: 'rejected', submitted_by: 'someone-else' }, UID, false),
    ).toBe(false);
  });

  it('hides when rejected + mine but already dismissed', () => {
    expect(
      shouldShowRejectionBanner({ status: 'rejected', submitted_by: UID }, UID, true),
    ).toBe(false);
  });
});

describe('shouldShowRejectionBanner — null / missing inputs', () => {
  it('hides when there is no terminal change set', () => {
    expect(shouldShowRejectionBanner(null, UID, false)).toBe(false);
    expect(shouldShowRejectionBanner(undefined, UID, false)).toBe(false);
  });

  it('hides when there is no current user (anonymous / unresolved auth)', () => {
    expect(
      shouldShowRejectionBanner({ status: 'rejected', submitted_by: UID }, null, false),
    ).toBe(false);
    expect(
      shouldShowRejectionBanner({ status: 'rejected', submitted_by: UID }, undefined, false),
    ).toBe(false);
  });

  it('does NOT match a null submitter against a null user (never show to nobody)', () => {
    // Guards against `null === null` leaking the banner when neither the change
    // set nor the session has a user id.
    expect(
      shouldShowRejectionBanner({ status: 'rejected', submitted_by: null }, null, false),
    ).toBe(false);
  });

  it('returns a strict boolean (never the truthy object/undefined)', () => {
    const r = shouldShowRejectionBanner({ status: 'rejected', submitted_by: UID }, UID, false);
    expect(r).toBe(true);
    expect(typeof r).toBe('boolean');
  });
});
