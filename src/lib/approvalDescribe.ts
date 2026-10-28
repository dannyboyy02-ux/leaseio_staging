// ─────────────────────────────────────────────────────────────────────────
// approvalDescribe — the single source of approval PROSE.
//
// WHY THIS FILE EXISTS
// Four surfaces answer the same question ("who approves this?") and today
// they answer it differently and badly:
//   • ChainDiagram.tsx:255  renders "Anyone with role" for every role step.
//   • ApprovalPolicyTestDialog.tsx:284 renders "User 3f8a2b1c…" — a raw UUID.
//   • The list rows render criteria chips and never name a human at all.
//   • The hero (new) must lead with the human.
// Every one of those is derived from the SAME three inputs. So the derivation
// lives here, once, as pure functions over plain data. The hero, the list
// rows, the editor's live strip and the editor's chain chips all call these
// helpers and therefore cannot drift.
//
// PURITY CONTRACT
//   • No React. No Supabase. No hooks. No network. No Date.now().
//   • The ONLY import besides i18next is `@/lib/assetTypes` — itself a pure,
//     import-free module that is the canonical asset-type matcher mirrored in
//     Deno and SQL. findShadowedRules MUST fold asset types exactly the way
//     the engine does, so it uses that same function rather than a copy.
//
// i18n APPROACH (matches src/lib/assetTypeLabels.ts, portfolioWatchlist.ts,
// leaseAnalysisProse.ts — the established pattern for non-component modules):
// `import { t } from 'i18next'` and return already-rendered strings alongside
// the structured metadata. CALLER NOTE: anything that memoizes the output of
// these functions MUST include the active language in its cache key (same
// rule as useNeedsAction's queryKey and Portfolio's watchlist memo).
//
// HARD GUARANTEE
// No function in this file can return a raw or truncated UUID as a display
// name, for ANY input. See `resolvePersonName` + `containsRawId`, pinned by
// approvalDescribe.test.ts. The truncated-UUID vocabulary (tester.user_short,
// tester.delegate_short, tester.former_member's id interpolation) leaves the
// product; nothing here can reintroduce it.
// ─────────────────────────────────────────────────────────────────────────

import { t } from 'i18next';
import { canonicalAssetType } from '@/lib/assetTypes';

// ─────────────────────────────────────────────────────────────────────────
// Input shapes — structural, so callers pass what they already have.
// ─────────────────────────────────────────────────────────────────────────

/** Structurally compatible with ChainDiagram's MemberOption and with the
 *  member list the settings pages already fetch. `label` may carry the
 *  "First Last (email@x.com)" tail; it is stripped for prose. */
export interface MemberLike {
  id: string;
  label: string;
}

export type ApprovalStage = 'concept' | 'signator';

/** Structurally compatible with ChainDiagram's ChainStep, with the
 *  approval_chain_steps row, and with the preview RPC's chain elements.
 *  Extra columns on the caller's object are ignored. */
export interface DescribableStep {
  stage?: ApprovalStage | null;
  step_order?: number | null;
  parallel_group?: number | null;
  approver_user_id: string | null;
  approver_role: string | null;
  delegate_user_id?: string | null;
  delegate_after_days?: number | null;
  is_required?: boolean | null;
}

/** role token → the user ids holding that role in this workspace.
 *  Built from `workspace_roles` (workspace_id, user_id, role). */
export type RoleHolderMap = ReadonlyMap<string, readonly string[]>;

