// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18n from 'i18next';
import enCommon from '../../../locales/en/common.json';

// ─────────────────────────────────────────────────────────────────────────
// The "Everything else" row is the permanent catch-all the redesign added, and
// its own header calls out the failure it exists to prevent:
//
//   "Telling an admin 'blocked' in the state that actually auto-approves would
//    be the single worst copy error on this page."
//
// That distinction is a pure function of ONE prop (`hasAnyRules`) and it had no
// test. It is also security-relevant, because the two states are opposites:
//
//   no rules AND no default approvers   → resolve-approval-chain takes the
//       legacy branch, getApprovalRequirements returns both-false, and
//       getInitialStatusAfterSubmission returns 'approved'. THE GATE IS OPEN.
//   rules exist, none match, no defaults→ resolve-approval-chain 409s
//       `no_match_no_fallback`. THE REQUEST IS TURNED AWAY.
//
// Also pinned here: the zero-holder caution (a role held only by ex-members is
// "nobody", not falsely reassuring), the partial-coverage warning, and the
// never-render-a-UUID guarantee at the component boundary rather than only at
// the describeApprover boundary.
//
// i18n strategy: describeApprover renders through the i18next SINGLETON, so the
// real English bundle is initialized and the human prose is asserted verbatim.
// The row's own copy goes through useAppTranslation, which is mocked to echo
// keys — so a copy rewrite doesn't break the test but a WRONG-STATE copy swap
// does (the repo convention, see PlanPickerDialog.test.tsx).
// ─────────────────────────────────────────────────────────────────────────

vi.mock('@/hooks/useAppTranslation', () => ({
  useAppTranslation: () => ({
    // Echo the KEY (and interpolated params), deliberately ignoring
    // `defaultValue`: every key this row uses is present in both locale files
    // today, so real i18next renders the translation and never the default.
    // Asserting on keys keeps a copy rewrite from breaking the test while a
    // WRONG-STATE key swap still fails it.
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object') {
        const { defaultValue: _ignored, ...rest } = opts as { defaultValue?: unknown };
        const params = Object.entries(rest)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',');
        if (params) return `${key}(${params})`;
      }
      return key;
    },
    language: 'en' as const,
    lang: 'en' as const,
  }),
}));

import { ApprovalEverythingElseRow } from '../ApprovalEverythingElseRow';
import { buildRoleHolderMap, type MemberLike } from '@/lib/approvalDescribe';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init({
      lng: 'en',
      resources: { en: { translation: enCommon } },
      interpolation: { escapeValue: false },
    });
  }
});

afterEach(cleanup);

const DANA = '3f8a2b1c-4d5e-4f6a-8b9c-0d1e2f3a4b5c';
const PRIYA = '7a1b2c3d-4e5f-4061-8273-849506172839';
const GHOST = '11111111-2222-4333-8444-555555555555';

const MEMBERS: MemberLike[] = [
  { id: DANA, label: 'Dana Reyes (dana@acme.com)' },
  { id: PRIYA, label: 'Priya Shah (priya@acme.com)' },
];

const holders = (map: Record<string, string[]>) =>
  buildRoleHolderMap(
    Object.entries(map).flatMap(([role, ids]) => ids.map((user_id) => ({ role, user_id }))),
  );

const BOTH = holders({ manager_approver: [DANA], financial_approver: [PRIYA] });
const NONE = holders({});

