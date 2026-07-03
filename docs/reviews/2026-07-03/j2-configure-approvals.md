# J2 — Configure Approvals: Journey Review

**Persona:** a workspace admin trying to build the owner's ideal structure — *"warehouse staff submit; their manager approves; CFO signs; finance has visibility"* — using only what the UI offers today.

**Scope walked (code, not docs):**
`src/pages/settings/ApprovalPoliciesListPage.tsx`, `ApprovalPolicyEditPage.tsx`, `ChainDiagram.tsx`, `MatchCriteriaSentence.tsx`, `approvalPolicyValidation.ts`, `src/components/settings/ApprovalPolicyTestDialog.tsx`, `src/pages/settings/WorkspaceSettings.tsx` (roles), `src/pages/settings/WorkspacesSection.tsx` (nav), `src/lib/approvalChainLogic.ts` + Deno mirror, `supabase/functions/resolve-approval-chain/index.ts`, `supabase/functions/act-on-chain-step/index.ts`, `src/lib/leaseNotifications.ts`, `src/lib/approvalRouting.ts`, `src/components/workflow/LeaseRequestForm.tsx`, baseline schema (`supabase/migrations/20260516120000_baseline_schema.sql`: `apply_policy_steps` :74–112, `preview_policy_resolution` :613–692, `workspace_roles` CHECK :2101, fallback unique index :2447), `docs/APPROVAL_ROUTING_ARCHITECTURE.md`, `docs/APPROVAL_POLICY_EDITOR_REDESIGN.md`, `docs/APPROVAL_POLICY_EDITOR_VISUAL_CONTRACT.md`.

---

## 1. The journey, step by step

### 1.1 Getting there (5 clicks before the editor)

1. Sidebar → **Settings** (`AppSidebar.tsx:804`, single doorway → `/app/settings/account`).
2. → **Workspaces** (`/app/settings/workspaces`, second-level rail — `WorkspacesSection.tsx:57–67`).
3. Rail → **Approval Rules** (`WorkspacesSection.tsx:65`, admin-only).
4. That tab renders a *card about* approval rules with an **"Open Approval Rules"** button (`WorkspaceSettings.tsx:952–976`) — one more indirection hop.
5. `/app/settings/approval-policies` → **New rule** (`ApprovalPoliciesListPage.tsx:247–253`).

So the actual editor is 5 clicks deep, behind a signpost card whose only content is a button. The same Approval Rules tab also shows a **"Review Thresholds"** card (`WorkspaceSettings.tsx:982–1062`) whose `approval_threshold` is read **only by the legacy no-policies path** (`resolve-approval-chain/index.ts:1115–1121`; `approvalRouting.ts:37–59`) — once any active policy exists, that card silently does nothing, with no hint on the page.

### 1.2 The two rival configuration surfaces (biggest structural confusion)

Before the admin ever finds Approval Rules, the **Users** tab shows a card literally titled **"Approval Chain"** — "Assign one approver to each step. Lease requests flow through Manager Approval first, then Financial Approval" (`WorkspaceSettings.tsx:580–673`). This is the *legacy* fixed-role model:

- Step 1 slot writes `workspace_roles.role='manager_approver'`, Step 2 slot `'financial_approver'` (`WorkspaceSettings.tsx:226–240, 596–600`, saved via `set_workspace_roles` RPC :262).
- It **cannot express a signing step at all** — legacy routing is manager → financial → approved (`approvalRouting.ts:68–74`); the signator stage exists only in chain mode.
- The runtime mode switch is invisible: if the workspace has **zero active policies**, routing uses these roles (`resolve-approval-chain/index.ts:1096–1157`, `kind === "no_policies"` → legacy); the moment **one** active policy exists, the card's chain is ignored for routing. Neither surface mentions the other or the precedence rule.
- The card's warning "No Financial Approver assigned — commitments will stall after manager approval" (`WorkspaceSettings.tsx:665–672`) keeps rendering even when policies fully own routing — actively wrong advice in chain mode.

An admin pursuing the owner's ideal will naturally configure this card first (it's titled "Approval Chain" and lives next to member management), discover there is no CFO/signing slot, and only then — maybe — find the real editor two tabs away.

### 1.3 Prerequisite: functional roles — and the Signatory dead-end

The policy editor's approver picker offers **"Anyone with role: Submitter / Manager approver / Financial approver / Signatory / Admin"** (`ChainDiagram.tsx:56–66, 817–832`).

