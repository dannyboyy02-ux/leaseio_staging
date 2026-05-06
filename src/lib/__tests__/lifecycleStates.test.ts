import { describe, it, expect } from 'vitest';
import {
  ALL_STATES,
  STATE_GROUPS,
  VALID_TRANSITIONS,
  type LifecycleStatus,
  canTransition,
  counterSignatureUrgency,
  counterSignatureUrgencyLabel,
  type CounterSignatureUrgency,
  displayLabel,
  groupOf,
  isEquivalent,
  normalizeToChainStates,
} from '../lifecycleStates';

// ─── groupOf ─────────────────────────────────────────────────────────────

describe('groupOf', () => {
  it('returns the correct group for every legacy state', () => {
    expect(groupOf('draft')).toBe('pre_submission');
    expect(groupOf('submitted')).toBe('awaiting_concept_approval');
    expect(groupOf('under_review')).toBe('in_concept_review');
    expect(groupOf('approved')).toBe('post_concept_pre_signator');
    expect(groupOf('executed')).toBe('executed_pre_active');
    expect(groupOf('active')).toBe('active');
    expect(groupOf('expired')).toBe('terminal_neutral');
    expect(groupOf('rejected')).toBe('terminal_negative');
    expect(groupOf('cancelled')).toBe('terminal_negative');
  });

  it('returns the correct group for every chain state', () => {
    expect(groupOf('concept_submitted')).toBe('awaiting_concept_approval');
    expect(groupOf('concept_under_review')).toBe('in_concept_review');
    expect(groupOf('in_negotiation')).toBe('post_concept_pre_signator');
    expect(groupOf('final_review')).toBe('signator_review');
    expect(groupOf('pending_counter_signature')).toBe('awaiting_counter_signature');
    expect(groupOf('fully_executed')).toBe('executed_pre_active');
    expect(groupOf('chain_violation')).toBe('exception');
  });

  it('returns null for unknown values', () => {
    expect(groupOf('not_a_state' as LifecycleStatus)).toBeNull();
    expect(groupOf('' as LifecycleStatus)).toBeNull();
  });

  it('every state in ALL_STATES has a group', () => {
    for (const s of ALL_STATES) {
      expect(groupOf(s)).not.toBeNull();
    }
  });

  it('every state in STATE_GROUPS round-trips via groupOf', () => {
    for (const [group, members] of Object.entries(STATE_GROUPS)) {
      for (const s of members) {
        expect(groupOf(s as LifecycleStatus)).toBe(group);
      }
    }
  });
});

// ─── isEquivalent ────────────────────────────────────────────────────────

describe('isEquivalent', () => {
  it('returns true for identical states', () => {
    expect(isEquivalent('submitted', 'submitted')).toBe(true);
    expect(isEquivalent('active', 'active')).toBe(true);
  });

  it('returns true for legacy/chain pairs in the same group', () => {
    expect(isEquivalent('submitted', 'concept_submitted')).toBe(true);
    expect(isEquivalent('under_review', 'concept_under_review')).toBe(true);
    expect(isEquivalent('approved', 'in_negotiation')).toBe(true);
    expect(isEquivalent('executed', 'fully_executed')).toBe(true);
    // And symmetrically
    expect(isEquivalent('concept_submitted', 'submitted')).toBe(true);
    expect(isEquivalent('fully_executed', 'executed')).toBe(true);
  });

  it('returns true for sibling states in terminal_negative', () => {
    expect(isEquivalent('rejected', 'cancelled')).toBe(true);
  });

  it('returns false for states in different groups', () => {
    expect(isEquivalent('draft', 'submitted')).toBe(false);
    expect(isEquivalent('submitted', 'approved')).toBe(false);
    expect(isEquivalent('active', 'expired')).toBe(false);
    expect(isEquivalent('final_review', 'pending_counter_signature')).toBe(false);
    expect(isEquivalent('chain_violation', 'rejected')).toBe(false);
  });

  it('returns false when either input is unknown', () => {
    expect(isEquivalent('submitted', 'not_a_state' as LifecycleStatus)).toBe(false);
    expect(isEquivalent('not_a_state' as LifecycleStatus, 'submitted')).toBe(false);
    expect(isEquivalent('foo' as LifecycleStatus, 'bar' as LifecycleStatus)).toBe(false);
  });
});

// ─── normalizeToChainStates ──────────────────────────────────────────────

