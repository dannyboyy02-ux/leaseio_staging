# Approval Setup UX Review — Admin Experience of Configuring Approvals

**Scope:** `src/pages/settings/{ApprovalPoliciesListPage,ApprovalPolicyEditPage,ChainDiagram,MatchCriteriaSentence}.tsx`, `approvalPolicyValidation.ts`, the legacy role-assignment UI in `WorkspaceSettings.tsx`, the resolution engine (`supabase/functions/resolve-approval-chain/index.ts`, `src/lib/approvalChainLogic.ts`), and the docs (`APPROVAL_POLICY_EDITOR_REDESIGN.md`, `APPROVAL_POLICY_EDITOR_VISUAL_CONTRACT.md`, `PHASE_1_BUILD_SPEC.md`, `APPROVAL_ROUTING_ARCHITECTURE.md`).

**Method:** Read every file above end-to-end; walked the "first policy from scratch" flow as an SMB finance admin; traced every editor concept to its runtime consumer in the resolver/act-on-chain-step; verified all claims against code, not docs.

---

## 1. Executive summary

The redesigned policy editor (P1.1–P1.3) is genuinely good UI *craft* — the sentence-pill matcher, the seeded empty slots, and the person-card chain are all implemented per the visual contract. But the *setup system around it* is where the owner's "overly complicated" instinct is correct, and the review found something worse than complexity: **the editor's flagship "AND at the same time" parallel primitive writes data the runtime engine interprets as sequential** (§3.1), **the editor offers a "Signatory" role that no UI can assign to anyone** (§3.2), and **activating a first narrow rule silently breaks lease submission for every non-matching request** (§3.3). The one safety tool — "Try it on a sample request" — disagrees with the live resolver on exactly the failure modes that matter (§3.4).

None of this requires a rebuild. The engine (policy matching → chain snapshot → frontier advancement) is sound and well-tested. The fixes are: one encoding bug, a template/seeding layer on top of the existing schema, and guardrail warnings in the editor.

---

## 2. The walk: creating a first policy from scratch

### 2.1 Getting there (5 clicks before the form)

1. Sidebar → **Settings** → lands on account settings.
2. → **Workspaces** rail (`WorkspacesSection.tsx:65` exposes the `approval_policies` section, admin-only).
3. → **Approval Rules** rail item → renders a card whose *only content is a link-out button* — "Open Approval Rules" (`WorkspaceSettings.tsx:952-976`). This tab is a pure hop; it renders no rules.
4. → **Open Approval Rules** → `/app/settings/approval-policies` list page.
5. → **New rule** (`ApprovalPoliciesListPage.tsx:247-253`).

The link-out hop at step 3-4 exists because "Settings sub-routes aren't exposed by the main sidebar" (`WorkspaceSettings.tsx:949-951`) — but it costs a click and a full page context switch every time, and it shares the tab with "Review Thresholds," a setting that is **silently ignored the moment any rule is active** (§3.6).

### 2.2 First visit with zero policies

Empty state is two lines: *"No approval rules yet. Click **New rule** to define the first one."* (`ApprovalPoliciesListPage.tsx:263-269`). No template, no preset, no explanation that:

- The workspace is currently running the **legacy path** (manager_approver + financial_approver from `workspace_roles`, configured in a *different* tab) — `resolve-approval-chain/index.ts:1096-1157`.
- Creating and activating a rule **switches the whole workspace off that path** (`matchPolicy`, `resolve-approval-chain/index.ts:336`: legacy only when zero *active* policies).
- A rule with criteria and no fallback will hard-fail non-matching submissions (§3.3).

**No default policy is seeded at workspace creation.** `create_workspace_locked` (`supabase/migrations/20260609120000_workspace_management_phase1.sql:192-208`) creates the workspace, the owner's admin membership row, and audit rows — no `approval_policies` insert exists anywhere in workspace creation or onboarding. New workspaces run the legacy path. The Dashboard onboarding checklist (`OnboardingChecklist.tsx:40-44,119-127`) points admins at the **legacy** roles ("Assign manager and financial approvers in Workspaces → Members"), never at Approval Rules.