- The only UI that writes `workspace_roles` is the Users tab (`set_workspace_roles`, `WorkspaceSettings.tsx:262`), and it can assign **only** `manager_approver`, `financial_approver`, `submitter`, `admin` (:596–600, :715). The frontend `FunctionalRole` type omits `signator` entirely (`src/types/lifecycle.ts:76`) even though the DB CHECK allows it (`20260516120000_baseline_schema.sql:2101`).
- **Consequence:** a role-based "Signatory" step — the obvious choice for "CFO signs" — can never have a holder. At runtime nobody is notified (`leaseNotifications.ts:79` — `notifyRoleHolders` silently no-ops on zero holders), nobody sees it in their queue (`ApprovalQueue.tsx:703–705` matches on held roles), and only the workspace owner/admin override can act (`act-on-chain-step/index.ts:333–351`). The lease stalls silently until the stuck-chain cron flags it after 7 days.
- Nothing at save time, in the test dialog, or in `preview_policy_resolution` (baseline :613–692 — warnings array only ever gets the fallback note :662) warns that a role has no holders. `docs/APPROVAL_ROUTING_ARCHITECTURE.md:299` promises "Policy gaps, **broken assignees**, and ambiguous matches throw at the earliest possible moment" — not implemented anywhere in the editor path.

Also: the **Submitter checkbox is decorative**. No code path reads `workspace_roles.role='submitter'` to gate anything — the request form opens for any member (`Dashboard.tsx:109`, no role gate; only writers/readers of the submitter role are the settings screen itself). And "Submitter" is offered as an *approver* role in the chain picker (`ChainDiagram.tsx:61`), which would let requestors approve their own requests — SoD checks can't catch it because they only compare explicit user IDs (`approvalChainLogic.ts:75–88`; `approvalPolicyValidation.ts:96–105`).

### 1.4 The editor itself — field/decision inventory

Fields: Name, Description, Active switch (`ApprovalPolicyEditPage.tsx:335–383`); 4 match pills — lease type (4 asset checkboxes + 2 "lease type" checkboxes), department chips, cost range (2 numbers), region chips (`MatchCriteriaSentence.tsx:131–199`); two chain stages ("First, get the green light" / "Then, sign the deal", :409–441), each step carrying approver (role|person), backup person, backup days, required/optional, drag order, parallel add; Advanced (collapsed): priority number, SLA days, fallback switch, SoD 3-way radio (:444–535).

