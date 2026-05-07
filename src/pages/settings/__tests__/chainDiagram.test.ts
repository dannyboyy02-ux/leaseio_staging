import { describe, it, expect } from 'vitest';

// Mirror the pure helpers from `src/pages/settings/ChainDiagram.tsx`. The
// component file imports @dnd-kit + lucide-react + radix UI primitives, none
// of which are needed to exercise the data transforms — keeping the tests
// pure-data here avoids dragging the JSX runtime into vitest.
//
// Spec: docs/APPROVAL_POLICY_EDITOR_REDESIGN.md (P1.3 — visual chain editor).
//
// IF YOU CHANGE A HELPER IN ChainDiagram.tsx, MIRROR IT HERE.

interface ChainStep {
  uiId: string;
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  delegate_user_id: string | null;
  delegate_after_days: number | null;
  is_required: boolean;
}

const FUNCTIONAL_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'submitter', label: 'Submitter' },
  { value: 'manager_approver', label: 'Manager approver' },
  { value: 'financial_approver', label: 'Financial approver' },
  { value: 'signator', label: 'Signator' },
  { value: 'admin', label: 'Admin' },
];

function step(overrides: Partial<ChainStep>): ChainStep {
  // Use `in` checks so explicit null values from the override aren't
  // re-defaulted by the ?? operator.
  return {
    uiId: 'uiId' in overrides ? overrides.uiId! : 's-test',
    step_order: 'step_order' in overrides ? overrides.step_order! : 1,
    parallel_group: 'parallel_group' in overrides ? overrides.parallel_group! : 1,
    approver_user_id:
      'approver_user_id' in overrides ? overrides.approver_user_id! : null,
    approver_role:
      'approver_role' in overrides ? overrides.approver_role! : 'manager_approver',
    delegate_user_id:
      'delegate_user_id' in overrides ? overrides.delegate_user_id! : null,
    delegate_after_days:
      'delegate_after_days' in overrides ? overrides.delegate_after_days! : null,
    is_required: 'is_required' in overrides ? overrides.is_required! : true,
  };
}

// ────── helpers under test (mirrors of ChainDiagram.tsx) ──────

function groupByParallel(steps: ChainStep[]): ChainStep[][] {
  const buckets = new Map<number, ChainStep[]>();
  for (const s of steps) {
    if (!buckets.has(s.parallel_group)) buckets.set(s.parallel_group, []);
    buckets.get(s.parallel_group)!.push(s);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => a.step_order - b.step_order);
  }
  return Array.from(buckets.values()).sort(
    (a, b) => a[0].step_order - b[0].step_order,
  );
}

function addNextStep(steps: ChainStep[]): ChainStep[] {
  const maxOrder = steps.reduce((m, s) => Math.max(m, s.step_order), 0);
  const maxGroup = steps.reduce((m, s) => Math.max(m, s.parallel_group), 0);
  return [
    ...steps,
    {
      uiId: 's-new',
      step_order: maxOrder + 1,
      parallel_group: maxGroup + 1,
      approver_user_id: null,
      approver_role: 'manager_approver',
      delegate_user_id: null,
      delegate_after_days: null,
      is_required: true,
    },
  ];
}

function addParallelApprover(
  steps: ChainStep[],
  parallelGroup: number,
): ChainStep[] {
  const maxOrder = steps.reduce((m, s) => Math.max(m, s.step_order), 0);
  return [
    ...steps,
    {
      uiId: 's-new-parallel',
      step_order: maxOrder + 1,
      parallel_group: parallelGroup,
      approver_user_id: null,
      approver_role: 'manager_approver',
      delegate_user_id: null,
      delegate_after_days: null,
      is_required: true,
    },
  ];
}

