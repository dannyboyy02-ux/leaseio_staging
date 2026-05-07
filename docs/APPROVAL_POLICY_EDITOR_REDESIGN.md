# LeaseIO — Approval Policy Editor UX Redesign

**Status:** Spec defined. Implementation in three sub-phases (P1.1, P1.2, P1.3).
**Owner:** Daniel
**Audience:** Claude Code, future contributors
**Related:** `docs/APPROVAL_ROUTING_ARCHITECTURE.md` (architecture source of truth — unchanged by this work)

This document is the source of truth for the UX of LeaseIO's approval policy editor. It covers what is changing on the surface, what must NOT change underneath, and how Claude Code should approach the work across sessions.

---

## Why this exists

The original policy editor (shipped in P1) exposes the database schema directly to the user. Field labels echo column names — `match_min_annual_cost`, `parallel_group`, `is_default_fallback`, `separation_of_duties` — and the two-stage approval flow renders as two visually identical card sections. Non-technical admins cannot decode it.

The redesign reskins this surface to read like plain English. **No schema changes. No resolver changes. No change to snapshot semantics.** The data layer stays exactly as defined in `APPROVAL_ROUTING_ARCHITECTURE.md`.

---

## Design principles

Drawn from market research on the highest-rated approval workflow tools (Kissflow, altaFlow, Zite, Workfront, Pipefy) and from the most common complaints about the lower-rated ones (Coupa, Nintex, Workday Spend):

1. **Rule-as-sentence.** Match conditions render as one editable English sentence with each variable shown as a colored pill. The user reads the rule top to bottom and clicks any pill to change a value.
2. **Visual chain.** The approval chain renders as a top-to-bottom diagram. Approvers in the same step appear side-by-side with a literal "AND at the same time" label between them. The numeric `parallel_group` field disappears from the UI entirely.
3. **Named stages.** "Concept approval chain" becomes "Step 1: Get the green light — before any paperwork starts." "Signator approval chain" becomes "Step 2: Sign the deal — after negotiation is done." The enum values stay; the screen stops parroting them.
4. **Progressive disclosure.** Priority, separation-of-duties override, and the fallback flag collapse into a single "Advanced settings (most people don't need to change these)" expander at the bottom. They remain configurable; they stop greeting first-time admins.
5. **Test prominently.** The existing `ApprovalPolicyTestDialog` is promoted from a buried button to a primary action ("Try it on a sample request") next to Save.

---

## Label translation table

The minimum-viable swap. Each is a copy-only change in the existing form — no structural rework required:

| Current label | New label |
|---|---|
| Approval policy | Approval rule |
| Matching criteria | When does this rule apply? |
| Concept approval chain | Step 1: Get the green light |
| Signator approval chain | Step 2: Sign the deal |
| Separation of duties | Can the same person fill multiple roles? |
| Default fallback | Use this rule when no other rule fits |
| Priority | (move to Advanced) When two rules fit, which wins? |
| Step order | (delete field — drag/position implies it) |
| Parallel group | (delete field — side-by-side rendering implies it) |
| Approver type: Specific user / Functional role | A specific person / Anyone with a role |
| Delegate | Backup approver |
| Delegate after N days | Backup approver if no answer in [N] days |

---

## What does NOT change

These are off-limits for this redesign:

- **Schema.** `approval_policies`, `approval_chain_steps`, `lease_approval_chain`, and all related columns stay exactly as specified in `APPROVAL_ROUTING_ARCHITECTURE.md`.
- **Resolver logic.** `src/lib/approvalRouting.ts` and `src/lib/approvalChainLogic.ts` are not touched.
- **Snapshot semantics.** When a lease is submitted, the resolved chain is written to `lease_approval_chain` with the policy version. UI changes must not affect resolution timing.
- **Validation rules.** `src/pages/settings/approvalPolicyValidation.ts` continues to enforce: exactly one default-fallback policy per workspace, `approver_user_id XOR approver_role` (never both, never neither), step ordering integrity. Error messages may be re-worded to match the new UI copy, but the rules are untouched.
- **Aligned constants.** `ASSET_TYPE_OPTIONS` and `LEASE_TYPE_OPTIONS` in `ApprovalPolicyEditPage.tsx` must stay aligned with the `leases.asset_type` and `leases.lease_type` CHECK constraints. `FUNCTIONAL_ROLE_OPTIONS` must stay aligned with `workspace_roles`.