**Count to a minimal working catch-all rule:** name (1) + concept approver (2: open picker, pick person) + signator approver (2) + Create rule (1) = **6 interactions / 3 real decisions**, after 5 navigation clicks. That path genuinely works and is well-crafted (sentence pills, seeded empty slots, plain-English stage names — the #108 jargon fix landed).

**Count to the owner's ideal:** not reachable — see §2. The closest approximation (per-department rules + person-steps + optional finance step) is ~25+ interactions across 2 settings surfaces and silently mis-executes (§1.6, §2.3).

### 1.5 Validation & save

`validatePolicy` (`approvalPolicyValidation.ts:38–108`) checks: name, priority positive, cost min≤max, ≥1 approver per stage, per-step shape, duplicate (group, order), SoD duplicates (user-based only). Good baseline. What it does **not** check (all of which blow up later at runtime):

- **Priority ties.** Every new rule defaults to `priority: 100` (`ApprovalPolicyEditPage.tsx:61`); duplicate copies the source's priority (`ApprovalPoliciesListPage.tsx:146`). Two active rules matching the same request at equal priority → **submission fails with 409 "Multiple policies tied at top priority"** (`resolve-approval-chain/index.ts:353–358, 1158–1173`), lease stuck in draft (`LeaseRequestForm.tsx:357–363`). The tie surfaces to the **warehouse requestor**, not the admin. The priority field is hidden under "Advanced settings — Most admins don't need to change these" (:450–471), and its help text ("Higher number wins when multiple rules match", :470) never mentions the equal-priority failure mode.
- **Missing fallback.** With ≥1 active policy and no `is_default_fallback` rule, any non-matching request 409s at submission (`resolve-approval-chain/index.ts:360–361, 1174–1188`). So **creating your first narrow rule silently breaks every other request type in the workspace** (they previously routed via legacy roles). The fallback switch is also buried in Advanced (:489–502); the list page mentions fallback in passing (`ApprovalPoliciesListPage.tsx:237–240`) but never warns when none exists.
- **Roles with zero holders** (§1.3).
- **Second fallback:** the partial unique index (baseline :2447) rejects it and the editor surfaces the raw Postgres message via `toast.error(err?.message)` (`ApprovalPolicyEditPage.tsx:298–299`) — a finance admin gets `duplicate key value violates unique constraint "idx_approval_policies_one_default_per_workspace"`.

### 1.6 Parallel approvers — the editor and the engine disagree (worst mechanical bug found)

- Docs and UI define parallel as **same `parallel_group`**: "Approvers in the same step appear side-by-side with a literal 'AND at the same time' label" (`APPROVAL_POLICY_EDITOR_REDESIGN.md:25`, `APPROVAL_POLICY_EDITOR_VISUAL_CONTRACT.md:72–86`); architecture doc says "same group within same step_order = parallel" (`APPROVAL_ROUTING_ARCHITECTURE.md:150`).
- The runtime engine keys simultaneity on **equal `step_order`**, not group: `findFirstPendingAssignees` returns "all parallel siblings **at that step_order**" (`approvalChainLogic.ts:111–128`), `advancedPastStepOrder` (:140–153), frontier predicate "same stage + same step_order are co-active" (:441, 455–471), initial notify filter `s.step_order === firstConceptOrder` (`resolve-approval-chain/index.ts:592`), pending_since batching by min step_order (`act-on-chain-step/index.ts:624–639`).
- The editor's **"Add another approver to this step"** gives the sibling the same group but a **new, higher `step_order`** (`ChainDiagram.tsx:145–151`, `blankStep(maxOrder + 1, parallelGroup)`), and `reorderGroups` renumbers `step_order` 1..N sequentially across ALL steps (:153–168), so **the current editor can never author two steps with equal step_order**. `apply_policy_steps` stores verbatim (baseline :96–110).
- **Net effect:** approvers the admin placed "AND at the same time" execute strictly sequentially — the second sibling is not notified and cannot see pending_since until the first approves. Conversely, any pre-redesign policy that used the correct shape (equal order, distinct groups) renders in the editor as two *sequential* rows (`groupByParallel` buckets by group, :125–137) and is silently rewritten to sequential orders on next save. The test dialog leaks the truth by printing "Step 1", "Step 2" for a "parallel" pair (`ApprovalPolicyTestDialog.tsx:255–258`). The redesign doc's claim "No schema changes. **No resolver changes.** No change to snapshot semantics" (`APPROVAL_POLICY_EDITOR_REDESIGN.md:16`) is true — but the *authored data shape* changed, which is the same failure with extra steps. `chainDiagram.test.ts` never tests `addNextStep`/`addParallelApprover`, so nothing caught it.

### 1.7 Match criteria that structurally cannot match

- **"Lease types: Real Estate / Equipment"** (`MatchCriteriaSentence.tsx:27, 299–313`; also in the test dialog :34): the live `leases.lease_type` vocabulary is `'master' | 'amendment'` — written by `process_lease` classification (`process_lease/index.ts:439, 618, 731–733`). The only writer of `'Real Estate'/'Equipment'` values is `useLifecycleWorkflow.ts:26,141` — retired dead code (`App.tsx:184`: "Legacy /app/leases/new … retired"). A rule ticking these boxes **never matches anything**; matching is exact-string (`resolve-approval-chain/index.ts:345`).
- **Regions:** the Path-1 request form collects **no region** (no `region` field anywhere in `LeaseRequestForm.tsx`; insert at :275–306) — `liveAttrs.region` is null at initial resolution (`resolve-approval-chain/index.ts:317`), so `match_regions` rules never match a new request; they fall to fallback or 409. The test dialog happily accepts a typed region and shows a match, teaching the admin the rule works.
- **Departments:** matching is exact, case-sensitive string equality (`resolve-approval-chain/index.ts:341`; RPC baseline :638). But the request form's "Requesting Department" is a **free-text Input** (`LeaseRequestForm.tsx:568–582`) that ignores the workspace `department_options` list the admin curates in Lease Configuration (`WorkspaceSettings.tsx:874, 889` — whose copy even claims "Users can also type a custom value", implying options are offered somewhere; they aren't). "warehouse" vs "Warehouse" vs "Warehouse Ops" silently misroutes to the fallback. Department rules are the only way to model "their manager approves" — the load-bearing criterion is the least reliable one.
- **Annual cost:** editor/test ask for "annual cost"; runtime computes `monthly_payment * 12`, treating a blank monthly payment as 0 (`resolve-approval-chain/index.ts:320–322`). Monthly payment is optional on the form ("AI will extract from document", `LeaseRequestForm.tsx:57, 600`) — so cost-banded rules mis-bucket every request submitted without a monthly figure into the 0 band. No surface mentions this.

### 1.8 Testing the policy before it goes live