### 2.3 Concept inventory (what the admin must parse)

Visible or one expander away on the edit page (`ApprovalPolicyEditPage.tsx`):

| # | Concept | Default | Where | Required decision? |
|---|---|---|---|---|
| 1 | Name | empty | Card 1 | **Yes** (validated) |
| 2 | Description | empty | Card 1 | No |
| 3 | Active toggle | ON | Card 1 | No (but consequential — §3.3) |
| 4 | 6 match dimensions in 4 pills (asset types + lease types share one pill) | all "any" | Card 2 | No |
| 5 | Concept stage: ≥1 approver | 1 empty slot | Card 3 | **Yes** (validated) |
| 6 | Signator stage: ≥1 approver | 1 empty slot | Card 3 | **Yes** (validated — cannot make a one-stage rule) |
| 7 | Role-vs-person per slot (5 roles incl. Submitter/Admin) | — | picker | **Yes** per slot |
| 8 | Sequential steps vs parallel approvers | — | two different "+" links | No |
| 9 | Backup approver + forward-after-days | none / 3 | per-card menu | No |
| 10 | Required vs optional per step | required | per-card menu | No |
| 11 | Priority ("When two rules fit, which wins?") | 100 | Advanced | No (but ties hard-fail — §3.3) |
| 12 | Approval SLA days | 7 | Advanced | No |
| 13 | Default fallback flag | OFF | Advanced | No (but critical — §3.3) |
| 14 | SoD 3-way override (+ workspace default toggle on the list page) | inherit (ws default ON) | Advanced | No (but blocks small teams — §4.2) |
| 15 | Version | auto (trigger) | hidden | No — correctly hidden ✔ |

~13 user-facing concepts. Minimal happy path ("Alice approves, Bob signs"): 1 typed field + 4 picker clicks + Save = **6 interactions in the editor, ~11 total from the sidebar** — *if nothing goes wrong*. Progressive disclosure is real (priority/fallback/SoD/SLA are collapsed, per the redesign spec) and the seeded empty slots per visual-contract §4 work as intended. The interaction count is not the problem. The problem is the **invisible semantics** — what active/priority/fallback/roles *do* at runtime is never explained where the decision is made, and several of them detonate later at submission time in the requestor's face, not the admin's.

---

## 3. Findings — functional gaps (code-verified)

### 3.1 HIGH — "AND at the same time" writes data the engine runs sequentially

The runtime engine defines parallelism by **`step_order`**, not `parallel_group`:

- `findFirstPendingAssignees` (`src/lib/approvalChainLogic.ts:111-128`): next batch = all pending steps at the **lowest `step_order`**. `parallel_group` is never consulted.
- `advancedPastStepOrder` (`approvalChainLogic.ts:140-153`) and the #111 frontier predicate (`approvalChainLogic.ts:433-471`, mirroring migration `20260618150000`): "parallel = same stage + same step_order are co-active".
- `docs/APPROVAL_ROUTING_ARCHITECTURE.md:150` confirms: "`parallel_group` (int — same group within same step_order = parallel)".
- `act-on-chain-step/index.ts:589-617` uses these helpers to decide who gets notified next; `resolve-approval-chain/index.ts:1275-1302` copies `step_order`/`parallel_group` verbatim from policy steps into `lease_approval_chain`, and sets `pending_since` only on the lowest `step_order` (lines 1269-1301).

The redesigned editor encodes the opposite convention:

- `addParallelApprover` (`ChainDiagram.tsx:145-151`): a "parallel" co-approver gets **`step_order = maxOrder + 1`** (a new, distinct order) with the same `parallel_group`.
- `reorderGroups` (`ChainDiagram.tsx:153-168`): any drag renumbers `step_order` sequentially 1..N **through** parallel groups, so even a correctly-encoded chain (same step_order) is corrupted by one drag.
- `groupByParallel` (`ChainDiagram.tsx:125-137`) renders by `parallel_group` — so a chain correctly encoded per the architecture doc (same step_order, different groups) renders as **sequential** rows in the editor. Broken in both directions.

