# Roadmap to Market — the single source of truth for "what's next"

**Owner:** Daniel (non-developer; vibe-coding). **Written:** 2026-10-27.
**This file is state, not prose.** Any session working on LeaseIO reads this FIRST, finds the
first step that is not `DONE`, and works on that one. Update the status line in this file in the
SAME commit that does the work. If this file and anything else disagree, fix this file.

## The rule that orders everything

Half-finished work is more dangerous than bugs. Bugs are visible; unfinished work is invisible,
untested, unreviewed, and it rots. **Minimize the number of unfinished things at any moment.**
Never start step N+1 while step N is open. Do not add scope to an open step — write new ideas
into `docs/KNOWN_ISSUES.md` and keep going.

## Standing guardrails (violating these is how this project gets hurt)

1. **Never leave work uncommitted overnight.** Commit and push even if broken; say so in the message.
2. **Deploy order is always: migrations → edge functions → frontend.** Out of order, live lease
   submissions break for real users. The migrate-then-redeploy window fails CLOSED, so redeploy
   immediately after applying.
3. **Never apply a migration before the reviewer sweep** when it touches RLS, SECURITY DEFINER
   functions, triggers, or audit infrastructure (CLAUDE.md security-migration rule).
4. **Verify, never recall.** Run the command, read the file, take the screenshot. "It should work"
   is not evidence. Claims about git state or deploy state must be re-checked, never remembered.
5. **A change is not done until it has been seen rendered**, logged in as the walkthrough persona
   (Daniel signs in — Claude never types the password). Green tests are necessary, not sufficient.
6. **Every Critical/High finding gets surfaced to Daniel before any fix**, with a true-finding vs
   false-positive assessment. Do not auto-remediate.
7. **Pre-existing issues are their own beat** — file them in KNOWN_ISSUES, do not bundle the fix.

## What is NOT known (do not guess; ask Daniel)

- **Whether there are paying customers today.** This roadmap assumes ZERO (docs say "owed before
  customer #1"). If that is wrong, the order changes — raise it.
- **Whether live-mode Stripe is configured.** Not checkable from a coding session; Stripe is an
  owner-only vendor console. Only Daniel can confirm.
- **What "market" means** — this roadmap assumes FIRST PAYING CUSTOMER, not public launch.

---

## STEP 0 — Protect the work  ·  STATUS: NOT STARTED
**Why first:** ~10,500 uncommitted lines have sat on one machine since 2026-08-14. A single bad
command or dead disk erases months. No decision required.
**Do:** commit the `approval-simplify` branch as-is (blocked and imperfect is fine — say so in the
message) and push it to origin.
**DONE when:** `git status --porcelain` is clean AND the branch exists on origin
(`git rev-parse --abbrev-ref @{u}` resolves).

## STEP 1 — Fix the security regression (#207)  ·  STATUS: NOT STARTED
**Why:** a lease request can approve itself with ZERO human review in a workspace that explicitly
turned approval gating on. Introduced by this branch (before it, the same case returned 409).
**Do:** `supabase/functions/resolve-approval-chain/index.ts` ~line 1399 — move the
`getApprovalRequirements` / `getInitialStatusAfterSubmission` computation ABOVE the guard, then
409 when `isFallbackFromNoMatch && legacyStatus === 'approved'`. Keep the existing
`!hasDefaultApprovers` 409. Update `resolverDefaultFallback.test.ts:37`, which currently pins the
weak guard. Add the third truthful state to `ApprovalEverythingElseRow`.
**DONE when:** a test proves the auto-approve case now 409s, full suite green, typecheck clean.

## STEP 2 — Daniel answers the open decision (#209)  ·  STATUS: BLOCKED ON DANIEL
**Why:** D-Q2 (retire region from rule authoring) was ratified on a premise that turned out FALSE.
Claude said `leases.region` is never written; `LeaseReview.tsx:730` writes it, and region triggers
reroute evaluation — so region rules CAN match once the region is filled in.
**Options:** (a) keep region as a real filter with an honest "won't match at submission, can match
later" note and DROP the destructive one-click remove; or (b) retire it anyway.
**DONE when:** Daniel picks one and it is recorded in KNOWN_ISSUES #209.

## STEP 3 — Close the remaining redesign findings  ·  STATUS: NOT STARTED
**Scope is FROZEN. No new design ideas.** Fix exactly: **#208** (`hasAnyRules` counts paused rules,
so the UI says BLOCKED where the engine AUTO-APPROVES), **#210** (hero inputs collapse at 1024px),
**#211** (page skips `PageLayout`, duplicate CTA, hand-rolled amber instead of the `warning` token),
**#212** (new activity types render as raw snake_case in the Audit Log).
**DONE when:** all four fixed, suite green, `check:mirror-parity` green, reviewer sweep returns no
unaddressed Critical/High.

## STEP 4 — Ship the redesign  ·  STATUS: NOT STARTED
**Do, strictly in this order:** reviewer sweep → apply the 7 migrations in timestamp order
(`20260718130000`, `20260718140000`, `20260718150000`, `20260719120000`, `20260719120100`,
`20260719121000`, `20260719122000`) via MCP `apply_migration` → IMMEDIATELY redeploy
`resolve-approval-chain` (and the other `_shared/approval_chain.ts` importers) → deploy frontend →
live walkthrough at 375 / 672 / 1133px with screenshots → merge to `main` → reconcile CLAUDE.md +
KNOWN_ISSUES in the same commits.
**DONE when:** merged, deployed, and walked live with screenshots shown to Daniel.

## STEP 5 — Make it possible to get paid  ·  STATUS: BLOCKED ON DANIEL (can run in PARALLEL with 0-4)
**This is what "go to market" actually means. Until this is done, no human can give you money.**
Owner-side work in the Stripe dashboard, per `docs/ops/OPERATOR_PLAYBOOK.md`:
- **STOP 3** — live-mode webhook destination + signing secret (live mode is a SEPARATE endpoint
  from the verified sandbox one).
- **STOP 7** — annual Price IDs (`STRIPE_PRICE_STARTER_ANNUAL`, `STRIPE_PRICE_BUSINESS_ANNUAL`).
- **STOP 10** — only if selling Vault; otherwise defer.
Everything fails CLOSED today, so nothing is broken — it is simply unsellable.
**DONE when:** one real live-mode purchase completes end-to-end on the production domain,
including a Link/wallet method (CLAUDE.md Definition-of-Done gate for any money surface).

## STEP 6 — Stop the product lying  ·  STATUS: NOT STARTED
**Why:** a placebo control is worse than a missing feature — it survives exactly until a prospect
clicks it on a demo call. Fix: the Historical-Loader toggle for a feature that does not exist;
"Signs leases" not assignable from the members UI; **#204** (upgrade CTA shown to firm children who
cannot use it). Sweep for others in the same pass.
**DONE when:** no control in the product performs no action or an action the user cannot complete.

## STEP 7 — New features, only now
Phase 2 (quote gate + requestor tracker) and Phase 4 (direct add: `pending_review` state,
`direct_poster` role, unify the retry pipeline with `process_lease`) from the ratified end-to-end
plan. **Neither is required to sell this.** Do not start either while any step above is open.

---

## Progress log (append one line per completed step; never rewrite history)
- 2026-10-27 — Roadmap created. Docs reconciled; `check:mirror-parity` was FAILING and is fixed;
  #193 resolved; #207–#212 filed. Baseline: typecheck clean, 2107 tests green.
