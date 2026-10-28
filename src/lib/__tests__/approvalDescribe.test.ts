import { describe, it, expect } from 'vitest';
import i18n from 'i18next';
import enCommon from '../../locales/en/common.json';
import {
  describeApprover,
  describeChain,
  describeNeverFires,
  describeOverlapStatus,
  describeRetiredCriteria,
  findShadowedRules,
  buildRoleHolderMap,
  approvalRoleLabel,
  approverPhrase,
  containsRawId,
  joinAnd,
  personName,
  resolvePersonName,
  retiredDimensions,
  ruleCovers,
  rulesCanCoMatch,
  usesRetiredCriteria,
  type DescribableRule,
  type DescribableStep,
  type MemberLike,
} from '@/lib/approvalDescribe';

// ─────────────────────────────────────────────────────────────────────────
// i18n bootstrap.
//
// approvalDescribe renders through the i18next singleton (the established
// non-component pattern — assetTypeLabels.ts, portfolioWatchlist.ts). The
// central locale batch for `policy_editor.describe.*` is applied by the
// orchestrator in a separate commit, so these tests seed the PROPOSED English
// copy inline and let the REAL locale file win wherever it already has a key.
// Once the batch lands, PROPOSED_DESCRIBE_EN becomes inert and the assertions
// automatically pin the shipped strings instead.
// ─────────────────────────────────────────────────────────────────────────

const PROPOSED_DESCRIBE_EN: Record<string, string> = {
  role_caption: 'the {{role}}',
  role_with_two: 'the {{role}} ({{a}} or {{b}})',
  role_with_three: 'the {{role}} ({{a}}, {{b}} or {{c}})',
  role_with_many: 'the {{role}} ({{a}}, {{b}} or {{others}} others)',
  role_unfilled: 'Nobody holds the {{role}} role, so a request like this stops here.',
  former_member: 'Former member',
  unknown_role: 'unrecognized',
  empty_step: 'No one chosen yet',
  delegate_after_days: '(or {{name}} after {{days}} days)',
  delegate_backup: '(or {{name}} as backup)',
  same_time: '{{names}} (at the same time)',
  optionally: 'optionally {{names}}',
  with_optional: '{{required}}, and {{optional}}',
  then_separator: ', then ',
  join_and_two: '{{a}} and {{b}}',
  join_and_many: '{{items}} and {{last}}',
  sentence_split: 'Approved by {{approvers}}, then signed by {{signers}}.',
  sentence_inherited: 'Approved and signed by {{approvers}}.',
  sentence_approve_only: 'Approved by {{approvers}}.',
  sentence_blocked: 'Nobody assigned — this rule would block the request.',
  stage2_inherited_note: 'No separate signer set, so the same people sign.',
  stage2_same_people: 'The same people sign: {{names}}.',
  no_overlap: "None of these rules overlap, so the order doesn't change anything today.",
  overlap_pair: '«{{a}}» and «{{b}}» can both fit the same request — the higher one wins.',
  shadowed_warning: 'Never used — «{{name}}» above already covers everything this rule covers.',
  impossible_range_warning:
    'The lowest amount in this rule is higher than the highest, so no request can match it.',
  retired_region_warning:
    "This rule only fits requests with a region, and lease requests don't ask for one — so it will never be used.",
  retired_lease_type_warning:
    "This rule only fits requests with a lease type, and lease requests don't ask for one — so it will never be used.",
  retired_both_warning:
    'This rule only fits requests with a region and a lease type, and lease requests ask for neither — so it will never be used.',
};

const en = JSON.parse(JSON.stringify(enCommon)) as any;
en.policy_editor = en.policy_editor ?? {};
en.policy_editor.describe = { ...PROPOSED_DESCRIBE_EN, ...(en.policy_editor.describe ?? {}) };

await i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common'],
  resources: { en: { common: en } },
  interpolation: { escapeValue: false },
});

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const DANA = '11111111-1111-4111-8111-111111111111';
const PRIYA = '22222222-2222-4222-8222-222222222222';
const ANA = '33333333-3333-4333-8333-333333333333';
const SAM = '44444444-4444-4444-8444-444444444444';
const ALEX = '55555555-5555-4555-8555-555555555555';
const GHOST = '99999999-9999-4999-8999-999999999999';

const MEMBERS: MemberLike[] = [
  { id: DANA, label: 'Dana Reyes (dana@acme.com)' },
  { id: PRIYA, label: 'Priya Shah (priya@acme.com)' },
  { id: ANA, label: 'Ana Ruiz (ana@acme.com)' },
  { id: SAM, label: 'Sam Patel (sam@acme.com)' },
  { id: ALEX, label: 'Alex Kim (alex@acme.com)' },
];