function arrayMove<T>(arr: T[], from: number, to: number): T[] {
  const out = arr.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

function reorderGroups(
  steps: ChainStep[],
  fromIndex: number,
  toIndex: number,
): ChainStep[] {
  const groups = groupByParallel(steps);
  const reordered = arrayMove(groups, fromIndex, toIndex);
  let nextOrder = 1;
  const out: ChainStep[] = [];
  for (const group of reordered) {
    for (const s of group) {
      out.push({ ...s, step_order: nextOrder++ });
    }
  }
  return out;
}

function removeStep(steps: ChainStep[], uiId: string): ChainStep[] {
  return steps.filter((s) => s.uiId !== uiId);
}

function updateStep(
  steps: ChainStep[],
  uiId: string,
  patch: Partial<ChainStep>,
): ChainStep[] {
  return steps.map((s) => (s.uiId === uiId ? { ...s, ...patch } : s));
}

interface MemberOption {
  id: string;
  label: string;
}

function approverDisplayLabel(s: ChainStep, memberOptions: MemberOption[]): string {
  if (s.approver_role) {
    return (
      FUNCTIONAL_ROLE_OPTIONS.find((r) => r.value === s.approver_role)?.label ??
      s.approver_role
    );
  }
  if (s.approver_user_id) {
    return (
      memberOptions.find((m) => m.id === s.approver_user_id)?.label ??
      'Unknown person'
    );
  }
  return 'Pick an approver…';
}

function backupDisplayLabel(s: ChainStep, memberOptions: MemberOption[]): string {
  if (s.delegate_user_id) {
    return (
      memberOptions.find((m) => m.id === s.delegate_user_id)?.label ??
      'Unknown person'
    );
  }
  return 'No backup';
}

// ─────────────────────────── tests ───────────────────────────

describe('groupByParallel', () => {
  it('returns empty for empty input', () => {
    expect(groupByParallel([])).toEqual([]);
  });
  it('puts each step in its own group when parallel_groups are unique', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 2 });
    const groups = groupByParallel([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((s) => s.uiId)).toEqual(['a']);
    expect(groups[1].map((s) => s.uiId)).toEqual(['b']);
  });
  it('groups same parallel_group steps together', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 1 });
    const c = step({ uiId: 'c', step_order: 3, parallel_group: 2 });
    const groups = groupByParallel([a, b, c]);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((s) => s.uiId).sort()).toEqual(['a', 'b']);
    expect(groups[1].map((s) => s.uiId)).toEqual(['c']);
  });
  it('orders groups by their first step_order', () => {
    // group 5 has step_order 1, group 1 has step_order 2 — group 5 wins.
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 5 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 1 });
    const groups = groupByParallel([a, b]);
    expect(groups[0][0].parallel_group).toBe(5);
    expect(groups[1][0].parallel_group).toBe(1);
  });
  it('sorts within a group by step_order', () => {
    const a = step({ uiId: 'a', step_order: 3, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 1, parallel_group: 1 });
    const c = step({ uiId: 'c', step_order: 2, parallel_group: 1 });
    const groups = groupByParallel([a, b, c]);
    expect(groups[0].map((s) => s.uiId)).toEqual(['b', 'c', 'a']);
  });
});

describe('addNextStep', () => {
  it('seeds an empty chain with order 1, group 1', () => {
    const out = addNextStep([]);
    expect(out).toHaveLength(1);
    expect(out[0].step_order).toBe(1);
    expect(out[0].parallel_group).toBe(1);
  });
  it('appends with max+1 order and max+1 group', () => {
    const a = step({ uiId: 'a', step_order: 5, parallel_group: 3 });
    const out = addNextStep([a]);
    expect(out).toHaveLength(2);
    expect(out[1].step_order).toBe(6);
    expect(out[1].parallel_group).toBe(4);
  });
  it('does not mutate the input', () => {
    const input = [step({ uiId: 'a' })];
    const before = JSON.stringify(input);
    addNextStep(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('addParallelApprover', () => {
  it('uses the existing parallel_group, not max+1', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 7 });
    const out = addParallelApprover([a], 7);
    expect(out).toHaveLength(2);
    expect(out[1].parallel_group).toBe(7);
  });
  it('still gets max+1 step_order so it sorts after siblings', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 1 });
    const out = addParallelApprover([a, b], 1);
    expect(out[2].step_order).toBe(3);
  });
});