**Runtime consequence for a rule authored as "A AND B at the same time, then C":** stored as A(order 1), B(order 2), C(order 3). Only A is notified at submission; B's notification and `pending_since`/SLA clock start only after A approves; the step badge shows "Step 2" for B. Both must still approve (stage completion is per-required-step, `approvalChainLogic.ts:95-99`) and B *can* act early via the queue (which lists all pending steps, `ApprovalQueue.tsx:684-712`), so nothing is lost — but notifications, SLA timers, stuck-detection, and the queue's "Step N" labels all behave sequentially, directly contradicting the editor's one flagship visual claim.

The unit tests don't catch this because `chainDiagram.test.ts:65-120` tests **hand-copied mirrors** of the helpers, not the exports (`ChainDiagram.tsx:96` says "exported for vitest" — the test file never imports them), and no test crosses from editor encoding to engine interpretation.

**Fix (small):** `addParallelApprover` should reuse the row's existing `step_order` and allocate a new `parallel_group`; `reorderGroups` should assign one order per *group* (all steps in a group share it). Validation (`approvalPolicyValidation.ts:86-89`) already keys uniqueness on the `(parallel_group, step_order)` pair, so same-order/different-group passes today. A one-time data check for existing policies with multi-step groups is warranted.

### 3.2 HIGH — "Anyone with role: Signatory" is offered but unassignable; role steps with zero holders stall silently

The approver picker offers 5 roles (`ChainDiagram.tsx:56-66`), including `signator`. But the only UI that writes `workspace_roles` (`WorkspaceSettings.tsx:596-600` slots for `manager_approver`/`financial_approver`; `WorkspaceSettings.tsx:715` checkboxes limited to `(['submitter','admin'] as const)`) **never assigns `signator`**. Nothing else in `src/` writes that role.

A rule using "Anyone with role: Signatory" therefore resolves to a chain step that:
- notifies nobody (`notifyRoleHolders` silently no-ops with zero holders, `src/lib/leaseNotifications.ts:79`);
- appears in nobody's queue (`ApprovalQueue.tsx:701-706` matches on roles the user actually holds);
- can only be acted on by owner/admin override (`act-on-chain-step/index.ts:322-351`).

The lease stalls in review with no signal to anyone. The editor never validates that a chosen role has ≥1 holder, and the test dialog doesn't warn either (the Phase-1 spec promised "Warnings: any deactivated assignees" — `docs/PHASE_1_BUILD_SPEC.md:301` — never built). Same trap applies to any role emptied by later membership changes. Also: offering **Submitter** and **Admin** as approver roles is schema-legal noise for an SMB admin ("anyone with role Submitter approves"?) and undermines the separation-of-duties story.

### 3.3 CRITICAL — First-rule / priority-tie traps block core submission with no setup-time warning

`matchPolicy` (`resolve-approval-chain/index.ts:325-363`):

- Zero **active** policies → legacy path (submission succeeds via workspace_roles).
- ≥1 active policy, none matches, no fallback → **409 `no_match_no_fallback`** — submission fails, lease stays in draft, requestor sees "No matching policy and no default fallback configured. Ask an admin…" (`index.ts:1174-1188`; toast path `LeaseRequestForm.tsx:344-369`, `leaseSubmissionDecision.ts`).
- Two matching policies tied at top priority → **409 `ambiguous_match`** (`index.ts:353-358`).

