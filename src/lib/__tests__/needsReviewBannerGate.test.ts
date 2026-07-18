import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src/pages/app/LeaseReview.tsx'), 'utf8');

// Fresh-eyes fix: NeedsReviewBanner used to be gated by
// needsReviewStatus(lease?.lifecycle_status), which matched lifecycle strings
// no lease ever holds — so the banner never rendered at all. That dead gate is
// removed. NeedsReviewBanner is self-gating (returns null unless a Tier-1 field
// is missing/low-confidence); it is now mounted for every non-Failed lease
// (Failed leases are owned by FailedLeaseBanner, which lists every field as
// "missing" and would duplicate the noise).

describe('LeaseReview — NeedsReviewBanner gate', () => {
  it('the dead needsReviewStatus(lease?.lifecycle_status) gate is gone', () => {
    expect(src).not.toContain('needsReviewStatus(lease?.lifecycle_status)');
  });

  it('needsReviewStatus is no longer imported', () => {
    const importsIt = src
      .split('\n')
      .some((line) => /^\s*import\b/.test(line) && /\bneedsReviewStatus\b/.test(line));
    expect(importsIt).toBe(false);
  });

  it('mounts <NeedsReviewBanner guarded only by !isFailedStatus(lease?.status)', () => {
    const mount = src.indexOf('<NeedsReviewBanner');
    expect(mount, 'NeedsReviewBanner mount not found').toBeGreaterThan(-1);
    // Window immediately preceding the mount — the guard is the JSX condition.
    const preceding = src.slice(Math.max(0, mount - 200), mount);
    expect(preceding).toContain('!isFailedStatus(lease?.status) && (');
  });
});