/** Reduce raw workspace_roles rows to the map the describers want. */
export function buildRoleHolderMap(
  rows: ReadonlyArray<{ role: string | null; user_id: string | null }>,
): RoleHolderMap {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (!row?.role || !row?.user_id) continue;
    const list = map.get(row.role);
    if (list) {
      if (!list.includes(row.user_id)) list.push(row.user_id);
    } else {
      map.set(row.role, [row.user_id]);
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// Role vocabulary. Reuses the ALREADY-SHIPPED policy_editor.chain.role_* keys
// (see ChainDiagram.FUNCTIONAL_ROLE_OPTIONS) so no new role labels are minted
// and the editor + the list + the hero cannot disagree about what a role is
// called. Unknown tokens fall through to the stored token, which is a role
// name, never an id.
// ─────────────────────────────────────────────────────────────────────────

export const APPROVAL_ROLE_LABEL_KEYS: Readonly<Record<string, string>> = {
  submitter: 'policy_editor.chain.role_submitter',
  manager_approver: 'policy_editor.chain.role_manager_approver',
  financial_approver: 'policy_editor.chain.role_financial_approver',
  signator: 'policy_editor.chain.role_signator',
  admin: 'policy_editor.chain.role_admin',
};

/**
 * Localized role name. Unknown tokens fall through to the stored token —
 * EXCEPT when the token is itself identifier-shaped, which an API-authored
 * or corrupted row can produce. That case degrades to a generic label so the
 * never-a-UUID guarantee holds for the role axis too, not just the user axis.
 */
export function approvalRoleLabel(role: string): string {
  const key = APPROVAL_ROLE_LABEL_KEYS[role];
  if (key) return t(key);
  if (looksLikeIdentifier(role)) return t('policy_editor.describe.unknown_role');
  return role;
}

/** A full UUID, or a bare hex blob long enough to be an id fragment. */
function looksLikeIdentifier(value: string): boolean {
  if (containsRawId(value, null)) return true;
  return /^[0-9a-f]{8,}$/i.test(value.replace(/-/g, ''));
}

// ─────────────────────────────────────────────────────────────────────────
// Name resolution + the never-a-UUID guarantee.
// ─────────────────────────────────────────────────────────────────────────

const FULL_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Strip a trailing "(anything)" tail: "Alice Smith (a@x.com)" → "Alice Smith". */
export function personName(label: string): string {
  const stripped = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return stripped || label.trim();
}

/**
 * True when a candidate display string is (or embeds) the raw identifier —
 * a full UUID anywhere in it, or a prefix match against the id. This is the
 * backstop for the guarantee: `formatApproverLabel` falls back to `p.id` when
 * a profile has no name AND no email, so a member label CAN legitimately be a
 * UUID. Rather than render it, we degrade to "Former member".
 */
export function containsRawId(candidate: string, id: string | null): boolean {
  if (!candidate) return true;
  if (FULL_UUID.test(candidate)) return true;
  if (!id) return false;
  const head = id.replace(/-/g, '').slice(0, 8).toLowerCase();
  if (head.length < 8) return false;
  const norm = candidate.replace(/-/g, '').toLowerCase();
  return norm.startsWith(head);
}

/** Resolve a user id to a safe display name, or null when it cannot be
 *  named safely (not a member any more, blank label, or a label that is
 *  really the id). Null is the caller's signal to say "Former member". */
export function resolvePersonName(
  id: string | null | undefined,
  members: readonly MemberLike[],
): string | null {
  if (!id) return null;
  const match = members.find((m) => m.id === id);
  if (!match) return null;
  const name = personName((match.label ?? '').trim());
  if (!name) return null;
  if (containsRawId(name, id)) return null;
  return name;
}

// ─────────────────────────────────────────────────────────────────────────
// (a) describeApprover — the mandatory role-to-human resolver.
// ─────────────────────────────────────────────────────────────────────────

export type ApproverTone = 'normal' | 'caution';

export type ApproverKind =
  | 'user'            // a named person
  | 'role'            // a role with at least one reachable holder
  | 'role_unfilled'   // a role nobody holds — the request silently stops
  | 'former_member'   // a user id that is no longer a member
  | 'empty';          // no approver chosen at all

export interface DescribedPerson {
  /** null only for a holder that could not be named safely. */
  id: string | null;
  name: string;
}

export interface ApproverDescription {
  /** Primary human-facing text. NEVER contains a raw or truncated UUID. */
  text: string;
  /** Role context, demoted to a caption when the person's name leads.
   *  Empty string when there is nothing to caption. */
  caption: string;
  /** Parenthetical backup clause, e.g. "(or Sam Patel after 3 days)".
   *  Empty when there is no delegate or the delegate cannot be named. */
  suffix: string;
  tone: ApproverTone;
  kind: ApproverKind;
  /** Authored role token, or null for a person step. */
  role: string | null;
  /** Localized role label ("Manager approver"), or '' for a person step. */
  roleLabel: string;
  /** The people this step can actually reach. Bounded rendering lives in
   *  `text`; this list is complete and unbounded for title/aria use. */
  people: DescribedPerson[];
  /** Every reachable name, unbounded — for the `title` attribute and the
   *  row's accessible name (roleToHumanPlan requires the full list there). */
  fullNames: string[];
  /** true when a role step resolves to nobody who can act. */
  unfilledRole: boolean;
  /** true when this step, as authored, cannot be actioned by anyone —
   *  unfilled role, former member, or an empty slot. Callers style off this
   *  rather than re-deriving meaning from `kind`. */
  blocksRouting: boolean;
  /** is_required === false. */
  optional: boolean;
}

/**
 * Resolve ONE chain step to prose about a human.
 *
 * Forms (roleToHumanPlan, with the bounded many-holder form decided here):
 *   named user               → "Dana Reyes"
 *   role, 1 holder           → "Dana Reyes"           caption "the Manager approver"
 *   role, 2 holders          → "the Manager approver (Dana Reyes or Priya Shah)"
 *   role, 3 holders          → "the Manager approver (Dana Reyes, Priya Shah or Ana Ruiz)"
 *   role, 4+ holders         → "the Manager approver (Dana Reyes, Priya Shah or 2 others)"
 *   role, 0 reachable holders→ CAUTION: "Nobody holds the Manager approver
 *                              role, so a request like this stops here."
 *   unknown user id          → "Former member" (CAUTION) — never the id
 *   empty slot               → "No one chosen yet" (CAUTION)
 *
 * BOUNDED-FORM DECISION: at most two names are ever shown inline, and the
 * overflow is only ever expressed as "or N others" with N ≥ 2 — three holders
 * list all three rather than saying "or 1 other", which reads worse and is
 * the same length. The complete list is always in `fullNames`, which the
 * caller puts in `title` + the accessible name. There is no unbounded inline
 * list on any surface.
 *
 * A role holder who is no longer a member is dropped from the reachable set
 * (they cannot act), so a role held only by ex-members correctly reports as
 * UNFILLED rather than falsely reassuring.
 */
export function describeApprover(
  step: DescribableStep,
  members: readonly MemberLike[],
  roleHolders?: RoleHolderMap,
): ApproverDescription {
  const optional = step.is_required === false;
  const suffix = describeDelegateSuffix(step, members);

  // Role takes precedence, mirroring approverDisplayFor + the DB's
  // chain_assignee_present CHECK (exactly one of the two is set).
  if (step.approver_role) {
    const role = step.approver_role;
    const roleLabel = approvalRoleLabel(role);
    const holderIds = roleHolders?.get(role) ?? [];
    const people: DescribedPerson[] = [];
    for (const id of holderIds) {
      const name = resolvePersonName(id, members);
      if (name) people.push({ id, name });
    }
    const names = people.map((p) => p.name);

    if (names.length === 0) {
      return {
        text: t('policy_editor.describe.role_unfilled', { role: roleLabel }),
        caption: '',
        suffix,
        tone: 'caution',
        kind: 'role_unfilled',
        role,
        roleLabel,
        people: [],
        fullNames: [],
        unfilledRole: true,
        blocksRouting: true,
        optional,
      };
    }

    let text: string;
    let caption = '';
    if (names.length === 1) {
      // The human's name leads; the role explains it.
      text = names[0];
      caption = t('policy_editor.describe.role_caption', { role: roleLabel });
    } else if (names.length === 2) {
      text = t('policy_editor.describe.role_with_two', {
        role: roleLabel,
        a: names[0],
        b: names[1],
      });
    } else if (names.length === 3) {
      text = t('policy_editor.describe.role_with_three', {
        role: roleLabel,
        a: names[0],
        b: names[1],
        c: names[2],
      });
    } else {
      // `others` (not `count`) on purpose: `count` would engage i18next's
      // plural machinery and require _one/_other variants in both locale
      // files. The overflow here is always ≥ 2, so a single plural form is
      // correct and one key stays one key.
      text = t('policy_editor.describe.role_with_many', {
        role: roleLabel,
        a: names[0],
        b: names[1],
        others: names.length - 2,
      });
    }

    return {
      text,
      caption,
      suffix,
      tone: 'normal',
      kind: 'role',
      role,
      roleLabel,
      people,
      fullNames: names,
      unfilledRole: false,
      blocksRouting: false,
      optional,
    };
  }

  if (step.approver_user_id) {
    const name = resolvePersonName(step.approver_user_id, members);
    if (!name) {
      return {
        text: t('policy_editor.describe.former_member'),
        caption: '',
        suffix,
        tone: 'caution',
        kind: 'former_member',
        role: null,
        roleLabel: '',
        people: [],
        fullNames: [],
        unfilledRole: false,
        blocksRouting: true,
        optional,
      };
    }
    return {
      text: name,
      caption: '',
      suffix,
      tone: 'normal',
      kind: 'user',
      role: null,
      roleLabel: '',
      people: [{ id: step.approver_user_id, name }],
      fullNames: [name],
      unfilledRole: false,
      blocksRouting: false,
      optional,
    };
  }

  return {
    text: t('policy_editor.describe.empty_step'),
    caption: '',
    suffix: '',
    tone: 'caution',
    kind: 'empty',
    role: null,
    roleLabel: '',
    people: [],
    fullNames: [],
    unfilledRole: false,
    blocksRouting: true,
    optional,
  };
}

/** "(or Sam Patel after 3 days)" / "(or Sam Patel as backup)" / ''.
 *  An unnameable delegate produces NO suffix rather than a UUID. */
function describeDelegateSuffix(
  step: DescribableStep,
  members: readonly MemberLike[],
): string {
  if (!step.delegate_user_id) return '';
  const name = resolvePersonName(step.delegate_user_id, members);
  if (!name) return '';
  const days = step.delegate_after_days;
  if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
    return t('policy_editor.describe.delegate_after_days', { name, days });
  }
  return t('policy_editor.describe.delegate_backup', { name });
}

/** text + suffix, the way a caller renders one step inline. */
export function approverPhrase(d: ApproverDescription): string {
  return [d.text, d.suffix].filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────
// (b) describeChain — the two-stage sentence, honestly.
// ─────────────────────────────────────────────────────────────────────────

export type ChainTone = 'normal' | 'caution' | 'blocking';

export interface StageDescription {
  stage: ApprovalStage;
  /** true when this stage was NOT authored — the engine materializes it by
   *  cloning stage 1 (materializeSignatorInheritance). Callers MUST render
   *  an inherited signer differently from a chosen one. */
  inherited: boolean;
  /** Full prose for the stage, e.g. "Dana Reyes, then Priya Shah". Never
   *  clamped or truncated by this module. */
  text: string;
  /** Extra sentence stated only for an inherited stage 2. '' otherwise. */
  note: string;
  approvers: ApproverDescription[];
  /** Distinct reachable names across the stage, in order of first mention. */
  names: string[];
}

export interface ChainDescription {
  /** One-line answer for the hero headline and the list row. */
  sentence: string;
  stages: StageDescription[];
  /** true when stage 2 exists only because the engine cloned stage 1. */
  signatureInherited: boolean;
  /** false only for a malformed chain with no concept steps. */
  hasConceptStage: boolean;
  /** true when nothing in the chain can be actioned — the rule would block. */
  blocked: boolean;
  tone: ChainTone;
  /** Every step that cannot be actioned (unfilled role / former member /
   *  empty slot), most useful for the row-level destructive rollup. */
  cautions: ApproverDescription[];
}

export interface DescribeChainOptions {
  /**
   * The server's own answer. `preview_policy_resolution` returns
   * `signator_inherited: true` ALONGSIDE the already-materialized signature
   * stage, so the hero must pass it — otherwise the derivation below sees
   * real signator rows and would call an inherited stage "explicitly chosen".
   * Omit it on authored (editor / list) data and it is derived correctly.
   */
  signatorInherited?: boolean;
  /**
   * How steps are batched into "at the same time" levels.
   *
   * DEFAULT 'step_order' — because that is what the ENGINE does
   * (findFirstPendingAssignees batches by the lowest pending step_order and
   * notifies every step sharing it). `parallel_group` is decorative in the
   * editor and is NOT what the runtime honours; describing by it would print
   * "at the same time" for approvers the engine actually notifies one after
   * another. See the note in the phase report — this divergence is a real,
   * pre-existing engine/editor defect, and this module refuses to repeat it.
   */
  groupBy?: 'step_order' | 'parallel_group';
}

/**
 * Render a whole chain as the two-stage sentence.
 *
 * The load-bearing honesty rules:
 *  • Stage 1 is always described when it exists.
 *  • Stage 2 is OPTIONAL. When a rule has concept steps and no signator
 *    steps, the engine materializes the signature stage by cloning stage 1
 *    (materializeSignatorInheritance). This description SAYS SO in words —
 *    it neither hides the stage nor implies a separately-chosen signer.
 *  • Nothing is clamped, truncated or line-limited here. A five-approver
 *    chain produces five approvers of prose; that visible length is honest
 *    signal that the rule is over-built.
 *
 * DO NOT USE FOR THE LEGACY DEFAULT PATH. The "Everything else" row routes
 * through the legacy manager/financial approvers, which build NO chain and
 * therefore have NO signature stage at all. Feeding synthesized steps in here
 * would materialize an inherited stage 2 and print "…and signs it too" for a
 * path that never signs — the exact falsehood catchAllSpec rejects. That row
 * composes its own copy from describeApprover on its two slots.
 */
export function describeChain(
  steps: readonly DescribableStep[],
  members: readonly MemberLike[],
  roleHolders?: RoleHolderMap,
  options: DescribeChainOptions = {},
): ChainDescription {
  const groupBy = options.groupBy ?? 'step_order';
  const concept = steps.filter((s) => (s.stage ?? 'concept') === 'concept');
  const signator = steps.filter((s) => s.stage === 'signator');

  const inherited =
    options.signatorInherited ?? (signator.length === 0 && concept.length > 0);

  const conceptStage = buildStage(
    'concept',
    concept,
    members,
    roleHolders,
    groupBy,
    false,
  );

  // When stage 2 was never authored, the engine clones stage 1 — so the
  // people ARE the stage-1 people. When the caller handed us an already
  // materialized chain plus signator_inherited, the signator rows are those
  // same clones and we describe them directly.
  const signatorSource = signator.length > 0 ? signator : inherited ? concept : [];
  const stages: StageDescription[] = [conceptStage];

  if (signatorSource.length > 0) {
    const stage = buildStage(
      'signator',
      signatorSource,
      members,
      roleHolders,
      groupBy,
      inherited,
    );
    if (inherited) {
      stage.note = t('policy_editor.describe.stage2_inherited_note');
    }
    stages.push(stage);
  }

  const signatureStage = stages.find((s) => s.stage === 'signator');
  const cautions = stages.flatMap((s) => s.approvers.filter((a) => a.blocksRouting));

  const hasConceptStage = concept.length > 0;
  // Every reachable approver in stage 1 is unusable → the rule blocks.
  const stage1Unreachable =
    hasConceptStage && conceptStage.approvers.every((a) => a.blocksRouting);

  let sentence: string;
  if (!hasConceptStage) {
    sentence = t('policy_editor.describe.sentence_blocked');
  } else if (stage1Unreachable) {
    sentence = t('policy_editor.describe.sentence_blocked');
  } else if (inherited && signatureStage) {
    sentence = t('policy_editor.describe.sentence_inherited', {
      approvers: conceptStage.text,
    });
  } else if (signatureStage) {
    sentence = t('policy_editor.describe.sentence_split', {
      approvers: conceptStage.text,
      signers: signatureStage.text,
    });
  } else {
    sentence = t('policy_editor.describe.sentence_approve_only', {
      approvers: conceptStage.text,
    });
  }

  const blocked = !hasConceptStage || stage1Unreachable;
  const tone: ChainTone = blocked ? 'blocking' : cautions.length > 0 ? 'caution' : 'normal';

  return {
    sentence,
    stages,
    signatureInherited: Boolean(inherited && signatureStage),
    hasConceptStage,
    blocked,
    tone,
    cautions,
  };
}

function buildStage(
  stage: ApprovalStage,
  stageSteps: readonly DescribableStep[],
  members: readonly MemberLike[],
  roleHolders: RoleHolderMap | undefined,
  groupBy: 'step_order' | 'parallel_group',
  inherited: boolean,
): StageDescription {
  const levels = groupIntoLevels(stageSteps, groupBy);
  const approvers: ApproverDescription[] = [];
  const levelTexts: string[] = [];

  for (const level of levels) {
    const described = level.map((s) => describeApprover(s, members, roleHolders));
    approvers.push(...described);

    const required = described.filter((d) => !d.optional).map(approverPhrase);
    const optional = described.filter((d) => d.optional).map(approverPhrase);

    let text: string;
    if (required.length > 1) {
      // Same level = the engine notifies these together AND every required
      // one must approve. "at the same time", never "either one".
      text = t('policy_editor.describe.same_time', { names: joinAnd(required) });
    } else if (required.length === 1) {
      text = required[0];
    } else {
      text = '';
    }

    if (optional.length > 0) {
      const optionalText = t('policy_editor.describe.optionally', {
        names: joinAnd(optional),
      });
      text = text
        ? t('policy_editor.describe.with_optional', { required: text, optional: optionalText })
        : optionalText;
    }

    if (text) levelTexts.push(text);
  }

  const names: string[] = [];
  for (const a of approvers) {
    for (const n of a.fullNames) if (!names.includes(n)) names.push(n);
  }

  return {
    stage,
    inherited,
    text: levelTexts.join(t('policy_editor.describe.then_separator')),
    note: '',
    approvers,
    names,
  };
}

/** Batch steps into levels. Order is by the smallest step_order in each
 *  level, then by the grouping key, so the output order is deterministic
 *  for any input ordering. */
function groupIntoLevels(
  steps: readonly DescribableStep[],
  groupBy: 'step_order' | 'parallel_group',
): DescribableStep[][] {
  const buckets = new Map<number, DescribableStep[]>();
  steps.forEach((s, index) => {
    const raw = groupBy === 'parallel_group' ? s.parallel_group : s.step_order;
    // A missing key degrades to per-step levels (sequential), which is the
    // conservative reading — it never claims concurrency that isn't there.
    const key = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1_000_000 + index;
    const list = buckets.get(key);
    if (list) list.push(s);
    else buckets.set(key, [s]);
  });
  const entries = Array.from(buckets.entries());
  const minOrder = (list: DescribableStep[]) =>
    list.reduce(
      (m, s) =>
        Math.min(m, typeof s.step_order === 'number' ? s.step_order : Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
  entries.sort((a, b) => {
    const d = minOrder(a[1]) - minOrder(b[1]);
    return d !== 0 ? d : a[0] - b[0];
  });
  for (const [, list] of entries) {
    list.sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));
  }
  return entries.map(([, list]) => list);
}

/** "A and B" / "A, B and C". Uses its own keys rather than the sentence.*
 *  join_* pair, which is the "or" form. */
export function joinAnd(values: readonly string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2)
    return t('policy_editor.describe.join_and_two', { a: values[0], b: values[1] });
  return t('policy_editor.describe.join_and_many', {
    items: values.slice(0, -1).join(', '),
    last: values[values.length - 1],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// (c) findShadowedRules — pure overlap / containment detector.
// ─────────────────────────────────────────────────────────────────────────

/** Only the match dimensions that can actually decide anything. */
export interface DescribableRule {
  id: string;
  name: string;
  is_active: boolean;
  match_asset_types: readonly string[];
  match_departments: readonly string[];
  match_min_annual_cost: number | null;
  match_max_annual_cost: number | null;
  /** RETIRED per D-Q2 — leases.region is always NULL, so a rule keyed on it
   *  can never match. Read for the dead-criteria warning only; NEVER used as
   *  an overlap dimension. */
  match_regions?: readonly string[] | null;
  /** RETIRED per D-Q2 — same reasoning for leases.lease_type. */
  match_lease_types?: readonly string[] | null;
}

export interface RuleRef {
  id: string;
  name: string;
}

export type NeverFiresReason = 'shadowed' | 'retired_criteria' | 'impossible_range';

export interface RuleOverlapInfo {
  id: string;
  /** false for a paused rule — it is not checked, so neither ordering nor
   *  shadowing applies to it and it is excluded from the overlap maths. */
  evaluated: boolean;
  /** true when this rule can never route a request as authored. */
  neverFires: boolean;
  reason: NeverFiresReason | null;
  /** The earliest-checked active rule that fully covers this one. */
  shadowedBy: RuleRef | null;
  /** Active peers that can co-match the same request (both directions). */
  overlapsWith: RuleRef[];
}

export interface OverlapAnalysis {
  /** true when ANY two evaluated rules can co-match a single request. When
   *  false the list page says "None of these rules overlap, so the order
   *  doesn't change anything today" and hides ordinals entirely. */
  anyOverlap: boolean;
  /** Every co-matching pair, in list order, each pair reported once. */
  overlappingPairs: Array<{ a: RuleRef; b: RuleRef }>;
  byRuleId: Map<string, RuleOverlapInfo>;
  /** Rules that can never route anything, in list order. */
  neverFires: RuleRef[];
}

/**
 * Analyse a workspace's rules for ordering-relevance and dead rules.
 *
 * INPUT ORDER IS LOAD-BEARING: `rules` must already be in the engine's exact
 * evaluation order (priority DESC, created_at ASC, id ASC). This function
 * does NOT re-sort — it cannot, because it is not given priority or
 * created_at, and inventing an order here would be a second source of truth.
 *
 * Dimensions considered: asset type (canonically folded, exactly as the
 * engine folds it), department (exact string), annual-cost range.
 * region / lease_type are DELIBERATELY excluded (D-Q2): intake never collects
 * them, so they cannot separate two rules — they can only kill a rule
 * outright, which is reported as `reason: 'retired_criteria'`.
 */
export function findShadowedRules(rules: readonly DescribableRule[]): OverlapAnalysis {
  const byRuleId = new Map<string, RuleOverlapInfo>();
  for (const r of rules) {
    byRuleId.set(r.id, {
      id: r.id,
      evaluated: r.is_active,
      neverFires: false,
      reason: null,
      shadowedBy: null,
      overlapsWith: [],
    });
  }

  // A dead rule cannot match, cannot shadow, and cannot overlap. Flag it and
  // drop it from every downstream computation.
  for (const r of rules) {
    const info = byRuleId.get(r.id)!;
    if (usesRetiredCriteria(r)) {
      info.neverFires = true;
      info.reason = 'retired_criteria';
    } else if (hasImpossibleCostRange(r)) {
      info.neverFires = true;
      info.reason = 'impossible_range';
    }
  }

  const live = rules.filter(
    (r) => r.is_active && !byRuleId.get(r.id)!.neverFires,
  );

  // Shadowing: an EARLIER live rule that fully covers a later one.
  for (let i = 0; i < live.length; i++) {
    const later = live[i];
    for (let j = 0; j < i; j++) {
      const earlier = live[j];
      if (ruleCovers(earlier, later)) {
        const info = byRuleId.get(later.id)!;
        info.neverFires = true;
        info.reason = 'shadowed';
        info.shadowedBy = { id: earlier.id, name: earlier.name };
        break;
      }
    }
  }

  // Co-matching: does the ORDER decide anything at all today?
  const overlappingPairs: Array<{ a: RuleRef; b: RuleRef }> = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (!rulesCanCoMatch(a, b)) continue;
      overlappingPairs.push({
        a: { id: a.id, name: a.name },
        b: { id: b.id, name: b.name },
      });
      byRuleId.get(a.id)!.overlapsWith.push({ id: b.id, name: b.name });
      byRuleId.get(b.id)!.overlapsWith.push({ id: a.id, name: a.name });
    }
  }

  return {
    anyOverlap: overlappingPairs.length > 0,
    overlappingPairs,
    byRuleId,
    neverFires: rules
      .filter((r) => byRuleId.get(r.id)!.neverFires)
      .map((r) => ({ id: r.id, name: r.name })),
  };
}

/** Annual-cost domain: the engine computes `monthly_payment * 12` (0 when
 *  absent), so the reachable domain is [0, ∞). */
function costBounds(r: DescribableRule): { low: number; high: number } {
  return {
    low: r.match_min_annual_cost ?? 0,
    high: r.match_max_annual_cost ?? Number.POSITIVE_INFINITY,
  };
}

function hasImpossibleCostRange(r: DescribableRule): boolean {
  const { low, high } = costBounds(r);
  return low > high;
}

function canonSet(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    const c = canonicalAssetType(v);
    if (c) out.add(c);
  }
  return out;
}

function departmentSet(values: readonly string[]): Set<string> {
  // The engine compares departments with an exact string include(), so no
  // folding here either — matching that behaviour is the whole point.
  return new Set(values);
}

/**
 * True when EVERY request matched by `inner` is also matched by `outer` —
 * i.e. `inner` can never fire while `outer` is checked first.
 *
 * Per dimension: an empty criteria list means "any", which contains every
 * narrower list; a non-empty list contains only a non-empty subset of itself.
 */
export function ruleCovers(outer: DescribableRule, inner: DescribableRule): boolean {
  if (outer.id === inner.id) return false;

  const outerAssets = canonSet(outer.match_asset_types);
  const innerAssets = canonSet(inner.match_asset_types);
  if (outerAssets.size > 0) {
    if (innerAssets.size === 0) return false;
    for (const v of innerAssets) if (!outerAssets.has(v)) return false;
  }

  const outerDepts = departmentSet(outer.match_departments);
  const innerDepts = departmentSet(inner.match_departments);
  if (outerDepts.size > 0) {
    if (innerDepts.size === 0) return false;
    for (const v of innerDepts) if (!outerDepts.has(v)) return false;
  }

  const o = costBounds(outer);
  const i = costBounds(inner);
  if (o.low > i.low) return false;
  if (o.high < i.high) return false;

  return true;
}

/** True when at least one request exists that BOTH rules match — the only
 *  situation in which their relative order changes an outcome. */
export function rulesCanCoMatch(a: DescribableRule, b: DescribableRule): boolean {
  if (a.id === b.id) return false;

  const aAssets = canonSet(a.match_asset_types);
  const bAssets = canonSet(b.match_asset_types);
  if (aAssets.size > 0 && bAssets.size > 0) {
    let hit = false;
    for (const v of aAssets) if (bAssets.has(v)) { hit = true; break; }
    if (!hit) return false;
  }

  const aDepts = departmentSet(a.match_departments);
  const bDepts = departmentSet(b.match_departments);
  if (aDepts.size > 0 && bDepts.size > 0) {
    let hit = false;
    for (const v of aDepts) if (bDepts.has(v)) { hit = true; break; }
    if (!hit) return false;
  }

  const ab = costBounds(a);
  const bb = costBounds(b);
  if (Math.max(ab.low, bb.low) > Math.min(ab.high, bb.high)) return false;

  return true;
}

/**
 * The ONE status line under "How requests are routed". When no two checked
 * rules can co-match, ordering decides nothing and the caller also hides the
 * ordinal gutter entirely (`anyOverlap === false`).
 */
export function describeOverlapStatus(analysis: OverlapAnalysis): string {
  const pair = analysis.overlappingPairs[0];
  if (!pair) return t('policy_editor.describe.no_overlap');
  return t('policy_editor.describe.overlap_pair', { a: pair.a.name, b: pair.b.name });
}

/**
 * The row-level "this rule will never be used" line, whatever the cause —
 * so all four causes speak one vocabulary and none of them can be silent.
 * Returns null for a rule that can fire.
 */
export function describeNeverFires(
  info: RuleOverlapInfo,
  rule: Pick<DescribableRule, 'match_regions' | 'match_lease_types'>,
): string | null {
  if (!info.neverFires) return null;
  switch (info.reason) {
    case 'retired_criteria':
      return describeRetiredCriteria(rule).warning;
    case 'impossible_range':
      return t('policy_editor.describe.impossible_range_warning');
    case 'shadowed':
      return info.shadowedBy
        ? t('policy_editor.describe.shadowed_warning', { name: info.shadowedBy.name })
        : null;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// (d) Retired criteria (D-Q2) — region / lease_type are authored but dead.
// ─────────────────────────────────────────────────────────────────────────

export type RetiredDimension = 'region' | 'lease_type';

export interface RetiredCriteriaReport {
  /** true when the rule can never match BECAUSE of a retired dimension. */
  usesRetiredCriteria: boolean;
  /** Which retired dimensions are populated, in display order. */
  dimensions: RetiredDimension[];
  /** The authored values, preserved verbatim for read-only display —
   *  D-Q2 forbids destroying them. */
  regions: string[];
  leaseTypes: string[];
  /** The row warning, already localized. null when there is nothing to say. */
  warning: string | null;
}

/**
 * D-Q2: intake never collects region or lease type — LeaseRequestForm writes
 * only asset_type + requesting_department — so leases.region and
 * leases.lease_type are always NULL and any rule keyed on them can never
 * match. The authored values are NOT destroyed; they become read-only with
 * this warning plus a one-click removal.
 *
 * A criteria list containing the empty string is NOT dead (the engine's
 * `includes(region ?? "")` would match a NULL lease), so it is excluded
 * from the dead set. That case cannot be authored through the UI, but the
 * detector must not claim a rule is dead when the engine would fire it.
 */
export function describeRetiredCriteria(
  rule: Pick<DescribableRule, 'match_regions' | 'match_lease_types'>,
): RetiredCriteriaReport {
  const regions = (rule.match_regions ?? []).filter((v) => typeof v === 'string');
  const leaseTypes = (rule.match_lease_types ?? []).filter((v) => typeof v === 'string');
  const dimensions = retiredDimensions(rule);
  const regionDead = dimensions.includes('region');
  const leaseTypeDead = dimensions.includes('lease_type');

  let warning: string | null = null;
  if (regionDead && leaseTypeDead) {
    warning = t('policy_editor.describe.retired_both_warning');
  } else if (regionDead) {
    warning = t('policy_editor.describe.retired_region_warning');
  } else if (leaseTypeDead) {
    warning = t('policy_editor.describe.retired_lease_type_warning');
  }

  return {
    usesRetiredCriteria: dimensions.length > 0,
    dimensions,
    regions: [...regions],
    leaseTypes: [...leaseTypes],
    warning,
  };
}

/**
 * Which retired dimensions make this rule unmatchable. Translation-free on
 * purpose — findShadowedRules is a maths pass and must not depend on i18n
 * being initialized.
 */
export function retiredDimensions(
  rule: Pick<DescribableRule, 'match_regions' | 'match_lease_types'>,
): RetiredDimension[] {
  const regions = (rule.match_regions ?? []).filter((v) => typeof v === 'string');
  const leaseTypes = (rule.match_lease_types ?? []).filter((v) => typeof v === 'string');
  const out: RetiredDimension[] = [];
  if (regions.length > 0 && !regions.includes('')) out.push('region');
  if (leaseTypes.length > 0 && !leaseTypes.includes('')) out.push('lease_type');
  return out;
}

/** Convenience predicate used by findShadowedRules. Translation-free. */
export function usesRetiredCriteria(
  rule: Pick<DescribableRule, 'match_regions' | 'match_lease_types'>,
): boolean {
  return retiredDimensions(rule).length > 0;
}