Combined with the editor's defaults this is a trap on the natural path: a workspace running happily on legacy → admin creates ONE rule scoped to, say, Real Estate (Active defaults ON, `ApprovalPolicyEditPage.tsx:58-72`; fallback defaults OFF and is buried in Advanced) → **every equipment/vehicle request in the workspace now hard-fails at submission**. The person who sees the error is the warehouse requestor, not the admin who caused it. Similarly, every rule defaults to priority 100 (hidden in Advanced), so the second rule an admin creates ties the first — any request matching both is blocked outright. `duplicate()` copies the priority verbatim (`ApprovalPoliciesListPage.tsx:140-157`), making a tie the *default outcome* of Duplicate → activate.

Nothing in the list page or editor warns about: no fallback existing, a new rule tying an existing priority, or the legacy→rules switchover. The list-page copy actually misstates the semantics: "the first rule whose conditions all match a new request wins" (`ApprovalPoliciesListPage.tsx:237-240`) — priority wins, and ties don't pick the first, they fail the submission.

### 3.4 HIGH — The "Try it on a sample request" tool disagrees with the live resolver

`preview_policy_resolution` (`supabase/migrations/20260516120000_baseline_schema.sql:632-644`) does `ORDER BY priority DESC, created_at ASC LIMIT 1` — **no ambiguity detection**. The live resolver 409s on ties. So the test tool says "matched: Rule A" for exactly the configuration that will fail real submissions. It also:

- reports "No matching policy and no default fallback configured" as a failure for **zero-policy** workspaces, where real submission *succeeds* via legacy (`resolve-approval-chain/index.ts:1096-1157`) — telling a not-yet-configured admin that submissions are broken when they aren't;
- performs no SoD check (live resolver 409s `separation_violation`, `index.ts:1245-1263`);
- implements none of the spec-promised warnings (deactivated assignees, ambiguous matches, missing fallback — `PHASE_1_BUILD_SPEC.md:301`);
- renders approvers as truncated raw UUIDs — "User a1b2c3d4…" (`ApprovalPolicyTestDialog.tsx:261-263`) — where the spec required resolved names (`PHASE_1_BUILD_SPEC.md:299`), and leaks schema vocabulary "Step {n} · group {g}" (`ApprovalPolicyTestDialog.tsx:255-258`) that the redesign explicitly banished from the UI (`APPROVAL_POLICY_EDITOR_REDESIGN.md:25`).

The redesign promoted this dialog to a primary action; as built it is the least trustworthy surface in the flow.

### 3.5 HIGH — Non-atomic save can strand an ACTIVE zero-step rule that 409s submissions

Save is two sequential calls: insert/update `approval_policies`, then `apply_policy_steps` RPC (`ApprovalPolicyEditPage.tsx:269-294`). If the RPC fails (network, session expiry), the policy row persists — active (default ON), possibly matching everything (default criteria = match all) — with zero steps. The resolver treats a matched zero-step policy as a hard 409 (`policy_has_no_steps`, `resolve-approval-chain/index.ts:1215-1230`), so the orphan captures and fails every submission it matches. The error toast ("Save failed") gives the admin no hint a broken active rule now exists.

### 3.6 MEDIUM/HIGH — Three rival configuration surfaces, precedence undocumented anywhere in UI

1. **Approval Rules** (policies) — wins whenever ≥1 active policy exists.
2. **Users tab → "Approval Chain"** card (`WorkspaceSettings.tsx:578-673`: "Step 1 Manager Approval / Step 2 Financial Approval" slots writing `workspace_roles`) — the legacy path; also the surface the onboarding checklist points to; ALSO the only place the policy editor's role-based steps get their holders.
3. **Review Thresholds** (`approval_threshold`, `WorkspaceSettings.tsx:982+`) — sits on the *same tab* as the Approval Rules link, but is consumed **only** by the legacy path (`resolve-approval-chain/index.ts:1117`, `legacy-lease-action/index.ts:309-313`); ignored the moment a rule is active.

No surface mentions any other. An admin can configure all three and cannot tell which is live. The "Approval Chain" card's copy ("Lease requests flow through Manager Approval first, then Financial Approval before execution") is simply false once a rule exists.

### 3.7 MEDIUM — Two of six match dimensions can never match a Path-1 submission