function renderRow(props: Partial<React.ComponentProps<typeof ApprovalEverythingElseRow>> = {}) {
  return render(
    <ApprovalEverythingElseRow
      members={MEMBERS}
      roleHolders={NONE}
      hasAnyRules={false}
      onPickApprovers={() => {}}
      {...props}
    />,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// THE TWO TRUTHS. Different engine outcome ⇒ different sentence, always.
// ─────────────────────────────────────────────────────────────────────────

describe('ApprovalEverythingElseRow — nobody assigned', () => {
  it('NO RULES + no approvers says the gate is OPEN, never "blocked"', () => {
    renderRow({ roleHolders: NONE, hasAnyRules: false });

    // The auto-approve vocabulary…
    expect(screen.getByText('policy_editor.list.everything_else_auto')).toBeTruthy();
    // …and NOT the blocked vocabulary.
    expect(screen.queryByText('policy_editor.list.defaults_missing_warning')).toBeNull();
    expect(screen.queryByText('policy_editor.list.no_defaults_warning_title')).toBeNull();
  });

  it('RULES EXIST + no approvers says the request is turned away', () => {
    renderRow({ roleHolders: NONE, hasAnyRules: true });

    expect(screen.getByText('policy_editor.list.defaults_missing_warning')).toBeTruthy();
    expect(screen.getByText('policy_editor.list.no_defaults_warning_title')).toBeTruthy();
    expect(screen.queryByText('policy_editor.list.everything_else_auto')).toBeNull();
  });

  it('the two states never share a body string', () => {
    const { unmount } = renderRow({ hasAnyRules: false });
    const open = document.body.textContent ?? '';
    unmount();
    renderRow({ hasAnyRules: true });
    const shut = document.body.textContent ?? '';
    expect(open).not.toBe(shut);
  });

  it('always offers a way out of the destructive state', () => {
    const onPick = vi.fn();
    renderRow({ hasAnyRules: true, onPickApprovers: onPick });
    expect(screen.getByText('policy_editor.list.defaults_missing_cta')).toBeTruthy();
  });

  it('a role held ONLY by an ex-member counts as nobody, not as covered', () => {
    // GHOST is not in MEMBERS — an approver who has left. The row must not
    // report the safety net as assigned.
    renderRow({
      roleHolders: holders({ manager_approver: [GHOST], financial_approver: [GHOST] }),
      hasAnyRules: true,
    });
    expect(screen.getByText('policy_editor.list.defaults_missing_warning')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Covered + partially covered
// ─────────────────────────────────────────────────────────────────────────

describe('ApprovalEverythingElseRow — approvers assigned', () => {
  it('names the humans in both slots and drops the destructive panel', () => {
    renderRow({ roleHolders: BOTH, hasAnyRules: true });

    expect(screen.getByText(/policy_editor\.list\.everything_else_manager\(name=Dana Reyes\)/)).toBeTruthy();
    expect(screen.getByText(/policy_editor\.list\.everything_else_financial\(name=Priya Shah\)/)).toBeTruthy();
    expect(screen.queryByText('policy_editor.list.defaults_missing_warning')).toBeNull();
    expect(screen.queryByText('policy_editor.list.everything_else_auto')).toBeNull();
  });

  it('a MISSING financial approver is a stated routing gap, not a silent one', () => {
    renderRow({ roleHolders: holders({ manager_approver: [DANA] }), hasAnyRules: true });

    expect(screen.getByText('policy_editor.list.defaults_no_financial_warning')).toBeTruthy();
    expect(
      screen.getByText(/policy_editor\.list\.everything_else_financial\(name=policy_editor\.list\.everything_else_slot_unassigned\)/),
    ).toBeTruthy();
  });

  it('the threshold note is suppressed while no financial approver can act on it', () => {
    renderRow({
      roleHolders: holders({ manager_approver: [DANA] }),
      approvalThreshold: 50_000,
      hasAnyRules: true,
    });
    expect(screen.queryByText(/workflow\.request\.review_threshold/)).toBeNull();
  });

  it('shows the threshold once a financial approver exists', () => {
    renderRow({ roleHolders: BOTH, approvalThreshold: 50_000, hasAnyRules: true });
    expect(screen.getByText(/workflow\.request\.review_threshold\(amount=/)).toBeTruthy();
  });

  it('shows the covenant note only alongside a financial approver', () => {
    const { unmount } = renderRow({
      roleHolders: holders({ manager_approver: [DANA] }),
      covenantThreshold: 1,
      hasAnyRules: true,
    });
    expect(screen.queryByText('workflow.request.review_covenant')).toBeNull();
    unmount();

    renderRow({ roleHolders: BOTH, covenantThreshold: 1, hasAnyRules: true });
    expect(screen.getByText('workflow.request.review_covenant')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Invariants that hold in EVERY state
// ─────────────────────────────────────────────────────────────────────────

describe('ApprovalEverythingElseRow — invariants', () => {
  const STATES: Array<Parameters<typeof renderRow>[0]> = [
    { roleHolders: NONE, hasAnyRules: false },
    { roleHolders: NONE, hasAnyRules: true },
    { roleHolders: BOTH, hasAnyRules: true },
    { roleHolders: holders({ manager_approver: [DANA] }), hasAnyRules: true },
    { roleHolders: holders({ manager_approver: [GHOST] }), hasAnyRules: true },
    { roleHolders: holders({ manager_approver: [DANA, PRIYA, GHOST] }), hasAnyRules: true },
  ];

  it.each(STATES.map((s, i) => [i, s] as const))(
    'state %i renders no raw or truncated UUID',
    (_i, state) => {
      renderRow(state);
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(text).not.toContain(DANA.slice(0, 8));
      expect(text).not.toContain(GHOST.slice(0, 8));
    },
  );

  it.each(STATES.map((s, i) => [i, s] as const))(
    'state %i always states that this path has no signing step',
    (_i, state) => {
      renderRow(state);
      expect(screen.getByText('policy_editor.list.everything_else_no_signing')).toBeTruthy();
    },
  );

  it.each(STATES.map((s, i) => [i, s] as const))(
    'state %i always says the row is last, in words and not by position alone',
    (_i, state) => {
      renderRow(state);
      expect(screen.getByText('policy_editor.list.everything_else_label')).toBeTruthy();
      expect(screen.getByText('policy_editor.list.everything_else_always_last')).toBeTruthy();
    },
  );

  it('never clamps the approver line (a truncated approver is a lie here)', () => {
    renderRow({
      roleHolders: holders({ manager_approver: [DANA, PRIYA], financial_approver: [PRIYA] }),
      hasAnyRules: true,
    });
    for (const el of Array.from(document.querySelectorAll('p, span'))) {
      expect(el.className).not.toMatch(/\btruncate\b|\bline-clamp-/);
    }
  });

  it('a many-holder role keeps the FULL list reachable in the title attribute', () => {
    renderRow({
      roleHolders: holders({ manager_approver: [DANA, PRIYA] }),
      hasAnyRules: true,
    });
    const titled = Array.from(document.querySelectorAll('[title]')).map((e) =>
      e.getAttribute('title'),
    );
    expect(titled.some((v) => v?.includes('Dana Reyes') && v?.includes('Priya Shah'))).toBe(true);
  });
});