describe('reorderGroups', () => {
  it('moves group from index 0 to index 1 and rewrites step_order', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 2 });
    const out = reorderGroups([a, b], 0, 1);
    expect(out.find((s) => s.uiId === 'a')!.step_order).toBe(2);
    expect(out.find((s) => s.uiId === 'b')!.step_order).toBe(1);
  });
  it('preserves parallel_group on each step', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 2 });
    const out = reorderGroups([a, b], 0, 1);
    expect(out.find((s) => s.uiId === 'a')!.parallel_group).toBe(1);
    expect(out.find((s) => s.uiId === 'b')!.parallel_group).toBe(2);
  });
  it('keeps within-group order intact when the group itself moves', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 1 });
    const c = step({ uiId: 'c', step_order: 3, parallel_group: 2 });
    const out = reorderGroups([a, b, c], 0, 1);
    // group 2 (one step) is now first, group 1 (two steps in order a,b) is second.
    const orders = out.map((s) => ({ uiId: s.uiId, step_order: s.step_order }));
    expect(orders.find((o) => o.uiId === 'c')!.step_order).toBe(1);
    expect(orders.find((o) => o.uiId === 'a')!.step_order).toBe(2);
    expect(orders.find((o) => o.uiId === 'b')!.step_order).toBe(3);
  });
});

describe('removeStep / updateStep', () => {
  it('removeStep filters out the matching uiId', () => {
    const a = step({ uiId: 'a' });
    const b = step({ uiId: 'b' });
    expect(removeStep([a, b], 'a').map((s) => s.uiId)).toEqual(['b']);
  });
  it('removeStep is a no-op when uiId is missing', () => {
    const a = step({ uiId: 'a' });
    expect(removeStep([a], 'b').map((s) => s.uiId)).toEqual(['a']);
  });
  it('updateStep patches only the matching step', () => {
    const a = step({ uiId: 'a', is_required: true });
    const b = step({ uiId: 'b', is_required: true });
    const out = updateStep([a, b], 'a', { is_required: false });
    expect(out.find((s) => s.uiId === 'a')!.is_required).toBe(false);
    expect(out.find((s) => s.uiId === 'b')!.is_required).toBe(true);
  });
});

describe('approverDisplayLabel', () => {
  const members: MemberOption[] = [
    { id: 'u1', label: 'Alice (a@example.com)' },
    { id: 'u2', label: 'Bob (b@example.com)' },
  ];

  it('shows the friendly role label when approver_role is set', () => {
    expect(
      approverDisplayLabel(
        step({ approver_role: 'manager_approver', approver_user_id: null }),
        members,
      ),
    ).toBe('Manager approver');
  });
  it('falls back to the raw role value if not in the option list', () => {
    expect(
      approverDisplayLabel(
        step({ approver_role: 'unknown_role', approver_user_id: null }),
        members,
      ),
    ).toBe('unknown_role');
  });
  it('shows the member label when approver_user_id is set', () => {
    expect(
      approverDisplayLabel(
        step({ approver_role: null, approver_user_id: 'u2' }),
        members,
      ),
    ).toBe('Bob (b@example.com)');
  });
  it('shows "Unknown person" when the user_id is not in members', () => {
    expect(
      approverDisplayLabel(
        step({ approver_role: null, approver_user_id: 'u-missing' }),
        members,
      ),
    ).toBe('Unknown person');
  });
  it('shows the placeholder when neither role nor user is set', () => {
    expect(
      approverDisplayLabel(
        step({ approver_role: null, approver_user_id: null }),
        members,
      ),
    ).toBe('Pick an approver…');
  });
});

describe('backupDisplayLabel', () => {
  const members: MemberOption[] = [
    { id: 'u1', label: 'Alice (a@example.com)' },
  ];
  it('shows the member label when delegate_user_id is set', () => {
    expect(
      backupDisplayLabel(step({ delegate_user_id: 'u1' }), members),
    ).toBe('Alice (a@example.com)');
  });
  it('shows "No backup" when delegate is null', () => {
    expect(backupDisplayLabel(step({ delegate_user_id: null }), members)).toBe(
      'No backup',
    );
  });
  it('shows "Unknown person" when the delegate_user_id is missing from members', () => {
    expect(
      backupDisplayLabel(step({ delegate_user_id: 'u-missing' }), members),
    ).toBe('Unknown person');
  });
});