---

## Phased rollout

**P1.1 — Copy refresh** *(low risk, ship first)*
- Apply the label translation table above
- Collapse priority, fallback, and SoD-override into an Advanced expander
- Promote the test dialog to a primary action
- No new components. Single PR scope.

**P1.2 — Sentence-style matching criteria** *(medium)*
- Replace the body of the "Matching criteria" card with a sentence-builder component
- Each filled criterion renders as a clickable pill; empty criteria appear as a "+ Add filter" affordance
- All existing form fields (`match_asset_types`, `match_lease_types`, `match_departments`, `match_regions`, `match_min_annual_cost`, `match_max_annual_cost`) feed the same state shape — no validation changes needed
- New component: `<MatchCriteriaSentence />` co-located with the page

**P1.3 — Visual chain editor** *(largest, ship last)*
- Replace the `ChainEditor` body with a vertical step diagram
- Steps with the same `parallel_group` render side-by-side with an "AND at the same time" connector
- Reordering happens via drag handles on each step card; `step_order` updates derive from drag position
- Adding/removing steps in the same parallel group happens via "+ Add another approver to this step"
- New components: `<ChainDiagram />`, `<ParallelStepRow />`, `<ApproverCard />`

---

## File map

**Edit:**
- `src/pages/settings/ApprovalPolicyEditPage.tsx` — primary surface for all three phases
- `src/pages/settings/ApprovalPoliciesListPage.tsx` — copy refresh in P1.1 (rename "Policy" → "Rule" in headers, empty states, action labels)

**Reference only (do not modify):**
- `src/lib/approvalRouting.ts`
- `src/lib/approvalChainLogic.ts`
- `src/lib/__tests__/approvalChainLogic.test.ts`
- `supabase/migrations/*` (no migrations in this work)

**Re-use:**
- `src/components/settings/ApprovalPolicyTestDialog.tsx` — surface more prominently, do not change its internals

---

## Always check for (specific to this work)

When working on any file in this redesign, Claude Code should flag:

- Any change that alters the shape of data sent to `supabase.from('approval_policies').upsert(...)` or `supabase.from('approval_chain_steps').upsert(...)` — the wire format must remain identical
- Removal of the `approver_user_id XOR approver_role` check in form submission
- Any UI change that would let an admin save a policy with zero chain steps in either stage
- Hardcoded role strings that should be reading from `FUNCTIONAL_ROLE_OPTIONS`
- Hardcoded asset/lease type strings that should be reading from the constants
- New strings introduced for user-facing copy that don't match the translation table above
- Loss of the "exactly one default fallback per workspace" validation
- Any drift in `approvalPolicyValidation.ts` rules beyond message wording

---

## Open design questions

These do not block P1.1 but should be resolved before P1.3:

- Mobile layout for side-by-side parallel approvers — stacked with explicit "+ at the same time" labels?
- Approver picker behavior when workspace has 50+ members — search? typeahead? grouping?
- Drag-to-reorder library choice for sequential steps — `@dnd-kit/core` is the closest fit to existing dependencies
- Empty state for the chain editor — should it pre-fill one blank step, or show a guided "Add the first approver" call to action?

---

## Reference: market patterns this redesign borrows from

For Claude Code or future contributors who want context on why these specific moves:

- **Kissflow** — plain-language condition builder ("If amount is greater than $10,000…"). The most cited UX strength in 2025/2026 reviews.
- **altaFlow** — visible parallel/sequential distinction in the builder canvas. Reviewers consistently call out that they "saw" the structure for the first time.
- **Zite** — flowchart-as-builder; the chain IS the editor.
- **Workfront** — named stages mapped to business semantics, not engineering enums.
- **Coupa, Nintex, Workday Spend** — high-revenue tools whose approval-setup UIs are repeatedly described as "convoluted", "many redundant pages", "unintuitive". They are the cautionary baseline.
