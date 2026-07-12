import { describe, it, expect } from 'vitest';

// Mirror the pure helpers from `src/pages/settings/ChainDiagram.tsx`. The
// component file imports @dnd-kit + lucide-react + radix UI primitives, none
// of which are needed to exercise the data transforms — keeping the tests
// pure-data here avoids dragging the JSX runtime into vitest.
//
// Spec: docs/APPROVAL_POLICY_EDITOR_REDESIGN.md +
//       docs/APPROVAL_POLICY_EDITOR_VISUAL_CONTRACT.md (avatar color & initials).
//
// IF YOU CHANGE A HELPER IN ChainDiagram.tsx, MIRROR IT HERE.
//
// i18n note (2026-07-12): the component helpers now emit their fixed phrases
// ("Anyone with role", "Backup: …", "Optional", the role labels — source uses
// labelKey → policy_editor.chain.*) through i18next. This mirror deliberately
// keeps the literal ENGLISH strings — it pins the en output; the data
// transforms under test are unchanged.

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

interface MemberOption {
  id: string;
  label: string;
}

const FUNCTIONAL_ROLE_OPTIONS = [
  { value: 'submitter', label: 'Submitter', abbrev: 'SU' },
  { value: 'manager_approver', label: 'Manager approver', abbrev: 'MA' },
  { value: 'financial_approver', label: 'Financial approver', abbrev: 'FA' },
  { value: 'signator', label: 'Signatory', abbrev: 'SG' },
  { value: 'admin', label: 'Admin', abbrev: 'AD' },
];

function step(overrides: Partial<ChainStep>): ChainStep {
  return {
    uiId: 'uiId' in overrides ? (overrides.uiId as string) : 's-test',
    step_order: 'step_order' in overrides ? (overrides.step_order as number) : 1,
    parallel_group:
      'parallel_group' in overrides ? (overrides.parallel_group as number) : 1,
    approver_user_id:
      'approver_user_id' in overrides
        ? (overrides.approver_user_id as string | null)
        : null,
    // Default is now `null` to match the post-visual-contract blankStep
    // (empty slot is the seeded shape). Tests that need a role explicitly
    // pass approver_role: 'manager_approver'.
    approver_role:
      'approver_role' in overrides ? (overrides.approver_role as string | null) : null,
    delegate_user_id:
      'delegate_user_id' in overrides
        ? (overrides.delegate_user_id as string | null)
        : null,
    delegate_after_days:
      'delegate_after_days' in overrides
        ? (overrides.delegate_after_days as number | null)
        : null,
    is_required:
      'is_required' in overrides ? (overrides.is_required as boolean) : true,
  };
}

// ────── helpers under test (mirrors of ChainDiagram.tsx) ──────

function blankStep(stepOrder: number, parallelGroup: number): ChainStep {
  return {
    uiId: 's-test-blank',
    step_order: stepOrder,
    parallel_group: parallelGroup,
    approver_user_id: null,
    approver_role: null,
    delegate_user_id: null,
    delegate_after_days: null,
    is_required: true,
  };
}

function seedSingleEmptyStep(): ChainStep[] {
  return [blankStep(1, 1)];
}

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

function avatarColorIndex(identifier: string): number {
  let hash = 5381;
  for (let i = 0; i < identifier.length; i++) {
    hash = (hash << 5) + hash + identifier.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash % 6;
}

function personInitials(label: string): string {
  const noTail = label.replace(/\s*\([^)]+\)\s*$/, '');
  const parts = noTail.trim().match(/^([A-Za-z])\w*\s+([A-Za-z])\w*/);
  if (parts) return (parts[1] + parts[2]).toUpperCase();
  const cleaned = noTail.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(0, 2).toUpperCase() || '??';
}

interface ApproverDisplay {
  initials: string;
  colorIndex: number;
  primary: string;
  secondary: string;
  empty: boolean;
}

