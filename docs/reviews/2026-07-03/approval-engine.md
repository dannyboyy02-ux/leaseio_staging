# Approval Chain Engine — Correctness & Completeness Review

Reviewer focus: `resolve-approval-chain`, `act-on-chain-step`, delegation/OOO/override/reroute/stuck functions, the pure-helper mirrors, chain migrations, and Phase 6/7 docs. All claims cite `file:line` in the repo at `main`-merged HEAD `fd31dfe` (branch `claude/leaseio-end-to-end-review-163v6w`). The CODE is treated as truth; docs are checked against it.

**Bottom line:** the engine's *core* (policy matching, chain creation, stage-completion math, Phase-7 assignee columns, audit rows) is solidly built and mirrored. But three of the four "backward" arrows in the workflow — **concept send-back, signator send-back, and chain-violation resolution — are dead ends in code**, and the entire Phase-6 automatic-reroute machinery is **dormant** (its two crons were never wired and its dashboard reads rows nothing produces). The forward happy path works; almost every loop back does not. That is exactly the "shipped incomplete" pattern the owner suspects.

---

## 1. CRITICAL — Signator send-back permanently strands the lease

Per the product flow, the CFO/signator must be able to send a lease back to negotiation and later approve it after re-negotiation. The first half works; the second half cannot happen.