function step(over: Partial<DescribableStep> = {}): DescribableStep {
  return {
    stage: 'concept',
    step_order: 1,
    parallel_group: 1,
    approver_user_id: null,
    approver_role: null,
    delegate_user_id: null,
    delegate_after_days: null,
    is_required: true,
    ...over,
  };
}

const holders = (map: Record<string, string[]>) =>
  buildRoleHolderMap(
    Object.entries(map).flatMap(([role, ids]) => ids.map((user_id) => ({ role, user_id }))),
  );

/** The UUID shapes that must never reach a user. Covers the full form and
 *  the truncated `id.slice(0, 8)` vocabulary the old tester rendered. */
const ANY_UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{8}…/i;

// ─────────────────────────────────────────────────────────────────────────
// Name-resolution primitives
// ─────────────────────────────────────────────────────────────────────────

describe('personName / resolvePersonName / containsRawId', () => {
  it('strips the trailing email tail', () => {
    expect(personName('Dana Reyes (dana@acme.com)')).toBe('Dana Reyes');
  });

  it('keeps a bare email as the name', () => {
    expect(personName('dana@acme.com')).toBe('dana@acme.com');
  });

  it('keeps the label when stripping would leave nothing', () => {
    expect(personName('(dana@acme.com)')).toBe('(dana@acme.com)');
  });

  it('resolves a member id to a name', () => {
    expect(resolvePersonName(DANA, MEMBERS)).toBe('Dana Reyes');
  });

  it('returns null for a non-member and for null', () => {
    expect(resolvePersonName(GHOST, MEMBERS)).toBeNull();
    expect(resolvePersonName(null, MEMBERS)).toBeNull();
  });

  it('refuses a label that is really the id (formatApproverLabel id fallback)', () => {
    const poisoned: MemberLike[] = [{ id: DANA, label: DANA }];
    expect(resolvePersonName(DANA, poisoned)).toBeNull();
  });

  it('refuses a truncated-id label', () => {
    const poisoned: MemberLike[] = [{ id: DANA, label: `${DANA.slice(0, 8)}…` }];
    expect(resolvePersonName(DANA, poisoned)).toBeNull();
  });

  it('refuses a blank label', () => {
    expect(resolvePersonName(DANA, [{ id: DANA, label: '   ' }])).toBeNull();
  });

  it('containsRawId flags a full uuid anywhere in the string', () => {
    expect(containsRawId(`Dana ${PRIYA}`, DANA)).toBe(true);
    expect(containsRawId('Dana Reyes', DANA)).toBe(false);
    expect(containsRawId('', DANA)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (a) describeApprover
// ─────────────────────────────────────────────────────────────────────────

describe('describeApprover — named user', () => {
  it('names the person', () => {
    const d = describeApprover(step({ approver_user_id: DANA }), MEMBERS);
    expect(d.text).toBe('Dana Reyes');
    expect(d.kind).toBe('user');
    expect(d.tone).toBe('normal');
    expect(d.caption).toBe('');
    expect(d.blocksRouting).toBe(false);
    expect(d.people).toEqual([{ id: DANA, name: 'Dana Reyes' }]);
    expect(d.fullNames).toEqual(['Dana Reyes']);
  });

  it('a user who is no longer a member reads "Former member", never an id', () => {
    const d = describeApprover(step({ approver_user_id: GHOST }), MEMBERS);
    expect(d.text).toBe('Former member');
    expect(d.kind).toBe('former_member');
    expect(d.tone).toBe('caution');
    expect(d.blocksRouting).toBe(true);
    expect(d.text).not.toMatch(ANY_UUIDISH);
  });

  it('an empty slot is a caution, not a silent blank', () => {
    const d = describeApprover(step(), MEMBERS);
    expect(d.text).toBe('No one chosen yet');
    expect(d.kind).toBe('empty');
    expect(d.tone).toBe('caution');
    expect(d.blocksRouting).toBe(true);
  });
});

describe('describeApprover — role holders', () => {
  const roleStep = step({ approver_role: 'manager_approver' });

  it('ONE holder: the human leads, the role is the caption', () => {
    const d = describeApprover(roleStep, MEMBERS, holders({ manager_approver: [DANA] }));
    expect(d.text).toBe('Dana Reyes');
    expect(d.caption).toBe('the Manager approver');
    expect(d.kind).toBe('role');
    expect(d.tone).toBe('normal');
    expect(d.roleLabel).toBe('Manager approver');
  });

  it('TWO holders', () => {
    const d = describeApprover(roleStep, MEMBERS, holders({ manager_approver: [DANA, PRIYA] }));
    expect(d.text).toBe('the Manager approver (Dana Reyes or Priya Shah)');
    expect(d.fullNames).toEqual(['Dana Reyes', 'Priya Shah']);
  });

  it('THREE holders list all three rather than saying "or 1 other"', () => {
    const d = describeApprover(
      roleStep,
      MEMBERS,
      holders({ manager_approver: [DANA, PRIYA, ANA] }),
    );
    expect(d.text).toBe('the Manager approver (Dana Reyes, Priya Shah or Ana Ruiz)');
  });

  it('FOUR OR MORE holders use the bounded form, with the full list still available', () => {
    const d = describeApprover(
      roleStep,
      MEMBERS,
      holders({ manager_approver: [DANA, PRIYA, ANA, SAM, ALEX] }),
    );
    expect(d.text).toBe('the Manager approver (Dana Reyes, Priya Shah or 3 others)');
    // Bounded inline, unbounded for title / accessible name.
    expect(d.fullNames).toEqual([
      'Dana Reyes',
      'Priya Shah',
      'Ana Ruiz',
      'Sam Patel',
      'Alex Kim',
    ]);
    expect(d.people).toHaveLength(5);
  });

  it('ZERO holders is a structured CAUTION, not just different text', () => {
    const d = describeApprover(roleStep, MEMBERS, holders({}));
    expect(d.kind).toBe('role_unfilled');
    expect(d.unfilledRole).toBe(true);
    expect(d.blocksRouting).toBe(true);
    expect(d.tone).toBe('caution');
    expect(d.text).toBe(
      'Nobody holds the Manager approver role, so a request like this stops here.',
    );
    expect(d.people).toEqual([]);
  });

  it('a role held ONLY by ex-members is unfilled, not falsely reassuring', () => {
    const d = describeApprover(roleStep, MEMBERS, holders({ manager_approver: [GHOST] }));
    expect(d.kind).toBe('role_unfilled');
    expect(d.unfilledRole).toBe(true);
  });

  it('drops ex-member holders but stays normal when someone real remains', () => {
    const d = describeApprover(
      roleStep,
      MEMBERS,
      holders({ manager_approver: [GHOST, DANA] }),
    );
    expect(d.text).toBe('Dana Reyes');
    expect(d.kind).toBe('role');
    expect(d.fullNames).toEqual(['Dana Reyes']);
  });

  it('no roleHolders map at all behaves as zero holders', () => {
    const d = describeApprover(roleStep, MEMBERS);
    expect(d.unfilledRole).toBe(true);
  });

  it('an unknown role token falls back to the token, never an id', () => {
    const d = describeApprover(step({ approver_role: 'custom_role' }), MEMBERS, holders({}));
    expect(d.roleLabel).toBe('custom_role');
    expect(d.text).toContain('custom_role');
    expect(d.text).not.toMatch(ANY_UUIDISH);
  });

  it('an identifier-shaped role token degrades instead of leaking an id', () => {
    // An API-authored or corrupted approval_chain_steps row can put anything
    // in approver_role. The guarantee has to hold on that axis too.
    const d = describeApprover(step({ approver_role: GHOST }), MEMBERS, holders({}));
    expect(d.roleLabel).toBe('unrecognized');
    expect(d.text).toBe(
      'Nobody holds the unrecognized role, so a request like this stops here.',
    );
    expect(d.text).not.toMatch(ANY_UUIDISH);
    expect(describeApprover(step({ approver_role: 'deadbeef' }), MEMBERS).roleLabel).toBe(
      'unrecognized',
    );
  });

  it('role wins over a stray approver_user_id (mirrors approverDisplayFor)', () => {
    const d = describeApprover(
      step({ approver_role: 'manager_approver', approver_user_id: PRIYA }),
      MEMBERS,
      holders({ manager_approver: [DANA] }),
    );
    expect(d.text).toBe('Dana Reyes');
    expect(d.kind).toBe('role');
  });

  it('resolves every shipped role label', () => {
    expect(approvalRoleLabel('submitter')).toBe('Submitter');
    expect(approvalRoleLabel('financial_approver')).toBe('Financial approver');
    expect(approvalRoleLabel('signator')).toBe('Signatory');
    expect(approvalRoleLabel('admin')).toBe('Admin');
  });
});

describe('describeApprover — delegate + optional', () => {
  it('appends the backup parenthetically with days', () => {
    const d = describeApprover(
      step({ approver_user_id: DANA, delegate_user_id: SAM, delegate_after_days: 3 }),
      MEMBERS,
    );
    expect(d.suffix).toBe('(or Sam Patel after 3 days)');
    expect(approverPhrase(d)).toBe('Dana Reyes (or Sam Patel after 3 days)');
  });

  it('uses the no-days form when delegate_after_days is absent or zero', () => {
    const d = describeApprover(
      step({ approver_user_id: DANA, delegate_user_id: SAM }),
      MEMBERS,
    );
    expect(d.suffix).toBe('(or Sam Patel as backup)');
    const zero = describeApprover(
      step({ approver_user_id: DANA, delegate_user_id: SAM, delegate_after_days: 0 }),
      MEMBERS,
    );
    expect(zero.suffix).toBe('(or Sam Patel as backup)');
  });

  it('omits the suffix entirely for an unnameable delegate — never an id', () => {
    const d = describeApprover(
      step({ approver_user_id: DANA, delegate_user_id: GHOST, delegate_after_days: 3 }),
      MEMBERS,
    );
    expect(d.suffix).toBe('');
    expect(approverPhrase(d)).toBe('Dana Reyes');
  });

  it('flags optional steps', () => {
    const d = describeApprover(
      step({ approver_user_id: ALEX, is_required: false }),
      MEMBERS,
    );
    expect(d.optional).toBe(true);
  });
});

describe('THE GUARANTEE — no input produces a raw or truncated UUID', () => {
  const poisoned: MemberLike[] = [
    { id: DANA, label: DANA },
    { id: PRIYA, label: `${PRIYA.slice(0, 8)}…` },
    { id: ANA, label: '' },
  ];
  const inputs: DescribableStep[] = [
    step({ approver_user_id: DANA }),
    step({ approver_user_id: PRIYA }),
    step({ approver_user_id: ANA }),
    step({ approver_user_id: GHOST }),
    step({ approver_role: 'manager_approver' }),
    step({ approver_role: 'signator' }),
    step({ approver_role: GHOST }),
    step({ approver_user_id: DANA, delegate_user_id: PRIYA, delegate_after_days: 2 }),
    step(),
  ];

  it.each(inputs.map((s, i) => [i, s] as const))(
    'input %i produces no uuid in any string field',
    (_i, s) => {
      for (const map of [holders({}), holders({ manager_approver: [DANA, PRIYA, ANA] })]) {
        const d = describeApprover(s, poisoned, map);
        for (const value of [d.text, d.caption, d.suffix, d.roleLabel, ...d.fullNames]) {
          expect(value).not.toMatch(ANY_UUIDISH);
        }
        expect(approverPhrase(d)).not.toMatch(ANY_UUIDISH);
      }
    },
  );

  it('a whole chain built from poisoned data is uuid-free', () => {
    const c = describeChain(inputs, poisoned, holders({ manager_approver: [DANA] }));
    expect(c.sentence).not.toMatch(ANY_UUIDISH);
    for (const stage of c.stages) expect(stage.text).not.toMatch(ANY_UUIDISH);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// joinAnd
// ─────────────────────────────────────────────────────────────────────────

describe('joinAnd', () => {
  it('handles 0/1/2/3', () => {
    expect(joinAnd([])).toBe('');
    expect(joinAnd(['A'])).toBe('A');
    expect(joinAnd(['A', 'B'])).toBe('A and B');
    expect(joinAnd(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) describeChain
// ─────────────────────────────────────────────────────────────────────────

describe('describeChain — the two-stage sentence', () => {
  it('explicit signer: approve then sign, split so the governance split is visible', () => {
    const c = describeChain(
      [
        step({ stage: 'concept', step_order: 1, approver_user_id: DANA }),
        step({ stage: 'signator', step_order: 1, approver_user_id: PRIYA }),
      ],
      MEMBERS,
    );
    expect(c.sentence).toBe('Approved by Dana Reyes, then signed by Priya Shah.');
    expect(c.signatureInherited).toBe(false);
    expect(c.stages.map((s) => s.stage)).toEqual(['concept', 'signator']);
    expect(c.stages[1].inherited).toBe(false);
    expect(c.stages[1].note).toBe('');
    expect(c.tone).toBe('normal');
  });

  it('NO signator steps: says the same people sign, rather than hiding stage 2', () => {
    const c = describeChain([step({ approver_user_id: DANA })], MEMBERS);
    expect(c.sentence).toBe('Approved and signed by Dana Reyes.');
    expect(c.signatureInherited).toBe(true);
    expect(c.stages).toHaveLength(2);
    expect(c.stages[1].inherited).toBe(true);
    expect(c.stages[1].note).toBe('No separate signer set, so the same people sign.');
    expect(c.stages[1].text).toBe('Dana Reyes');
    expect(c.stages[1].names).toEqual(['Dana Reyes']);
  });

  it("honours the server's signator_inherited over local derivation", () => {
    // The preview RPC returns the ALREADY-materialized signature stage plus
    // signator_inherited:true. Without the override we'd call it explicit.
    const c = describeChain(
      [
        step({ stage: 'concept', approver_user_id: DANA }),
        step({ stage: 'signator', approver_user_id: DANA }),
      ],
      MEMBERS,
      undefined,
      { signatorInherited: true },
    );
    expect(c.signatureInherited).toBe(true);
    expect(c.sentence).toBe('Approved and signed by Dana Reyes.');
    expect(c.stages[1].note).toBe('No separate signer set, so the same people sign.');
  });

  it('signatorInherited:false forces the explicit reading', () => {
    const c = describeChain(
      [
        step({ stage: 'concept', approver_user_id: DANA }),
        step({ stage: 'signator', approver_user_id: PRIYA }),
      ],
      MEMBERS,
      undefined,
      { signatorInherited: false },
    );
    expect(c.signatureInherited).toBe(false);
    expect(c.sentence).toBe('Approved by Dana Reyes, then signed by Priya Shah.');
  });

  it('inherits a multi-person stage 1 into stage 2 verbatim', () => {
    const c = describeChain(
      [
        step({ step_order: 1, approver_user_id: DANA }),
        step({ step_order: 2, approver_user_id: PRIYA }),
      ],
      MEMBERS,
    );
    expect(c.stages[0].text).toBe('Dana Reyes, then Priya Shah');
    expect(c.stages[1].text).toBe('Dana Reyes, then Priya Shah');
    expect(c.sentence).toBe('Approved and signed by Dana Reyes, then Priya Shah.');
  });
});

describe('describeChain — never clamps', () => {
  it('a five-approver chain produces five approvers of prose', () => {
    const c = describeChain(
      [DANA, PRIYA, ANA, SAM, ALEX].map((id, i) =>
        step({ step_order: i + 1, parallel_group: i + 1, approver_user_id: id }),
      ),
      MEMBERS,
    );
    expect(c.stages[0].text).toBe(
      'Dana Reyes, then Priya Shah, then Ana Ruiz, then Sam Patel, then Alex Kim',
    );
    expect(c.stages[0].text).not.toContain('…');
    expect(c.stages[0].names).toHaveLength(5);
  });
});

describe('describeChain — levels, optional steps and blocking states', () => {
  it('steps sharing a step_order are described as concurrent (engine truth)', () => {
    // findFirstPendingAssignees batches by step_order, and isStageComplete
    // requires EVERY required step — so this is "at the same time", never
    // "either one".
    const c = describeChain(
      [
        step({ step_order: 1, parallel_group: 1, approver_user_id: DANA }),
        step({ step_order: 1, parallel_group: 2, approver_user_id: ANA }),
      ],
      MEMBERS,
    );
    expect(c.stages[0].text).toBe('Dana Reyes and Ana Ruiz (at the same time)');
  });

  it('groupBy:parallel_group is available but is NOT the default', () => {
    const steps = [
      step({ step_order: 1, parallel_group: 7, approver_user_id: DANA }),
      step({ step_order: 2, parallel_group: 7, approver_user_id: ANA }),
    ];
    expect(describeChain(steps, MEMBERS).stages[0].text).toBe('Dana Reyes, then Ana Ruiz');
    expect(
      describeChain(steps, MEMBERS, undefined, { groupBy: 'parallel_group' }).stages[0].text,
    ).toBe('Dana Reyes and Ana Ruiz (at the same time)');
  });

  it('appends optional approvers without letting them look required', () => {
    const c = describeChain(
      [
        step({ step_order: 1, approver_user_id: DANA }),
        step({ step_order: 1, approver_user_id: ALEX, is_required: false }),
      ],
      MEMBERS,
    );
    expect(c.stages[0].text).toBe('Dana Reyes, and optionally Alex Kim');
  });

  it('an optional-only level still renders', () => {
    const c = describeChain(
      [step({ step_order: 1, approver_user_id: ALEX, is_required: false })],
      MEMBERS,
    );
    expect(c.stages[0].text).toBe('optionally Alex Kim');
  });

  it('orders levels by step_order regardless of input order', () => {
    const c = describeChain(
      [
        step({ step_order: 3, approver_user_id: ANA }),
        step({ step_order: 1, approver_user_id: DANA }),
        step({ step_order: 2, approver_user_id: PRIYA }),
      ],
      MEMBERS,
    );
    expect(c.stages[0].text).toBe('Dana Reyes, then Priya Shah, then Ana Ruiz');
  });

  it('no concept steps at all = blocking', () => {
    const c = describeChain([], MEMBERS);
    expect(c.blocked).toBe(true);
    expect(c.hasConceptStage).toBe(false);
    expect(c.tone).toBe('blocking');
    expect(c.sentence).toBe('Nobody assigned — this rule would block the request.');
    expect(c.stages).toHaveLength(1);
  });

  it('a stage 1 nobody can action is blocking, not a cheerful sentence', () => {
    const c = describeChain(
      [step({ approver_role: 'manager_approver' })],
      MEMBERS,
      holders({}),
    );
    expect(c.blocked).toBe(true);
    expect(c.tone).toBe('blocking');
    expect(c.sentence).toBe('Nobody assigned — this rule would block the request.');
    expect(c.cautions).toHaveLength(2); // concept + its inherited clone
    expect(c.cautions[0].unfilledRole).toBe(true);
  });

  it('a partially unreachable stage 1 is a caution, not blocking', () => {
    const c = describeChain(
      [
        step({ step_order: 1, approver_user_id: DANA }),
        step({ step_order: 2, approver_user_id: GHOST }),
      ],
      MEMBERS,
    );
    expect(c.blocked).toBe(false);
    expect(c.tone).toBe('caution');
    expect(c.cautions.some((c2) => c2.kind === 'former_member')).toBe(true);
    expect(c.stages[0].text).toBe('Dana Reyes, then Former member');
  });

  it('signator-only chain (malformed) is blocking rather than silently fine', () => {
    const c = describeChain([step({ stage: 'signator', approver_user_id: DANA })], MEMBERS);
    expect(c.hasConceptStage).toBe(false);
    expect(c.blocked).toBe(true);
    expect(c.sentence).toBe('Nobody assigned — this rule would block the request.');
  });

  it('resolves role steps to humans in the sentence (the whole point)', () => {
    const c = describeChain(
      [
        step({ stage: 'concept', approver_role: 'manager_approver' }),
        step({ stage: 'signator', approver_role: 'signator' }),
      ],
      MEMBERS,
      holders({ manager_approver: [DANA, PRIYA], signator: [ANA] }),
    );
    expect(c.sentence).toBe(
      'Approved by the Manager approver (Dana Reyes or Priya Shah), then signed by Ana Ruiz.',
    );
    expect(c.sentence).not.toContain('Anyone with role');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (c) findShadowedRules
// ─────────────────────────────────────────────────────────────────────────

function rule(over: Partial<DescribableRule> & { id: string }): DescribableRule {
  return {
    name: over.id,
    is_active: true,
    match_asset_types: [],
    match_departments: [],
    match_min_annual_cost: null,
    match_max_annual_cost: null,
    match_regions: [],
    match_lease_types: [],
    ...over,
  };
}

describe('ruleCovers', () => {
  it('a filterless rule covers everything', () => {
    expect(
      ruleCovers(rule({ id: 'a' }), rule({ id: 'b', match_asset_types: ['property'] })),
    ).toBe(true);
  });

  it('a narrower rule does not cover a broader one', () => {
    expect(
      ruleCovers(rule({ id: 'a', match_asset_types: ['property'] }), rule({ id: 'b' })),
    ).toBe(false);
  });

  it('folds asset types canonically, exactly as the engine does', () => {
    expect(
      ruleCovers(
        rule({ id: 'a', match_asset_types: ['real_estate'] }),
        rule({ id: 'b', match_asset_types: ['property'] }),
      ),
    ).toBe(true);
  });

  it('departments are exact strings, not folded', () => {
    expect(
      ruleCovers(
        rule({ id: 'a', match_departments: ['Warehouse', 'Ops'] }),
        rule({ id: 'b', match_departments: ['Ops'] }),
      ),
    ).toBe(true);
    expect(
      ruleCovers(
        rule({ id: 'a', match_departments: ['Warehouse'] }),
        rule({ id: 'b', match_departments: ['warehouse'] }),
      ),
    ).toBe(false);
  });

  it('cost containment uses [0, ∞) as the reachable domain', () => {
    expect(
      ruleCovers(
        rule({ id: 'a', match_min_annual_cost: 100_000 }),
        rule({ id: 'b', match_min_annual_cost: 200_000 }),
      ),
    ).toBe(true);
    expect(
      ruleCovers(
        rule({ id: 'a', match_min_annual_cost: 200_000 }),
        rule({ id: 'b', match_min_annual_cost: 100_000 }),
      ),
    ).toBe(false);
    // A null min is the same as 0, so a min:0 rule covers a null-min rule.
    expect(
      ruleCovers(
        rule({ id: 'a', match_min_annual_cost: 0 }),
        rule({ id: 'b', match_min_annual_cost: null }),
      ),
    ).toBe(true);
    expect(
      ruleCovers(
        rule({ id: 'a', match_max_annual_cost: 500_000 }),
        rule({ id: 'b', match_min_annual_cost: 100_000, match_max_annual_cost: 400_000 }),
      ),
    ).toBe(true);
  });

  it('never reports a rule as covering itself', () => {
    const r = rule({ id: 'a' });
    expect(ruleCovers(r, r)).toBe(false);
  });
});

describe('rulesCanCoMatch', () => {
  it('disjoint departments cannot co-match', () => {
    expect(
      rulesCanCoMatch(
        rule({ id: 'a', match_departments: ['Ops'] }),
        rule({ id: 'b', match_departments: ['Legal'] }),
      ),
    ).toBe(false);
  });

  it('disjoint asset types cannot co-match', () => {
    expect(
      rulesCanCoMatch(
        rule({ id: 'a', match_asset_types: ['property'] }),
        rule({ id: 'b', match_asset_types: ['vehicle'] }),
      ),
    ).toBe(false);
  });

  it('disjoint cost bands cannot co-match', () => {
    expect(
      rulesCanCoMatch(
        rule({ id: 'a', match_max_annual_cost: 99_999 }),
        rule({ id: 'b', match_min_annual_cost: 100_000 }),
      ),
    ).toBe(false);
  });

  it('touching cost bands DO co-match at the boundary', () => {
    expect(
      rulesCanCoMatch(
        rule({ id: 'a', match_max_annual_cost: 100_000 }),
        rule({ id: 'b', match_min_annual_cost: 100_000 }),
      ),
    ).toBe(true);
  });

  it('one unconstrained dimension keeps the overlap alive', () => {
    expect(
      rulesCanCoMatch(
        rule({ id: 'a', match_departments: ['Ops'] }),
        rule({ id: 'b', match_asset_types: ['property'] }),
      ),
    ).toBe(true);
  });
});

describe('findShadowedRules', () => {
  it('reports no overlap when every rule is disjoint — ordering decides nothing', () => {
    const a = findShadowedRules([
      rule({ id: 'a', name: 'Property', match_asset_types: ['property'] }),
      rule({ id: 'b', name: 'Vehicles', match_asset_types: ['vehicle'] }),
      rule({ id: 'c', name: 'Equipment', match_asset_types: ['equipment'] }),
    ]);
    expect(a.anyOverlap).toBe(false);
    expect(a.overlappingPairs).toEqual([]);
    expect(a.neverFires).toEqual([]);
    expect(describeOverlapStatus(a)).toBe(
      "None of these rules overlap, so the order doesn't change anything today.",
    );
  });

  it('reports the overlapping pair and both directions on the rules', () => {
    const a = findShadowedRules([
      rule({ id: 'a', name: 'Warehouse equipment', match_departments: ['Warehouse'] }),
      rule({ id: 'b', name: 'High-value leases', match_min_annual_cost: 100_000 }),
    ]);
    expect(a.anyOverlap).toBe(true);
    expect(a.overlappingPairs).toHaveLength(1);
    expect(a.byRuleId.get('a')!.overlapsWith).toEqual([
      { id: 'b', name: 'High-value leases' },
    ]);
    expect(a.byRuleId.get('b')!.overlapsWith).toEqual([
      { id: 'a', name: 'Warehouse equipment' },
    ]);
    expect(describeOverlapStatus(a)).toBe(
      '«Warehouse equipment» and «High-value leases» can both fit the same request — the higher one wins.',
    );
  });

  it('flags a rule fully covered by an EARLIER rule', () => {
    const rules = [
      rule({ id: 'a', name: 'High-value leases' }), // no filters: covers all
      rule({ id: 'b', name: 'Warehouse', match_departments: ['Warehouse'] }),
    ];
    const a = findShadowedRules(rules);
    const b = a.byRuleId.get('b')!;
    expect(b.neverFires).toBe(true);
    expect(b.reason).toBe('shadowed');
    expect(b.shadowedBy).toEqual({ id: 'a', name: 'High-value leases' });
    expect(describeNeverFires(b, rules[1])).toBe(
      'Never used — «High-value leases» above already covers everything this rule covers.',
    );
    // The covering rule itself is fine.
    expect(a.byRuleId.get('a')!.neverFires).toBe(false);
  });

  it('does NOT flag a rule covered only by a LATER rule (order is load-bearing)', () => {
    const a = findShadowedRules([
      rule({ id: 'b', name: 'Warehouse', match_departments: ['Warehouse'] }),
      rule({ id: 'a', name: 'Catch-all' }),
    ]);
    expect(a.byRuleId.get('b')!.neverFires).toBe(false);
    expect(a.byRuleId.get('a')!.neverFires).toBe(false);
  });

  it('paused rules are not evaluated and neither shadow nor overlap', () => {
    const a = findShadowedRules([
      rule({ id: 'a', name: 'Catch-all', is_active: false }),
      rule({ id: 'b', name: 'Warehouse', match_departments: ['Warehouse'] }),
    ]);
    expect(a.byRuleId.get('a')!.evaluated).toBe(false);
    expect(a.byRuleId.get('b')!.neverFires).toBe(false);
    expect(a.anyOverlap).toBe(false);
  });

  it('region / lease_type are NOT overlap dimensions — they only kill a rule', () => {
    // Both rules match Ops. If region were an overlap dimension they'd look
    // disjoint; instead the region rule is dead and the pair does not overlap.
    const a = findShadowedRules([
      rule({
        id: 'a',
        name: 'West Ops',
        match_departments: ['Ops'],
        match_regions: ['West'],
      }),
      rule({ id: 'b', name: 'Ops', match_departments: ['Ops'] }),
    ]);
    expect(a.byRuleId.get('a')!.neverFires).toBe(true);
    expect(a.byRuleId.get('a')!.reason).toBe('retired_criteria');
    expect(a.byRuleId.get('b')!.neverFires).toBe(false);
    expect(a.anyOverlap).toBe(false);
    expect(a.neverFires).toEqual([{ id: 'a', name: 'West Ops' }]);
  });

  it('a dead rule cannot shadow a live one', () => {
    const a = findShadowedRules([
      rule({ id: 'a', name: 'Catch-all with region', match_regions: ['West'] }),
      rule({ id: 'b', name: 'Warehouse', match_departments: ['Warehouse'] }),
    ]);
    expect(a.byRuleId.get('b')!.neverFires).toBe(false);
  });

  it('flags an impossible cost range', () => {
    const rules = [
      rule({ id: 'a', name: 'Backwards', match_min_annual_cost: 500, match_max_annual_cost: 100 }),
    ];
    const a = findShadowedRules(rules);
    expect(a.byRuleId.get('a')!.reason).toBe('impossible_range');
    expect(describeNeverFires(a.byRuleId.get('a')!, rules[0])).toBe(
      'The lowest amount in this rule is higher than the highest, so no request can match it.',
    );
  });

  it('reports every rule id, even ones with nothing to say', () => {
    const a = findShadowedRules([rule({ id: 'a' })]);
    expect(a.byRuleId.size).toBe(1);
    expect(describeNeverFires(a.byRuleId.get('a')!, rule({ id: 'a' }))).toBeNull();
  });

  it('handles an empty workspace', () => {
    const a = findShadowedRules([]);
    expect(a.anyOverlap).toBe(false);
    expect(a.byRuleId.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (d) Retired criteria (D-Q2)
// ─────────────────────────────────────────────────────────────────────────

describe('describeRetiredCriteria', () => {
  it('says nothing for a clean rule', () => {
    const r = describeRetiredCriteria({ match_regions: [], match_lease_types: [] });
    expect(r.usesRetiredCriteria).toBe(false);
    expect(r.warning).toBeNull();
    expect(r.dimensions).toEqual([]);
  });

  it('warns on region, and PRESERVES the authored values', () => {
    const r = describeRetiredCriteria({ match_regions: ['West', 'East'], match_lease_types: [] });
    expect(r.usesRetiredCriteria).toBe(true);
    expect(r.dimensions).toEqual(['region']);
    expect(r.regions).toEqual(['West', 'East']);
    expect(r.warning).toBe(
      "This rule only fits requests with a region, and lease requests don't ask for one — so it will never be used.",
    );
  });

  it('warns on lease type', () => {
    const r = describeRetiredCriteria({ match_regions: [], match_lease_types: ['Real Estate'] });
    expect(r.dimensions).toEqual(['lease_type']);
    expect(r.leaseTypes).toEqual(['Real Estate']);
    expect(r.warning).toBe(
      "This rule only fits requests with a lease type, and lease requests don't ask for one — so it will never be used.",
    );
  });

  it('warns once when both are set', () => {
    const r = describeRetiredCriteria({
      match_regions: ['West'],
      match_lease_types: ['Equipment'],
    });
    expect(r.dimensions).toEqual(['region', 'lease_type']);
    expect(r.warning).toBe(
      'This rule only fits requests with a region and a lease type, and lease requests ask for neither — so it will never be used.',
    );
  });

  it('tolerates null / undefined columns', () => {
    expect(describeRetiredCriteria({}).usesRetiredCriteria).toBe(false);
    expect(
      describeRetiredCriteria({ match_regions: null, match_lease_types: null })
        .usesRetiredCriteria,
    ).toBe(false);
  });

  it('an empty-string entry is NOT dead — the engine would match a NULL lease', () => {
    expect(usesRetiredCriteria({ match_regions: [''] })).toBe(false);
    expect(usesRetiredCriteria({ match_regions: ['', 'West'] })).toBe(false);
    expect(retiredDimensions({ match_lease_types: [''] })).toEqual([]);
  });

  it('retiredDimensions needs no i18n', () => {
    expect(retiredDimensions({ match_regions: ['West'] })).toEqual(['region']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildRoleHolderMap
// ─────────────────────────────────────────────────────────────────────────

describe('buildRoleHolderMap', () => {
  it('groups, dedupes and skips malformed rows', () => {
    const map = buildRoleHolderMap([
      { role: 'manager_approver', user_id: DANA },
      { role: 'manager_approver', user_id: DANA },
      { role: 'manager_approver', user_id: PRIYA },
      { role: 'signator', user_id: ANA },
      { role: null, user_id: SAM },
      { role: 'admin', user_id: null },
    ]);
    expect(map.get('manager_approver')).toEqual([DANA, PRIYA]);
    expect(map.get('signator')).toEqual([ANA]);
    expect(map.has('admin')).toBe(false);
  });
});