The resolver matches on live lease attributes (`resolve-approval-chain/index.ts:313-322`). `LeaseRequestForm.tsx:277-306` never writes `region` or `lease_type` (region isn't even a form field; `lease_type` is populated later by AI extraction). So `match_regions` and `match_lease_types` criteria **always fail** at request submission → rule falls through (or 409s). The editor's sentence proudly offers "located in [any region]" and a lease-type pill anyway (`MatchCriteriaSentence.tsx:139-197`). Related: department matching is exact, case-sensitive string equality between two free-text inputs (rule chips `MatchCriteriaSentence.tsx:371-447` vs the requestor's free-text Input `LeaseRequestForm.tsx:577`) — "ops" ≠ "Operations", despite `workspace department_options` existing to standardize both sides.

### 3.8 MEDIUM — Cost-based routing keys on an optional, requestor-supplied field

Annual cost = `monthly_payment * 12`, else **0** (`resolve-approval-chain/index.ts:320-322`). The form labels monthly payment "(AI will extract from document)" (`LeaseRequestForm.tsx:598-601`), inviting blank. A blank payment routes a $500k lease through the under-threshold chain. Phase-6 reroute-on-change mitigates *after* AI extracts real numbers, but initial concept approval can complete on the cheap chain first.

---

## 4. UX issues (friction/confusion, code-verified)

### 4.1 Validation is a single toast at save; server errors are raw

`validatePolicy` returns only the **first** error, surfaced as a toast (`ApprovalPolicyEditPage.tsx:223-229`); nothing is highlighted inline. Server-side fallback-uniqueness violations surface the raw Postgres message (`toast.error(error.message)` — `ApprovalPoliciesListPage.tsx:123-127`, `ApprovalPolicyEditPage.tsx:298-299`): the admin toggling a second fallback active reads `duplicate key value violates unique constraint "idx_approval_policies_one_default_per_workspace"`. The spec's rule 10 (client-side pre-check, `PHASE_1_BUILD_SPEC.md:462`) was never implemented.

### 4.2 SoD default ON blocks the smallest customers with a cryptic dead-end

`separation_of_duties_default` is `true` (`baseline_schema.sql:1896`; both readers default null→true). A solo owner or 2-person shop building "I approve, I sign" — the single most likely first rule for the target SMB — is blocked at save with *"Separation of duties is required, but the same user appears in multiple steps."* (`approvalPolicyValidation.ts:96-105`). The fix (Advanced → "Allow the same person in multiple roles") is never pointed to. Runtime enforces the same 409 (`resolve-approval-chain/index.ts:1245-1263`), so even role-based dodges fail later.

### 4.3 SoD switch polarity is inverted relative to its own label

List-page card asks "**Can** the same person fill multiple roles?" but the switch ON means "distinct users required" — i.e., ON answers the title question with **No** (`ApprovalPoliciesListPage.tsx:213-227`). The edit page repeats the pattern (`ApprovalPolicyEditPage.tsx:506-530`).

### 4.4 Asset type vs lease type — one pill, two overlapping taxonomies

The first pill's popover shows "Asset types" (Property (Real Estate)/Equipment/Vehicle/Other) *and* "Lease types" (Real Estate/Equipment) with no explanation (`MatchCriteriaSentence.tsx:20-27,282-315`). "Real Estate" and "Equipment" appear twice with different matching targets, one of which never matches at submission (§3.7).

### 4.5 Archive is a synonym for the Active toggle; Delete does not exist

`archive()` = `window.confirm` + `toggleActive(false)` (`ApprovalPoliciesListPage.tsx:186-189`) — identical to flipping the adjacent switch, but presented as a distinct destructive action with a trash-adjacent icon. There is no delete anywhere, though Phase-1 goal #1 promises "create, edit, archive, and **delete**" (`PHASE_1_BUILD_SPEC.md:13`). Deactivated rules pile up at 60% opacity forever. `window.confirm` is off-pattern for the app (AlertDialog elsewhere).

### 4.6 Duplicate silently drops settings

`duplicate()` copies name/criteria/priority/steps but **omits `separation_of_duties_override` and `sla_days`** (`ApprovalPoliciesListPage.tsx:140-157` vs the full payload at `ApprovalPolicyEditPage.tsx:246-265`). A copy of a "allow same user, 3-day SLA" rule reverts to inherit/7-days with no notice.

### 4.7 Whole surface is untranslated

Every string across all five files is hardcoded English except one back-link key. `es/common.json` has no keys for this surface (grep "approval" → 10 hits, none editor-related). CLAUDE.md mandates en+es updated together.

### 4.8 Priority input quirk

`parseInt(e.target.value || '0', 10)` (`ApprovalPolicyEditPage.tsx:467`) — clearing the field sets priority 0, failing validation with "Priority must be a positive integer" for an input the admin was told most people don't touch.

---

## 5. Docs drift (docs claim ≠ code)

| Claim | Reality |
|---|---|
| REDESIGN.md:60 — validation "continues to enforce: exactly one default-fallback policy per workspace" | No such check exists in `approvalPolicyValidation.ts` (never did); only the DB partial index, surfaced as a raw error. |
| PHASE_1_BUILD_SPEC.md:274 — "Steps with the same parallel group number act in parallel" | Engine parallelism keys on `step_order` (`approvalChainLogic.ts:111-128`; ARCHITECTURE.md:150). The redesigned editor implements the spec's wrong sentence, not the engine (§3.1). |
| PHASE_1_BUILD_SPEC.md:299-301 — test dialog shows "approver name (resolved…)" + warnings for deactivated assignees/ambiguous matches/missing fallback | Dialog shows truncated UUIDs; none of the warnings exist (`ApprovalPolicyTestDialog.tsx:255-269`; `preview_policy_resolution` has no ambiguity/SoD logic). |
| REDESIGN.md:25 — "the numeric `parallel_group` field disappears from the UI entirely" | Test dialog still renders "Step N · group N" (`ApprovalPolicyTestDialog.tsx:255-258`). |
| PHASE_1_BUILD_SPEC.md:13 — admins can "archive, and delete" policies | Delete is unbuilt; archive is deactivate (§4.5). |
| CLAUDE.md (Approval routing) — policies are "replacing the legacy fixed … model" | Legacy remains the default for every new workspace, the onboarding-recommended path, and the only holder-assignment surface for role-based steps. ARCHITECTURE.md:271 states the fallback correctly. |

---

## 6. What is genuinely good (keep)

- Seeded empty slots + always-rendered sentence — the visual scaffolding works (`ApprovalPolicyEditPage.tsx:86-95`, `MatchCriteriaSentence.tsx:131-198`).
- Progressive disclosure of priority/fallback/SoD/SLA into Advanced matches the redesign spec.
- Atomic step replacement via `apply_policy_steps` with server-side auth (`baseline_schema.sql`), RLS split read/write, version auto-increment trigger — version is correctly invisible to admins.
- The submission contract "resolver fails → lease stays draft + toast" (`LeaseRequestForm.tsx:344-369`) is the right shape; the problem is that the *admin* never sees these failures coming.
- Route guarding (admin-only, `App.tsx:362-381`), the autofill fix, dark-mode parity, mobile parallel fallback.

---

## 7. Proposed simplest setup model (keeps the existing engine 1:1)

**Principle:** the admin should pick a *shape*, not build a graph. Presets write ordinary `approval_policies` + `approval_chain_steps` rows through the existing `apply_policy_steps` RPC — no schema or resolver change.

### 7.1 Seed a fallback at first use (or workspace creation)

When the list page loads with zero policies (or in `create_workspace_locked`), offer/seed one rule:

```
approval_policies: { name: 'Default approval', is_default_fallback: true,
                     priority: 1, is_active: false, all match_* empty }
steps: concept  → { step_order: 1, parallel_group: 1, approver_role: 'manager_approver' }
       signator → { step_order: 2, parallel_group: 2, approver_role: 'financial_approver' }
```

Kept **inactive** until the admin confirms, so legacy behavior is unchanged until an explicit switch. The empty state becomes: *"Requests currently go to your Manager and Financial approvers (Team Roles). Create rules to route by amount, type, or department."* — naming the live behavior instead of hiding it.

### 7.2 Three presets + one threshold on "New rule"

Replace the blank editor as the default entry with a chooser (the blank editor remains as "Start from scratch / Advanced"):

| Preset | concept steps | signator step | policy fields |
|---|---|---|---|
| **Manager only** | role `manager_approver` (order 1) | role `manager_approver` (order 2) | `separation_of_duties_override: false` (required — ws default ON would reject the same person) |
| **Manager then CFO** | role `manager_approver` (order 1) | *person picker: one dropdown, "Who signs?"* → `approver_user_id` (order 2) | — |
| **Manager then Finance then CFO** | role `manager_approver` (order 1), role `financial_approver` (order 2) | person (order 3) | — |

Optional single field: **"Only leases above $___ need this"** → writes `match_min_annual_cost`; when set, the wizard also ensures a fallback exists (offer to make the seeded Default the fallback) so below-threshold requests don't 409. Auto-assign `priority = (max existing priority) + 10` — never let two rules tie by default.

Total first-run cost: 1 preset click + (0–1 person pick) + (0–1 dollar field) + Save = **3–4 interactions**, zero exposure to priority/fallback/SoD/stages/parallel/delegates. Every preset is a plain policy row an admin can later open in the Advanced editor.

### 7.3 Guardrails in the existing editor (cheap, high-value)

1. **Save-time warnings (non-blocking dialog):** no active fallback exists and this rule has criteria; this rule's priority ties an existing active rule; a chosen role has zero holders in `workspace_roles`; criteria use region/lease-type (cannot match at request submission today).
2. **Fix the parallel encoding** (§3.1) — same `step_order` within a group, per-group renumbering on drag.
3. **Make the save atomic** — wrap policy upsert + steps in one RPC (extend `apply_policy_steps` to take the policy payload), or at minimum insert new policies with `is_active: false` and flip active only after steps commit.
4. **Trim the role picker** to `manager_approver` / `financial_approver` / `signator` (+ build the missing signator assignment UI in Team Roles, or drop `signator` from the picker until it exists).
5. **Test dialog parity:** report ambiguity and SoD violations exactly as the live resolver does; resolve names; simulate the legacy path for zero-policy workspaces; drop "group N".
6. **One approval home:** move Team Roles' "Approval Chain" card content and Review Thresholds into the Approval Rules page with explicit state copy — "These apply only while no rules are active." The rules list gets a status banner: "Rules are ON — Team Roles / thresholds are not used."
7. Rename the list-page copy to match the engine: highest priority wins; ties are an error.

### 7.4 What NOT to do

Do not rebuild the editor paradigm (the visual contract §9 already forbids canvas/Blockly moves — agreed), and do not touch chain snapshot semantics, `lease_approval_chain`, or the resolver's matching order. Everything above is presets-writing-existing-rows plus warnings plus one encoding bugfix.

---

## 8. Recommendation priority

1. **P0 — §3.3 fallback/tie traps**: guardrail warnings + auto-priority (submission-blocking, reachable by normal admin behavior today).
2. **P0 — §3.1 parallel encoding fix** + data check on existing policies.
3. **P1 — §3.2 signator/zero-holder**: role-holder validation + assignment UI (or remove the option).
4. **P1 — §3.4 test-dialog parity** (it's the tool that should have caught 1–3 for the admin).
5. **P1 — §7.1/7.2 seeding + presets** (the owner's simplicity ask).
6. **P2 — §3.5 atomic save, §3.6 one approval home, §4.x polish, §5 doc reconciliation.**