function approverDisplayFor(
  s: ChainStep,
  members: MemberOption[],
): ApproverDisplay {
  if (s.approver_role) {
    const role = FUNCTIONAL_ROLE_OPTIONS.find((r) => r.value === s.approver_role);
    return {
      initials: role?.abbrev ?? s.approver_role.slice(0, 2).toUpperCase(),
      colorIndex: avatarColorIndex(`role:${s.approver_role}`),
      primary: 'Anyone with role',
      secondary: role?.label ?? s.approver_role,
      empty: false,
    };
  }
  if (s.approver_user_id) {
    const m = members.find((mm) => mm.id === s.approver_user_id);
    const fullLabel = m?.label ?? 'Unknown person';
    const noTail = fullLabel.replace(/\s*\([^)]+\)\s*$/, '');
    const tail = fullLabel.match(/\(([^)]+)\)\s*$/)?.[1] ?? '';
    return {
      initials: personInitials(fullLabel),
      colorIndex: avatarColorIndex(`user:${s.approver_user_id}`),
      primary: noTail || fullLabel,
      secondary: tail,
      empty: false,
    };
  }
  return {
    initials: '?',
    colorIndex: 0,
    primary: '',
    secondary: '',
    empty: true,
  };
}

function formatSecondaryLine(
  s: ChainStep,
  members: MemberOption[],
  baseSecondary: string,
): string {
  const parts: string[] = [];
  if (baseSecondary) parts.push(baseSecondary);
  if (s.delegate_user_id) {
    const backup = members.find((m) => m.id === s.delegate_user_id);
    const backupName =
      backup?.label.replace(/\s*\([^)]+\)\s*$/, '') ?? 'Unknown';
    const days = s.delegate_after_days ? ` +${s.delegate_after_days}d` : '';
    parts.push(`Backup: ${backupName}${days}`);
  }
  if (!s.is_required) parts.push('Optional');
  return parts.join(' · ');
}

// ─────────────────────────── tests ───────────────────────────

describe('blankStep / seedSingleEmptyStep', () => {
  it('blankStep produces an empty slot — both approver fields null', () => {
    const s = blankStep(1, 1);
    expect(s.approver_role).toBeNull();
    expect(s.approver_user_id).toBeNull();
    expect(s.is_required).toBe(true);
    expect(s.step_order).toBe(1);
    expect(s.parallel_group).toBe(1);
  });
  it('seedSingleEmptyStep returns one blank step', () => {
    const steps = seedSingleEmptyStep();
    expect(steps).toHaveLength(1);
    expect(steps[0].approver_role).toBeNull();
    expect(steps[0].approver_user_id).toBeNull();
  });
});

describe('groupByParallel', () => {
  it('returns empty for empty input', () => {
    expect(groupByParallel([])).toEqual([]);
  });
  it('groups by parallel_group and orders by first step_order', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 5 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 1 });
    const c = step({ uiId: 'c', step_order: 3, parallel_group: 5 });
    const groups = groupByParallel([a, b, c]);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((s) => s.uiId).sort()).toEqual(['a', 'c']);
    expect(groups[1].map((s) => s.uiId)).toEqual(['b']);
  });
  it('sorts within a group by step_order', () => {
    const a = step({ uiId: 'a', step_order: 3, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 1, parallel_group: 1 });
    const groups = groupByParallel([a, b]);
    expect(groups[0].map((s) => s.uiId)).toEqual(['b', 'a']);
  });
});

describe('reorderGroups / removeStep / updateStep', () => {
  it('reorderGroups rewrites step_order and preserves parallel_group', () => {
    const a = step({ uiId: 'a', step_order: 1, parallel_group: 1 });
    const b = step({ uiId: 'b', step_order: 2, parallel_group: 2 });
    const out = reorderGroups([a, b], 0, 1);
    expect(out.find((s) => s.uiId === 'a')!.step_order).toBe(2);
    expect(out.find((s) => s.uiId === 'b')!.step_order).toBe(1);
    expect(out.find((s) => s.uiId === 'a')!.parallel_group).toBe(1);
    expect(out.find((s) => s.uiId === 'b')!.parallel_group).toBe(2);
  });
  it('removeStep filters by uiId', () => {
    expect(
      removeStep([step({ uiId: 'a' }), step({ uiId: 'b' })], 'a').map(
        (s) => s.uiId,
      ),
    ).toEqual(['b']);
  });
  it('updateStep patches only the matching step', () => {
    const a = step({ uiId: 'a', is_required: true });
    const b = step({ uiId: 'b', is_required: true });
    const out = updateStep([a, b], 'a', { is_required: false });
    expect(out.find((s) => s.uiId === 'a')!.is_required).toBe(false);
    expect(out.find((s) => s.uiId === 'b')!.is_required).toBe(true);
  });
});