describe('normalizeToChainStates', () => {
  it('maps every legacy state to its chain equivalent', () => {
    expect(normalizeToChainStates('draft')).toBe('draft');
    expect(normalizeToChainStates('submitted')).toBe('concept_submitted');
    expect(normalizeToChainStates('under_review')).toBe('concept_under_review');
    expect(normalizeToChainStates('approved')).toBe('in_negotiation');
    expect(normalizeToChainStates('executed')).toBe('fully_executed');
    expect(normalizeToChainStates('active')).toBe('active');
    expect(normalizeToChainStates('expired')).toBe('expired');
    expect(normalizeToChainStates('rejected')).toBe('rejected');
    expect(normalizeToChainStates('cancelled')).toBe('cancelled');
  });

  it('passes chain states through unchanged', () => {
    const chainStates = [
      'concept_submitted',
      'concept_under_review',
      'in_negotiation',
      'final_review',
      'pending_counter_signature',
      'fully_executed',
      'chain_violation',
    ] as const;
    for (const s of chainStates) {
      expect(normalizeToChainStates(s)).toBe(s);
    }
  });

  it('the normalized value of any legacy state is in the same group as the legacy original', () => {
    const legacyStates: LifecycleStatus[] = [
      'draft', 'submitted', 'under_review', 'approved',
      'executed', 'active', 'expired', 'rejected', 'cancelled',
    ];
    for (const s of legacyStates) {
      const normalized = normalizeToChainStates(s);
      expect(normalized).not.toBeNull();
      expect(isEquivalent(s, normalized!)).toBe(true);
    }
  });
});

// ─── displayLabel ────────────────────────────────────────────────────────