- `act-on-chain-step/index.ts:474-537` — signator `send_back` sets lifecycle → `in_negotiation`, marks the acted step `sent_back` (line 367-375), and supersedes all other *pending* signator rows (532-537).
- The code comment at `act-on-chain-step/index.ts:527-531` claims the lease "is re-advanced via Phase 4's advance-to-final-review … **which will insert a fresh pending signator row**."
- **advance-to-final-review inserts nothing.** `advance-to-final-review/index.ts:330-348` only sets `pending_since` on *existing* `status='pending'` signator rows. After a send-back there are none (they're `sent_back`/`superseded`).
- Grep of all writers of `lease_approval_chain` confirms only two INSERT paths exist: initial resolution (`resolve-approval-chain/index.ts:1304-1306`) and the C5 RPC (`20260618160000_reroute_reconcile_chain_steps_rpc.sql:43-66`), which is invoked only by reroute mode and `forceConceptReactivation` (concept-only). **No path ever re-creates a signator row.**
- Result: submitter re-advances → lease is `final_review` with zero pending signator steps. `SignatorReview.tsx:186-196` renders "No pending signator step exists for this lease…" and offers no recovery.
- Admin recovery is also broken: `admin-override-step/index.ts:123` accepts `sent_back` steps (per spec `docs/PHASE_7_BUILD_SPEC.md:200-204`), but for approve/reject/send_back it delegates to act-on-chain-step (`admin-override-step/index.ts:246-259`) **which rejects any non-pending step** (`act-on-chain-step/index.ts:229-235`) → guaranteed 409 after already writing the `chain_step_overrides` audit anchor. `reassign` on a sent_back step changes the assignee but the step still isn't `pending`, so the new assignee can't act either. Only `cancel_step` succeeds — which doesn't un-strand the lease.

**Fix direction:** on re-advance (`advance-to-final-review`), rebuild the signator stage from the lease's policy (same pattern as `forceConceptReactivation`) or flip the `sent_back` step back to `pending` with a fresh `pending_since`. Also make admin-override actually able to act on `sent_back` (the "override flag" the Phase-7 spec describes was never implemented).

## 2. CRITICAL — Concept send-back has no resubmission path for chain leases

- `act-on-chain-step/index.ts:462-537` — concept `send_back` sets lifecycle → `concept_submitted`, marks the acted row `sent_back`, supersedes all pending concept rows. Zero pending steps remain; nobody has anything in their queue.
- The ApprovalQueue dialog promises: "The submitter must resubmit" (`src/pages/app/ApprovalQueue.tsx:458`). **No chain resubmit mechanism exists:**
  - The only resubmit UI is legacy-gated: `src/pages/app/LeaseReview.tsx:2192` renders it only when `financial_returned_to_submitter && lifecycleStatus === 'submitted'` — a chain lease sits in `concept_submitted` and never sets that flag.
  - `legacy-lease-action/index.ts:276-286` rejects `resubmit_request` unless `status === 'submitted' && financial_returned_to_submitter`.
  - `forceConceptReactivation` (the one machine that can rebuild concept rows, `resolve-approval-chain/index.ts:394-607`) is reachable only through `escalate-to-concept-approver`, which requires `in_negotiation` (`escalate-to-concept-approver/index.ts:164-175`).
  - The idempotent-recovery branch of initial resolution only flips `draft` leases (`resolve-approval-chain/index.ts:1036-1048`).
- The dead end is **invisible to the safety net**: `detect-stuck-chains/index.ts:67-71` scans only `status='pending'` rows with non-null `pending_since` — a lease with zero pending rows can never be flagged stuck.

**Fix direction:** a "revise & resubmit" action for chain leases (requestor/admin) that re-invokes `forceConceptReactivation` from `concept_submitted`, or have send-back keep the acted step `pending`-resettable. Also teach detect-stuck-chains to flag in-flight lifecycle states with zero pending required steps — that's the real "stuck" signature of both dead ends.

## 3. CRITICAL — `chain_violation` has no working exit

The architecture doc (`docs/APPROVAL_ROUTING_ARCHITECTURE.md:257`) and the banner promise two resolution paths. Both are broken:

1. **Admin "Acknowledge and Override" always fails.** `ChainViolationBanner.tsx:151-154` updates `leases.lifecycle_status` **from the browser**. The `prevent_unauthorized_lease_workflow_edits` trigger (`supabase/migrations/20260516120000_baseline_schema.sql:575-607`) raises an exception on any authenticated lifecycle write → `updateError` → toast, every time. Phase 6's as-built note A7/A8 (`docs/PHASE_6_BUILD_SPEC.md:630-660`) documents this frontend write as intended — it was built before the P1-11 governance trigger and never re-audited after the trigger shipped.
2. **Retroactive approval misroutes the lifecycle.** `act-on-chain-step` has no awareness of `chain_violation`: approving an added *concept* step that completes the stage flips the executed lease to `in_negotiation` (`act-on-chain-step/index.ts:546-585`); approving an added *signator* step flips it to `pending_counter_signature` and **overwrites** `signator_approved_at`, `signator_attestation`, `execution_owner_id`, and the counter-signature due date on an already-executed lease (`act-on-chain-step/index.ts:644-722`). Nothing ever returns the lease to `active`/`fully_executed` when the retro approvals complete.

The only working exit today is `cancel_request` (`legacy-lease-action/index.ts:266-275` — `chain_violation` is not in its exclusion list), i.e. destroying an active lease record.

**Fix direction:** move the acknowledge-override into a service-role edge function (mirror `admin-override-step` patterns), and add a `chain_violation` branch in act-on-chain-step: retro-approve without lifecycle transitions, and auto-revert to `lease_reroute_events.prior_lifecycle_status` when the last required pending step approves.

## 4. CRITICAL/HIGH — act-on-chain-step has no lease-lifecycle guard (root-cause class)

`act-on-chain-step` validates only `step.status === 'pending'` (`index.ts:229`). It never checks the lease's current lifecycle before applying transitions. Concrete failures, all reachable from the normal ApprovalQueue (whose query is `status='pending'` + assigned-to-me with **no lease-state filter**, `src/pages/app/ApprovalQueue.tsx:684-712`):

- **Stale optional concept steps** are never superseded when the stage completes (only send_back/reject supersede, and only pending *required* semantics gate completion). An optional approver acting later re-runs `isStageComplete` → true → lease is knocked back to `in_negotiation` from `final_review`, `pending_counter_signature`, or later (`index.ts:546-585`). `reject` on the same stale step marks a terminal `rejected` from any state (`index.ts:433-461`).
- **Second parallel signator**: signator approve doesn't gate on `isStageComplete` and doesn't supersede sibling pending signator rows (`index.ts:644-788`; gap acknowledged in `docs/PHASE_6_BUILD_SPEC.md` A9). The second signator's approve **overwrites the first signator's attestation** and re-fires the counter-signature clock — an audit-integrity problem, not just a UX one.
- **Cancelled leases stay actionable**: `cancel_request` (`legacy-lease-action/index.ts:413-421`) never supersedes chain rows, so approvers can approve steps on a cancelled lease and flip it back into `concept_under_review`/`in_negotiation`. (Same for `record-counter-signature` — no supersede of leftover rows after execution.)

**Fix direction:** one guard at the top of act-on-chain-step: load the lease lifecycle, reject actions when the lease is terminal/cancelled, and make stage-transition writes conditional on the lease actually being in the stage the step belongs to (use `VALID_TRANSITIONS`/`canTransition`, which exists in the shared mirror but **is never called by any edge function**). Supersede optional pending rows on stage completion and sibling signator rows on first signator approve; supersede all pending rows on cancel.

## 5. HIGH — Phase 6 automatic rerouting is dormant end-to-end

- The DB trigger sets `leases.reroute_evaluation_pending = true` on attribute change (`baseline_schema.sql:212`), but the flag's only consumer, `process-pending-reroute-evaluations`, is **not on cron** and has **no UI caller** (grep of `src/` — zero invocations). The cron wiring was explicitly deferred: `supabase/migrations/_archive/20260507220000_phase567_crons.sql:14-22` ("DEFERRED: … wiring them safely requires a service-context invocation path in resolve-approval-chain"). KNOWN_ISSUES #14 tracks this but frames the poller as "a backstop" — it is actually the *only* automatic consumer; without it no automatic reroute ever happens.
- Even the documented "production cron passes the service-role JWT" (`process-pending-reroute-evaluations/index.ts:12`, `docs/PHASE_6_BUILD_SPEC.md` A5) cannot work: both functions call `auth.getUser(token)` (`process-pending-reroute-evaluations/index.ts:64`) which fails for a service-role JWT, and `resolve-approval-chain` additionally requires the caller to be a member of each lease's workspace (`resolve-approval-chain/index.ts:277-299`).
- `reroute-audit-sweep` is likewise never invoked, so `RerouteAuditDashboard` — which renders `reroute_audit_run` activity rows (`src/pages/app/RerouteAuditDashboard.tsx:101-107`) — is **permanently empty**, meaning admins will never see the misalignment findings that were supposed to prompt the one working path, the manual reroute button.
- Net: "chains reroute on material change" (`docs/APPROVAL_ROUTING_ARCHITECTURE.md:40-48`, CLAUDE.md "Phase 6 CLOSED") is, operationally, **not a shipped feature** — it's an admin-initiated manual action behind a dashboard that never shows anything.

## 6. HIGH — Reroute lifecycle math can move a lease FORWARD (and resurrect terminal leases)

- The helper contract says the caller computes `min(current_lifecycle, target)` (`src/lib/approvalChainLogic.ts:252-257`). The caller doesn't: `resolve-approval-chain/index.ts:823-836` special-cases only (`target=concept_under_review`, `current=concept_submitted`). If a reroute adds **only a signator** step while the lease is still in `concept_submitted`/`concept_under_review`, `newLifecycle = 'final_review'` — the lease *skips* concept approval and negotiation entirely.
- No terminal-state guard: reroute mode never checks for `rejected`/`cancelled`/`expired`. `admin-trigger-manual-reroute` doesn't either (only `reroute-audit-sweep` filters by `SWEEP_LIFECYCLES`, `reroute-audit-sweep/index.ts:37-45`). A manual reroute on a rejected lease whose attributes changed would set it to `concept_under_review` — resurrecting a terminal lease outside `VALID_TRANSITIONS` (`src/lib/lifecycleStates.ts:181`, `rejected: []`).

## 7. HIGH — "Reroute when a policy was edited" is unreachable by construction

Both the sweep and manual reroute exist *specifically* for "a policy was edited after the lease's chain was resolved, so no lease-attribute change ever fired the trigger" (`admin-trigger-manual-reroute/index.ts:4-7`; `reroute-audit-sweep/index.ts:3-8`). But reroute mode short-circuits at "no attribute change since last snapshot" **before ever re-matching the policy** (`resolve-approval-chain/index.ts:638-655`). With unchanged attributes it returns `no_reroute_needed` — so for the exact scenario these tools were built for, they are guaranteed no-ops. (The #111-C4 as-built note in KNOWN_ISSUES recognized this class for *escalation* and built `forceConceptReactivation`; the sweep/manual-reroute path was left contradicting its own header.)

## 8. HIGH — Repo ≠ deployed: the #84/#111 redeploy is still an open activation step

Per `docs/DEPLOY_RUNBOOK_2026-06-18.md:40-48` (last updated 2026-06-19; today 2026-07-03): migrations (backfill `20260618150000`, RPC `20260618160000`, SLA `20260618170000`) are applied, but the **edge redeploys were "NOT DONE"**: the deployed `resolve-approval-chain` is the stale pre-#84 copy. Consequences while that holds (cannot be verified from the repo, but both the runbook and CLAUDE.md assert it): new chains get NULL Phase-7 columns again (crons skip them; exclusive-delegation authz falls back), C5 reroute atomicity is dormant (the deployed copy still does the two-write, error-swallowing reconcile that can leave **zero approvers** — the very bug C5 fixed), and the deployed `escalate-to-concept-approver` still resurrects superseded approvers. Also `act-on-chain-step` + `escalate-to-concept-approver` redeploys and the notification-dispatch cron/secret are pending. This is the single highest-leverage operational item.

## 9. HIGH (docs/product) — Rejection is hard-terminal; the architecture says revisable

- `docs/APPROVAL_ROUTING_ARCHITECTURE.md:71-79` shows `concept_rejected (terminal/revise)` and `final_rejected (terminal/revise)`.
- Code has no such states (`leases_lifecycle_status_check`, `baseline_schema.sql:1578`); both stages write plain `rejected` (`act-on-chain-step/index.ts:433-456`), and `VALID_TRANSITIONS.rejected = []` (`src/lib/lifecycleStates.ts:181`) — no exits, no revision path anywhere (legacy agrees: `FinancialReview.tsx:691` "Final rejection — cannot be resubmitted").
- Verdict requested by the brief: **confirmed** — the doc's "(terminal/revise)" intent is unimplemented. Either implement a revise-from-rejected flow or amend the architecture doc to declare rejection strictly terminal (send-back being the revisable path — which then *must* be fixed per findings 1–2).

## 10. MEDIUM — Delegation priority inversions vs. the pure helper

`resolveEffectiveAssignee` defines admin_reassign > voluntary > OOO > policy_delegate (`src/lib/approvalChainLogic.ts:380-431`) and declares "the helper is correctness; the column is convenience" (`:296-300`). The event-driven writers violate it:

- `process-delegate-timers/index.ts:127-131` skips only `voluntary_delegate`/`ooo_delegate` — an elapsed policy delegate **overwrites an `admin_reassign`**.
- `voluntary-delegate-step/index.ts:125-133` authorizes the *original* approver even after an admin reassigned the step away — the original can hijack the step back by delegating (overwrites `admin_reassign` at `:184-191`).
- Both revoke paths recompute with `admin_reassigned_user_id: null` hardcoded (`revoke-voluntary-delegation/index.ts:161-170`, `revoke-out-of-office/index.ts:148-157`) — a revoke erases a prior admin reassignment (`chain_step_overrides` still says the admin reassigned it; the live column disagrees).

## 11. MEDIUM — OOO is half-built and dormant (known, but with unfiled gaps)

KNOWN_ISSUES #73 records the UI removal and the missing expiry cron. Beyond that: future-dated windows never activate (`declare-out-of-office/index.ts:189-196` routes only currently-pending steps when the window covers *now*; the promised "cron flips them in" doesn't exist); steps that *become* pending during an active window are never routed (neither `act-on-chain-step`'s pending_since writer nor the resolver consults `user_out_of_office`); and revoke reverts only steps where `approver_user_id = user` (`revoke-out-of-office/index.ts:121-129`) while declare matched on `effective_assignee_user_id` (`declare-out-of-office/index.ts:197-202`) — steps where the OOO user was a delegate/reassignee stay routed with no active OOO record. `OutOfOfficeSettings.tsx` has zero importers (dead component).

## 12. MEDIUM — No separation-of-duties at act/delegate time

`checkSeparationOfDuties` runs only over policy composition at resolution (`resolve-approval-chain/index.ts:1232-1263`). Delegation and reassignment targets are checked only for workspace membership (`voluntary-delegate-step/index.ts:135-158`; `admin-override-step/index.ts:169-187`) — a step can be delegated/reassigned to the lease requestor or to another approver already in the chain, silently defeating SoD. Also: workspace owner/admin can approve *any* step in-band via act-on-chain-step's authz ladder (`act-on-chain-step/index.ts:333-351`) with a plain `chain_step_approved` row — bypassing the richer `chain_step_overrides` audit trail that `admin-override-step` exists to create.

## 13. MEDIUM — Sequential order isn't enforced; parallel_group is decorative

- act-on-chain-step never checks that lower `step_order` steps are resolved; the queue shows every pending step assigned to me (`ApprovalQueue.tsx:684-712`). A level-2 approver can approve before level 1 acts. Sequencing exists only in *notification* order and `pending_since` bookkeeping.
- `parallel_group` drives nothing in the engine: `isStageComplete`/`findFirstPendingAssignees`/`advancedPastStepOrder` key on `step_order` alone (`src/lib/approvalChainLogic.ts:95-153`); same `step_order` already means parallel. All-must-approve semantics only; no any-of-group. Candidate for removal in a simplification pass.

## 14. MEDIUM — Reroute reconciliation: no notifications, incoherent ordering, no lineage

- **Newly added approvers are never notified**: the reroute path writes audit rows but no `recipient_ids` notification (grep `resolve-approval-chain/index.ts` — none). They'd discover the step only by visiting their queue. The submitter-facing notification is a localStorage-driven modal (Phase 6 A11).
- **Coordinate mixing**: preserved rows keep their OLD `step_order` while added rows carry the NEW policy's `step_order` (`resolve-approval-chain/index.ts:881-913`); the merged chain can invert the new policy's intended sequence or accidentally make steps parallel.
- `rerouted_from_chain_id` (schema + architecture doc `:240`) is never written by any code path — reroute lineage is reconstructable only via `lease_reroute_events`.

## 15. MEDIUM — admin-override `cancel_step` can brick stage completion

`cancel_step` marks the step `superseded` (`admin-override-step/index.ts:238-244`). `isStageComplete` requires every *required* step (any status) to be `approved` (`approvalChainLogic.ts:95-99`) — a superseded required step can never be approved, so if it was the stage's only remaining required step, the stage can never complete and the lease sits in `concept_under_review`/`final_review` forever, invisible to detect-stuck-chains (no pending rows).

## 16. Dead / never-invoked code

- **`handle-deactivated-approver`**: zero callers in `src/` or other functions (grep). Member removal (`MembersPanel`) never invokes it — orphaned steps only repair if an admin manually curls the function. (Acknowledged inside KNOWN_ISSUES #111's "adjacent items," never given its own number.) The architecture doc's "nightly check surfaces broken policies" (`APPROVAL_ROUTING_ARCHITECTURE.md:249`) is not built.
- **`useLifecycleWorkflow.ts`**: zero component callers (only tests). Its browser lifecycle writes would be rejected by the governance trigger; its `createDraftLease` INSERTs a lease directly with `lifecycle_status='approved'` (auto-approve) — an INSERT bypasses the trigger (`baseline_schema.sql:585-587` guards UPDATE only) and bypasses chain resolution entirely. Dead but dangerous if resurrected; CLAUDE.md's file map still lists it as the live Path-1 hook. (Latent-convention aspect tracked as #34.)
- **`delegated` / `skipped` chain statuses**: declared in the type (`approvalChainLogic.ts:31-38`) but never written by any code.
- Minor: ambiguous-match in reroute mode returns 409 without clearing `reroute_evaluation_pending` (`resolve-approval-chain/index.ts:700-717`) — correct-ish (retry until fixed), but if the poller is ever wired it will re-log `chain_resolution_failed` every 5 minutes forever.

## 17. Legacy path & zero-policy workspaces (verified semantics, mostly by design)

- Legacy parallel-notify is alive and is the **default for every new workspace**: `create-workspace` seeds no `approval_policies` (grep — none), so `matchPolicy()` → `no_policies` → `legacyFallback` (`resolve-approval-chain/index.ts:1096-1157`). The doc claim that legacy roles are "to be deprecated" (`APPROVAL_ROUTING_ARCHITECTURE.md:111-112`) is aspirational.
- Zero-policy AND zero-roles workspace: `getApprovalRequirements` → neither approval required → the submission flip goes straight to `approved` (`_shared/approval_routing.ts:49-77`; `resolve-approval-chain/index.ts:1122-1140`, logged `auto_approved: true`). Server-computed (not client-trusted) — good — but a brand-new workspace silently auto-approves every request until someone configures roles or policies. Worth an explicit onboarding warning.
- Legacy state machine (`legacy-lease-action`) is the healthiest surface reviewed: proper state preconditions (`:250-286`), server-side status recompute on resubmit (`:301-319`), convention-compliant audit rows (`:453-468`).

## 18. Mirror parity (Node ⇄ Deno) — VERIFIED IN SYNC

`diff` of `src/lib/approvalChainLogic.ts` ⇄ `supabase/functions/_shared/approval_chain.ts` and `src/lib/lifecycleStates.ts` ⇄ `_shared/lifecycle.ts` after quote normalization: **only comments differ; zero behavioral drift.** The `scripts/check-mirror-parity.mjs` discipline is holding.

## 19. What is genuinely solid (as-built confirmations)

- Phase-7 columns are set at chain creation in the repo resolver (`resolve-approval-chain/index.ts:1289-1301`), on reroute-added rows (`:909-912`), on concept reactivation (`:550-557`); `pending_since` advances correctly on concept level-cross (`act-on-chain-step/index.ts:624-642`) and final_review entry (`advance-to-final-review/index.ts:330-348`). The frontier backfill (`20260618150000:56-86`) matches the pure predicate `isFrontierActiveRequiredStep` exactly.
- C5 atomic reconcile RPC is correct and properly locked down (service_role-only, `20260618160000:73-75`); the resolver aborts on failure instead of swallowing (`resolve-approval-chain/index.ts:915-932`).
- Exclusive delegation (C3) is consistent between server authz (`act-on-chain-step/index.ts:289-299`) and queue visibility (`ApprovalQueue.tsx:694-712`), with a working revoke path.
- Escalation (C4) is well-sequenced: chain rebuilt *before* the lifecycle flip so failure never strands the lease (`escalate-to-concept-approver/index.ts:299-366`).
- Vault/liveness gates and per-workspace rate limits are consistently applied across all mutating chain functions.
- The nudge system is now wired repo-side (`NudgeApproverButton.tsx:64` → `send-nudge`), delivery operator-gated (runbook step ②).

## 20. Simplification pushback (owner asked for it)

The engine carries: 2 stages × sequential orders × parallel groups × optional steps, 3 delegation mechanisms + OOO + admin override + reroute + violations + SLA badges — while the *basic* user loops (send back → revise → resubmit; reject → revise) don't work. Recommended order:

1. **Fix the loops first** (findings 1–4). They're the product; an ops requester and a manager cannot complete the advertised flow today if anyone ever clicks "Send back."
2. **Delete or shelve**: `parallel_group` (redundant with step_order), OOO backend (dormant by decision, half-correct), `delegated`/`skipped` statuses, `useLifecycleWorkflow`, and — until the crons are wired — hide `RerouteAuditDashboard` behind a "not yet active" state instead of a silently-empty table.
3. **Wire or cut the reroute crons** (#14): the service-context invocation path in `resolve-approval-chain` is a day of work and turns Phase 6 from decorative to real.
4. Then ship the #84 redeploy bundle (runbook step ②) before anything else — it's blocking already-merged fixes.

## Cross-reference to KNOWN_ISSUES

Already tracked (don't double-file): #14 (crons unwired — but understates impact, see §5), #111/#84 (deploy gap), #73 (OOO dormant), #109 (nudge, resolved repo-side), #34 (useLifecycleWorkflow latent), #134, #151. **Not tracked anywhere** (new): findings 1, 2, 3, 4, 6, 7, 10, 12, 13, 14, 15, and the KNOWN_ISSUES-#14 mischaracterization itself.