The **"Try it on a sample request"** dialog exists on both pages (`ApprovalPoliciesListPage.tsx:243–246`, `ApprovalPolicyEditPage.tsx:538–546`) and is read-only (`ApprovalPolicyTestDialog.tsx` → `preview_policy_resolution`). Genuinely good idea; four honest gaps:

1. **It cannot test drafts.** The RPC reads saved+active policies only. On the *edit* page, the button sits next to Save while you draft — the result reflects the world *without* your changes; nothing says so.
2. **Tie behavior diverges from runtime.** The RPC picks a winner via `ORDER BY priority DESC, created_at ASC LIMIT 1` (baseline :643–644) — the runtime resolver 409s on the same tie (`resolve-approval-chain/index.ts:353–358`). The admin's test says "matched ✓"; the requestor's real submission fails. Direct code-vs-code drift.
3. **User steps render as UUID prefixes** — `User 06c1c9c8…` (`ApprovalPolicyTestDialog.tsx:261–263`, delegate too :265–269). Names are never resolved; the one verification surface is unreadable for exactly the person-based chains the editor steers you toward.
4. **No unfilled-role warning** (§1.3) and free-text department/region inputs (:162–180) without the workspace's own suggestion lists — the admin can typo the test itself.

### 1.9 Is the result visible/verifiable?

The list page shows match-criteria chips, priority badge, fallback badge, active toggle (`ApprovalPoliciesListPage.tsx:272–360`) — but **not the approver chain**; you must open each rule. "Archive" is really deactivate-with-native-`confirm()` (:186–189); rules can never be deleted, and the raw "priority 100" badge (:283–285) resurfaces the jargon the editor hides. After a real submission, verification happens only when a requestor's submission bounces (toast on *their* screen) or an approver notices their queue.

### 1.10 Separation of duties — labels and enforcement

- The workspace toggle asks **"Can the same person fill multiple roles?"** where ON means "distinct users **required**" (`ApprovalPoliciesListPage.tsx:213–226`) — the switch answers the opposite of the question asked. Same phrasing in the editor (`ApprovalPolicyEditPage.tsx:506–508`).
- Enforcement only compares explicit `approver_user_id`s (`approvalPolicyValidation.ts:96–105`; `approvalChainLogic.ts:75–88`, comment admits "role-only steps … cannot collide"). `act-on-chain-step` never re-checks SoD at act time (no "separation" reference in the file). One person holding both `manager_approver` and `financial_approver` roles — or acting via the admin override (:333–351) — can approve every stage of the same lease under "Require distinct users". The requirement is honest only for person-steps.

---

## 2. Verdict on the owner's ideal structure

> "Warehouse staff submit; their manager approves; CFO signs; finance has visibility."

1. **"Warehouse staff submit"** — nothing to configure; the Submitter role checkbox is a no-op (§1.3). *Accidentally fine, but the control the admin is shown is fake.*
2. **"Their manager approves"** — no "requestor's manager" concept exists. Closest: one rule per department (`match_departments: ['Warehouse']` → person-step for that manager) + a fallback rule. Works **only if** requestors type the department exactly (§1.7) and the admin dodges the tie/fallback traps (§1.5).
3. **"CFO signs"** — expressible **only** via the policy editor's signator stage, as a *specific person*. The natural "Anyone with role Signatory" choice is a dead end (§1.3). The legacy Approval Chain card — the most discoverable surface — cannot express it at all.
4. **"Finance has visibility"** — **no visibility/observer concept exists anywhere.** The only approximation is an optional parallel finance step — but optional steps are **never notified** (`findFirstPendingAssignees` filters `is_required`, `approvalChainLogic.ts:115`; initial notify same, `resolve-approval-chain/index.ts:592`), the "parallel" placement runs sequential anyway (§1.6), and the optional pending row lingers in finance's queue after the stage completes (nothing supersedes it on the approve path, `act-on-chain-step/index.ts:546–589`). Finance learns nothing unless they poll their queue.

**Could a non-technical finance admin do this unaided in under 10 minutes?** A pared-down version (one catch-all rule, two named people) — yes, ~6 interactions, and the sentence-style editor is genuinely good. The owner's actual structure — **no**: two of its four requirements (role-based signing, finance visibility) are dead ends, and the moment the admin models departments (requirement 2) they step onto the tie/fallback/free-text minefield whose failures surface days later on *other people's* screens. The system optimizes the first five minutes and abandons the admin at minute six.

---

## 3. Simplification pushback (the owner asked)

