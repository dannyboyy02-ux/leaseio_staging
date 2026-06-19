import { describe, expect, it } from 'vitest';
import { isFrontierActiveRequiredStep, type FrontierStepLike } from '../approvalChainLogic';

// KNOWN_ISSUES #111 C1 (GAP-1) — behavioral coverage of the frontier predicate
// the backfill migration uses to decide which step gets pending_since. The
// static migration test only proves the SQL *contains* the predicate; this
// proves it *selects* correctly over real chain shapes (the logic most likely
// to mis-flag stuck chains / early-activate delegates).

const S = (
  stage: 'concept' | 'signator',
  step_order: number,
  status: string,
  is_required = true,
): FrontierStepLike => ({ stage, step_order, status, is_required });

describe('isFrontierActiveRequiredStep', () => {
  it('single pending concept step → active', () => {
    const chain = [S('concept', 1, 'pending')];
    expect(isFrontierActiveRequiredStep(chain[0], chain)).toBe(true);
  });

  it('sequential concept (step1 approved, step2 pending) → step2 active', () => {
    const chain = [S('concept', 1, 'approved'), S('concept', 2, 'pending')];
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(true);
  });

  it('sequential concept both pending → only the lower step_order is active', () => {
    const chain = [S('concept', 1, 'pending'), S('concept', 2, 'pending')];
    expect(isFrontierActiveRequiredStep(chain[0], chain)).toBe(true);
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(false);
  });

  it('mid-signator (concept approved, signator pending) → signator active', () => {
    const chain = [S('concept', 1, 'approved'), S('signator', 1, 'pending')];
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(true);
  });

  it('concept blocks signator: both pending → concept active, signator NOT active', () => {
    const chain = [S('concept', 1, 'pending'), S('signator', 1, 'pending')];
    expect(isFrontierActiveRequiredStep(chain[0], chain)).toBe(true);
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(false);
  });

  it('parallel group (same stage+step_order, both pending) → both co-active', () => {
    const chain = [S('concept', 1, 'pending'), S('concept', 1, 'pending')];
    expect(isFrontierActiveRequiredStep(chain[0], chain)).toBe(true);
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(true);
  });

  it('non-required pending step → never active (backfill skips it)', () => {
    const chain = [S('concept', 1, 'pending', false)];
    expect(isFrontierActiveRequiredStep(chain[0], chain)).toBe(false);
  });

  it('non-pending target (approved/superseded) → not active', () => {
    const chain = [S('concept', 1, 'approved'), S('concept', 1, 'superseded')];
    expect(isFrontierActiveRequiredStep(chain[0], chain)).toBe(false);
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(false);
  });

  it('an earlier sent_back required step blocks a later pending step', () => {
    const chain = [S('concept', 1, 'sent_back'), S('concept', 2, 'pending')];
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(false);
  });

  it('approved/skipped/superseded earlier steps do NOT block (only pending/sent_back do)', () => {
    const chain = [
      S('concept', 1, 'approved'),
      S('concept', 2, 'skipped'),
      S('concept', 3, 'superseded'),
      S('concept', 4, 'pending'),
    ];
    expect(isFrontierActiveRequiredStep(chain[3], chain)).toBe(true);
  });

  it('a non-required earlier pending step does not block (only required rows count)', () => {
    const chain = [S('concept', 1, 'pending', false), S('concept', 2, 'pending', true)];
    expect(isFrontierActiveRequiredStep(chain[1], chain)).toBe(true);
  });
});