describe('displayLabel', () => {
  it('returns a non-empty string for every known state', () => {
    for (const s of ALL_STATES) {
      const label = displayLabel(s);
      expect(label).toBeTypeOf('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('renders identical labels for legacy/chain pairs that share user-facing meaning', () => {
    // These pairs are intentionally identical — the chain vocabulary is
    // an internal-only refinement and should not surface to the user.
    expect(displayLabel('submitted')).toBe(displayLabel('concept_submitted'));
    expect(displayLabel('under_review')).toBe(displayLabel('concept_under_review'));
  });

  it('renders intentionally distinct labels for chain states that carry richer semantics', () => {
    // approved vs in_negotiation: legacy "approved" means "all approvers
    // signed off"; chain "in_negotiation" means "concept approved, now
    // negotiating the document". The user-facing meaning differs, so
    // labels diverge by spec.
    expect(displayLabel('approved')).toBe('Approved');
    expect(displayLabel('in_negotiation')).toBe('In Negotiation');
    expect(displayLabel('approved')).not.toBe(displayLabel('in_negotiation'));

    // executed vs fully_executed: legacy "executed" means "executed
    // document uploaded" (one-sided); chain "fully_executed" means "both
    // parties signed". The chain version carries a stricter semantic.
    expect(displayLabel('executed')).toBe('Executed');
    expect(displayLabel('fully_executed')).toBe('Fully Executed');
    expect(displayLabel('executed')).not.toBe(displayLabel('fully_executed'));
  });

  it('returns the raw status string for unknown values (defensive)', () => {
    expect(displayLabel('not_a_state' as LifecycleStatus)).toBe('not_a_state');
  });

  it('returns the spec-defined labels for every state', () => {
    expect(displayLabel('draft')).toBe('Draft');
    expect(displayLabel('submitted')).toBe('Submitted');
    expect(displayLabel('under_review')).toBe('Under Review');
    expect(displayLabel('approved')).toBe('Approved');
    expect(displayLabel('executed')).toBe('Executed');
    expect(displayLabel('active')).toBe('Active');
    expect(displayLabel('expired')).toBe('Expired');
    expect(displayLabel('rejected')).toBe('Rejected');
    expect(displayLabel('cancelled')).toBe('Cancelled');
    expect(displayLabel('concept_submitted')).toBe('Submitted');
    expect(displayLabel('concept_under_review')).toBe('Under Review');
    expect(displayLabel('in_negotiation')).toBe('In Negotiation');
    expect(displayLabel('final_review')).toBe('Final Review');
    expect(displayLabel('pending_counter_signature')).toBe('Awaiting Counter-Signature');
    expect(displayLabel('fully_executed')).toBe('Fully Executed');
    expect(displayLabel('chain_violation')).toBe('Chain Violation');
  });
});

// ─── canTransition — transition graph lock ───────────────────────────────
//
// Programmatically verifies every entry in VALID_TRANSITIONS is allowed,
// and every (from, to) pair NOT in VALID_TRANSITIONS is rejected. This
// locks the transition graph against silent drift — adding a new state
// or transition forces a corresponding test signal.

describe('canTransition — transition graph lock', () => {
  it('allows every transition declared in VALID_TRANSITIONS', () => {
    for (const [from, allowedTos] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of allowedTos) {
        const ok = canTransition(from as LifecycleStatus, to);
        if (!ok) {
          throw new Error(`Expected canTransition('${from}', '${to}') = true, got false`);
        }
        expect(ok).toBe(true);
      }
    }
  });

  it('rejects every (from, to) pair NOT in VALID_TRANSITIONS', () => {
    // For each (from, to) over the full state space, if (from, to) is not
    // in VALID_TRANSITIONS[from], canTransition must return false.
    for (const from of ALL_STATES) {
      const allowed = new Set(VALID_TRANSITIONS[from] ?? []);
      for (const to of ALL_STATES) {
        const isAllowed = allowed.has(to);
        const result = canTransition(from, to);
        if (isAllowed) {
          // covered by the test above; skip
          continue;
        }
        if (result) {
          throw new Error(
            `Expected canTransition('${from}', '${to}') = false (not in VALID_TRANSITIONS), got true`,
          );
        }
        expect(result).toBe(false);
      }
    }
  });

  it('rejects self-transitions for every state', () => {
    for (const s of ALL_STATES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('rejects transitions to unknown destination states', () => {
    expect(canTransition('draft', 'not_a_state' as LifecycleStatus)).toBe(false);
    expect(canTransition('active', 'foo' as LifecycleStatus)).toBe(false);
  });

  it('rejects transitions from unknown origin states', () => {
    expect(canTransition('not_a_state' as LifecycleStatus, 'cancelled')).toBe(false);
    expect(canTransition('foo' as LifecycleStatus, 'draft')).toBe(false);
  });

  it('terminal states have empty transition lists', () => {
    expect(VALID_TRANSITIONS.expired).toEqual([]);
    expect(VALID_TRANSITIONS.rejected).toEqual([]);
    expect(VALID_TRANSITIONS.cancelled).toEqual([]);
    // canTransition reflects this
    for (const to of ALL_STATES) {
      expect(canTransition('expired', to)).toBe(false);
      expect(canTransition('rejected', to)).toBe(false);
      expect(canTransition('cancelled', to)).toBe(false);
    }
  });
});

// ─── Sanity: STATE_GROUPS membership covers ALL_STATES ───────────────────

describe('STATE_GROUPS coverage', () => {
  it('every state in ALL_STATES belongs to exactly one group', () => {
    for (const s of ALL_STATES) {
      let count = 0;
      for (const members of Object.values(STATE_GROUPS)) {
        if ((members as readonly string[]).includes(s)) count++;
      }
      expect(count).toBe(1);
    }
  });

  it('every state listed in STATE_GROUPS is also in ALL_STATES', () => {
    for (const members of Object.values(STATE_GROUPS)) {
      for (const s of members) {
        expect(ALL_STATES).toContain(s as LifecycleStatus);
      }
    }
  });
});

// ─── counterSignatureUrgency (Phase 5) ──────────────────────────────────
//
// Truth table per the spec:
//   daysUntil >  7  → on_track
//   1 ≤ daysUntil ≤ 7 → approaching
//   daysUntil === 0 → due_today
//   -13 ≤ daysUntil ≤ -1 → overdue
//   daysUntil ≤ -14 → critically_overdue
//   null / undefined / invalid → no_due_date

describe('counterSignatureUrgency', () => {
  // Anchor "today" to a fixed UTC midnight so the calendar-day
  // truncation is deterministic across timezones.
  const today = new Date(Date.UTC(2026, 4, 20)); // 2026-05-20 UTC

  function dueIn(days: number): Date {
    return new Date(Date.UTC(2026, 4, 20 + days));
  }

  it('returns no_due_date for null', () => {
    expect(counterSignatureUrgency(null, today)).toBe('no_due_date');
  });

  it('returns no_due_date for undefined', () => {
    expect(counterSignatureUrgency(undefined as any, today)).toBe('no_due_date');
  });

  it('returns no_due_date for an invalid date string', () => {
    expect(counterSignatureUrgency('not-a-date', today)).toBe('no_due_date');
  });

  it('returns on_track for due dates more than 7 days away', () => {
    expect(counterSignatureUrgency(dueIn(30), today)).toBe('on_track');
    expect(counterSignatureUrgency(dueIn(8), today)).toBe('on_track');
    expect(counterSignatureUrgency(dueIn(365), today)).toBe('on_track');
  });

  it('returns approaching for 1 through 7 days away', () => {
    expect(counterSignatureUrgency(dueIn(7), today)).toBe('approaching');
    expect(counterSignatureUrgency(dueIn(5), today)).toBe('approaching');
    expect(counterSignatureUrgency(dueIn(1), today)).toBe('approaching');
  });

  it('returns due_today for the same calendar day', () => {
    expect(counterSignatureUrgency(dueIn(0), today)).toBe('due_today');
  });

  it('treats different times within the same calendar day as due_today (calendar-day truncation)', () => {
    // Due at 2026-05-20T00:00 UTC, today at 2026-05-20T18:30 UTC.
    // Without the truncation this would compute negative ms and bucket
    // into 'overdue'; with the truncation both fall in day 20 → due_today.
    const todayLater = new Date(Date.UTC(2026, 4, 20, 18, 30, 0));
    const dueEarlier = new Date(Date.UTC(2026, 4, 20, 0, 0, 0));
    expect(counterSignatureUrgency(dueEarlier, todayLater)).toBe('due_today');
  });

  it('returns overdue for 1 through 13 days past due', () => {
    expect(counterSignatureUrgency(dueIn(-1), today)).toBe('overdue');
    expect(counterSignatureUrgency(dueIn(-7), today)).toBe('overdue');
    expect(counterSignatureUrgency(dueIn(-13), today)).toBe('overdue');
  });

  it('returns critically_overdue at 14+ days past due', () => {
    expect(counterSignatureUrgency(dueIn(-14), today)).toBe('critically_overdue');
    expect(counterSignatureUrgency(dueIn(-30), today)).toBe('critically_overdue');
    expect(counterSignatureUrgency(dueIn(-365), today)).toBe('critically_overdue');
  });

  it('accepts ISO date strings (the shape the DB returns for date columns)', () => {
    expect(counterSignatureUrgency('2026-05-21', today)).toBe('approaching');
    expect(counterSignatureUrgency('2026-05-20', today)).toBe('due_today');
    expect(counterSignatureUrgency('2026-05-19', today)).toBe('overdue');
    expect(counterSignatureUrgency('2026-05-06', today)).toBe('critically_overdue');
    expect(counterSignatureUrgency('2026-06-30', today)).toBe('on_track');
  });

  it('uses new Date() as default for today (smoke — verifies it doesn\'t throw)', () => {
    // Can't pin "now", so just verify it returns a valid bucket.
    const result = counterSignatureUrgency(new Date(Date.now() + 24 * 60 * 60 * 1000));
    expect([
      'on_track',
      'approaching',
      'due_today',
      'overdue',
      'critically_overdue',
      'no_due_date',
    ]).toContain(result);
  });
});

// ─── counterSignatureUrgencyLabel ───────────────────────────────────────

describe('counterSignatureUrgencyLabel', () => {
  it('returns a non-empty label for every urgency value', () => {
    const allUrgencies: CounterSignatureUrgency[] = [
      'on_track',
      'approaching',
      'due_today',
      'overdue',
      'critically_overdue',
      'no_due_date',
    ];
    for (const u of allUrgencies) {
      const label = counterSignatureUrgencyLabel(u);
      expect(label).toBeTypeOf('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('returns the spec-defined labels exactly', () => {
    expect(counterSignatureUrgencyLabel('on_track')).toBe('On Track');
    expect(counterSignatureUrgencyLabel('approaching')).toBe('Approaching Due Date');
    expect(counterSignatureUrgencyLabel('due_today')).toBe('Due Today');
    expect(counterSignatureUrgencyLabel('overdue')).toBe('Overdue');
    expect(counterSignatureUrgencyLabel('critically_overdue')).toBe('Critically Overdue');
    expect(counterSignatureUrgencyLabel('no_due_date')).toBe('No Due Date Set');
  });
});