- One rule, two stages, named people should be the entire default surface — it nearly is. Keep it.
- **Kill or wire the decorative controls**: Submitter checkbox (no-op), Review Thresholds card in chain mode, "Lease types" checkboxes (unmatchable), Regions criterion for Path 1 (unmatchable), Submitter/Admin as approver-role options.
- **Merge the two surfaces**: the legacy Approval Chain card should either become a thin view of the fallback rule or link to Approval Rules with an explicit "these are ignored while rules exist" state.
- Parallel groups, priorities and fallback flags are engine concepts. If the editor auto-managed priority (list order = precedence, like every email-filter UI) and auto-created/required a fallback ("Everything else → …" pinned row), three of the four traps disappear without removing capability.

## 4. Concrete recommendations (ordered)

1. **Fix the parallel inversion** (`ChainDiagram.tsx:139–151` + a data migration for editor-authored policies): parallel sibling = same `step_order`, distinct `parallel_group`; sequential next step = `step_order+1`. Add tests for `addNextStep`/`addParallelApprover` against `findFirstPendingAssignees`.
2. **Make ties impossible or loud**: auto-assign unique priorities (or tie-break by `created_at` in `matchPolicy` the way `preview_policy_resolution` already does — pick ONE behavior for both), and warn at save when an active rule shares a priority with an overlapping rule.
3. **Fallback guardrail**: banner on the list page when no active fallback exists; prompt "make this the fallback?" when saving the first rule with criteria.
4. **Signatory role**: either add it to the Users-tab role UI (and `FunctionalRole` in `lifecycle.ts:76`) or remove it from `FUNCTIONAL_ROLE_OPTIONS`; warn at save/test on any role step with zero holders.
5. **Department integrity**: make the request form's department a select fed by `department_options` (free text as explicit fallback), and make matching case-insensitive.
6. **Test dialog**: resolve member names (the editor already has the roster query, `ApprovalPolicyEditPage.tsx:120–139`); test the in-editor draft (pass steps to a variant RPC or evaluate client-side); reproduce tie/no-fallback failures; warn on unfilled roles.
7. Remove or repopulate the "Lease types" checkboxes; hide Regions until Path-1 collects a region.
8. Fix the SoD toggle copy (make the switch answer the question it asks); enforce SoD for role-resolved actors at act time in `act-on-chain-step`.
9. Notify optional-step assignees (or rename the concept "FYI/observer" and auto-resolve their rows on stage completion) — this is also the cheapest path to real "finance visibility".

## 5. Docs-vs-code drift found in this lane

| Claim | Reality |
|---|---|
| `APPROVAL_ROUTING_ARCHITECTURE.md:299` "Policy gaps, broken assignees, and ambiguous matches throw at the earliest possible moment" | No save-time or preview-time detection of ties, missing fallback, or holderless roles; ambiguity surfaces to the requestor at submission (`resolve-approval-chain/index.ts:1158–1188`) |
| `APPROVAL_POLICY_EDITOR_REDESIGN.md:16` "No resolver changes … data layer stays exactly as defined" + `ARCHITECTURE.md:150` parallel semantics | Editor now authors a step shape (unique step_orders per stage) the resolver executes as sequential (§1.6) |
| CLAUDE.md File-to-Feature Map lists `src/hooks/useLifecycleWorkflow.ts` under Path 1 | Retired dead code (`App.tsx:184`); also the sole writer of the 'Real Estate'/'Equipment' `lease_type` vocabulary the policy editor still matches on |
| CLAUDE.md: chain policies "replac[ed] the legacy fixed `manager_approver`/`financial_approver` parallel-notify model" | Legacy model still ships as the most prominent config surface (Users-tab "Approval Chain" card) and is the actual runtime default for every workspace with zero policies (`resolve-approval-chain/index.ts:1096`) |
| `WorkspaceSettings.tsx:889` departments copy: "Users can also type a custom value" (implies options offered) | Request form never offers the options — it is only free text (`LeaseRequestForm.tsx:577`) |
| `preview_policy_resolution` (baseline :643–644) vs `matchPolicy` (`resolve-approval-chain/index.ts:353–358`) | Code-vs-code drift on tie handling: silent LIMIT 1 vs hard 409 |

## 6. What's genuinely good (credit where due)

Sentence-pill match editor and person-card chain are far above SMB-tool baseline (`MatchCriteriaSentence.tsx`, `ChainDiagram.tsx`); seeded empty slots force an approver choice via validation (`ChainDiagram.tsx:101–123`); the draft-until-resolution submission contract eliminates half-states (`LeaseRequestForm.tsx:270–275, 344–363`); #108 jargon cleanup verified in this surface (`lifecycleStates.ts:144–166`); atomic `set_workspace_roles` and `apply_policy_steps` with real auth checks; a test dialog exists at all, promoted to a primary action.