describe('avatarColorIndex', () => {
  it('returns a value 0..5 for any input', () => {
    for (const id of ['user:abc', 'role:manager_approver', '', 'x']) {
      const i = avatarColorIndex(id);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(6);
    }
  });
  it('is deterministic — same id → same color', () => {
    expect(avatarColorIndex('role:manager_approver')).toBe(
      avatarColorIndex('role:manager_approver'),
    );
    expect(avatarColorIndex('user:abc-123')).toBe(avatarColorIndex('user:abc-123'));
  });
  it('different ids generally produce different colors (best effort)', () => {
    // Not a strong claim — just guards against the "always returns 0" bug.
    const indices = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => avatarColorIndex(s)),
    );
    expect(indices.size).toBeGreaterThan(1);
  });
});

describe('personInitials', () => {
  it('takes first letter of first + last from "First Last"', () => {
    expect(personInitials('Sara Kim')).toBe('SK');
  });
  it('strips trailing "(email)" before computing initials', () => {
    expect(personInitials('Sara Kim (sara@example.com)')).toBe('SK');
  });
  it('handles a single-word name by falling back to first 2 chars', () => {
    expect(personInitials('Madonna')).toBe('MA');
  });
  it('falls back to alphanumerics when the name has unusual chars', () => {
    expect(personInitials('!@# 42xy')).toBe('42');
  });
  it('returns "??" for an unparseable label', () => {
    expect(personInitials('!@#$%')).toBe('??');
  });
});

describe('approverDisplayFor', () => {
  const members: MemberOption[] = [
    { id: 'u1', label: 'Sara Kim (sara@example.com)' },
    { id: 'u2', label: 'Bob' },
  ];

  it('flags an empty slot with empty=true', () => {
    expect(approverDisplayFor(step({}), members).empty).toBe(true);
  });
  it('returns role abbrev + "Anyone with role" primary line', () => {
    const d = approverDisplayFor(
      step({ approver_role: 'financial_approver' }),
      members,
    );
    expect(d.empty).toBe(false);
    expect(d.initials).toBe('FA');
    expect(d.primary).toBe('Anyone with role');
    expect(d.secondary).toBe('Financial approver');
  });
  it('falls back to first-2 chars when role is unknown', () => {
    const d = approverDisplayFor(step({ approver_role: 'unknown' }), members);
    expect(d.initials).toBe('UN');
    expect(d.secondary).toBe('unknown');
  });
  it('returns user initials + display name without "(email)" tail', () => {
    const d = approverDisplayFor(step({ approver_user_id: 'u1' }), members);
    expect(d.empty).toBe(false);
    expect(d.initials).toBe('SK');
    expect(d.primary).toBe('Sara Kim');
    expect(d.secondary).toBe('sara@example.com');
  });
  it('uses "Unknown person" when user_id is missing from members', () => {
    const d = approverDisplayFor(step({ approver_user_id: 'missing' }), members);
    expect(d.primary).toBe('Unknown person');
  });
});

describe('formatSecondaryLine', () => {
  const members: MemberOption[] = [
    { id: 'd1', label: 'David Chen (david@x.com)' },
  ];

  it('returns the base secondary alone when no backup, required', () => {
    expect(formatSecondaryLine(step({}), members, 'Department Head')).toBe(
      'Department Head',
    );
  });
  it('appends backup name and days when delegate is set', () => {
    expect(
      formatSecondaryLine(
        step({ delegate_user_id: 'd1', delegate_after_days: 3 }),
        members,
        'CFO',
      ),
    ).toBe('CFO · Backup: David Chen +3d');
  });
  it('appends "Optional" when is_required is false', () => {
    expect(
      formatSecondaryLine(step({ is_required: false }), members, 'Submitter'),
    ).toBe('Submitter · Optional');
  });
  it('combines backup and optional into one line', () => {
    expect(
      formatSecondaryLine(
        step({
          delegate_user_id: 'd1',
          delegate_after_days: 5,
          is_required: false,
        }),
        members,
        'Manager',
      ),
    ).toBe('Manager · Backup: David Chen +5d · Optional');
  });
  it('omits the backup days when delegate_after_days is null', () => {
    expect(
      formatSecondaryLine(
        step({ delegate_user_id: 'd1', delegate_after_days: null }),
        members,
        'CFO',
      ),
    ).toBe('CFO · Backup: David Chen');
  });
});
