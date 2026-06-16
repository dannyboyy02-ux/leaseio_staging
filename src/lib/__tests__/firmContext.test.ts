import { describe, it, expect } from 'vitest';
import {
  resolveActiveFirm,
  computeActionUrgency,
  computeFirmSidebarMode,
  URGENCY_AGING_DAYS,
  URGENCY_OVERDUE_DAYS,
  type FirmMembership,
} from '../firmContext';

// Phase 10 firm-context nav helpers. Pure UI logic (no Deno mirror — the shared
// authority helper lives in firmAccess.ts).

const firm = (id: string, name: string, role: FirmMembership['role']): FirmMembership => ({
  firm_id: id,
  firm_name: name,
  role,
});

describe('resolveActiveFirm', () => {
  it('returns null when the user has no firm memberships', () => {
    expect(resolveActiveFirm([], 'firm-1')).toBeNull();
    expect(resolveActiveFirm([], null)).toBeNull();
  });

  it('prefers the persisted firm when still a member', () => {
    const m = [firm('a', 'Alpha', 'firm_member'), firm('b', 'Bravo', 'owner')];
    expect(resolveActiveFirm(m, 'b')?.firm_id).toBe('b');
  });

  it('falls back to the first membership when the persisted firm is gone', () => {
    const m = [firm('a', 'Alpha', 'firm_admin'), firm('b', 'Bravo', 'firm_member')];
    expect(resolveActiveFirm(m, 'stale-firm')?.firm_id).toBe('a');
  });

  it('falls back to the first membership when nothing is persisted', () => {
    const m = [firm('a', 'Alpha', 'firm_admin')];
    expect(resolveActiveFirm(m, null)?.firm_id).toBe('a');
  });
});

describe('computeActionUrgency', () => {
  const now = Date.parse('2026-06-15T00:00:00Z');
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

  it('fresh when null / unparseable pending_since', () => {
    expect(computeActionUrgency(null, now)).toBe('fresh');
    expect(computeActionUrgency('not-a-date', now)).toBe('fresh');
  });

  it('fresh under the aging threshold', () => {
    expect(computeActionUrgency(daysAgo(0), now)).toBe('fresh');
    expect(computeActionUrgency(daysAgo(URGENCY_AGING_DAYS - 0.1), now)).toBe('fresh');
  });

  it('aging between the aging and overdue thresholds', () => {
    expect(computeActionUrgency(daysAgo(URGENCY_AGING_DAYS), now)).toBe('aging');
    expect(computeActionUrgency(daysAgo(URGENCY_OVERDUE_DAYS - 0.1), now)).toBe('aging');
  });

  it('overdue at or past the overdue threshold', () => {
    expect(computeActionUrgency(daysAgo(URGENCY_OVERDUE_DAYS), now)).toBe('overdue');
    expect(computeActionUrgency(daysAgo(30), now)).toBe('overdue');
  });
});

describe('computeFirmSidebarMode', () => {
  it('workspace mode for a user with no firm membership (even on a firm route)', () => {
    expect(computeFirmSidebarMode({ hasFirmMembership: false, onFirmRoute: true })).toBe('workspace');
  });

  it('firm mode for a firm member on a firm route', () => {
    expect(computeFirmSidebarMode({ hasFirmMembership: true, onFirmRoute: true })).toBe('firm');
  });

  it('workspace mode for a firm member NOT on a firm route', () => {
    expect(computeFirmSidebarMode({ hasFirmMembership: true, onFirmRoute: false })).toBe('workspace');
  });
});
