# Merge / Deploy Runbook — 2026-06-18 audit-execution round

Covers the PRs produced in the 2026-06-18 execution round. **Living doc** — update
it as later follow-on PRs (notification email delivery, counter-sig email, etc.)
are opened.

## ✅ Status: all 9 PRs MERGED to `main` (2026-06-19)

The merge campaign is **complete** — every PR below is squash-merged to `main`
(HEAD `10336b7`, CI green) with its KNOWN_ISSUES tail reconciled. **What remains is
the OPERATOR side: apply migrations + redeploy edge functions + set secrets/cron,
per the per-PR steps below.** None of that is automatic.

Merged, in order: **#63 → #58 → #57 → #59 → #60 → #66 → #62 → #64 → #65.**

> **Note:** the #111 C6 SLA work merged as **#66**, not #61. #61 was auto-closed when
> its stacked base branch (#60's) was deleted before its base was retargeted to
> `main`; it was re-opened as #66 with identical rebased content. (Lesson: retarget a
> stacked PR's base to `main` *before* deleting its parent branch.)

The **Merge order** / sequencing section below is retained as history; it no longer
drives action. **Jump to "Per-PR steps" for the operator runbook.**

### Deploy progress (updated 2026-06-19)

**① Migrations — ✅ APPLIED + VERIFIED (2026-06-19)** to the single live project
`wwkwoxxcprnjjufkbzac` ("LeaseIO"). Applied individually via MCP `apply_migration`
in timestamp order (NOT `db push` — the history has apply-time version drift that
would re-run ~9 already-applied migrations). Catalog-verified; the C1 backfill left
zero frontier required-steps without `pending_since`; security advisor clean (no new
issues). The seven: `notification_deliveries`, `firm_counter_delete_decrement`,
`prevent_committed_lease_hard_delete`, `backfill_phase7_chain_columns`,
`reroute_reconcile_chain_steps_rpc`, `approval_policy_sla_days`,
`fanout_recipient_notifications`.

- *Live immediately (DB-only):* hard-delete guard, firm-counter DELETE decrement +
  drift reconcile, in-app notification fanout, existing-chain backfill, `sla_days`
  column.

**② Edge-function redeploys — ⏳ NOT DONE (still required).** Migrations alone don't
activate the edge-side fixes:
- `resolve-approval-chain` — **the key one (= the deferred #84 redeploy):** until it's
  redeployed, NEW chains still get NULL Phase-7 columns, and C5 reroute-atomicity +
  C4 escalate stay dormant (the RPC + backfill exist, but only this fn calls them).
  Plus `act-on-chain-step`, `escalate-to-concept-approver`.
- `dispatch-notifications` + `send-nudge` (+ `NOTIFICATION_DISPATCH_CRON_SECRET` +
  cron schedule) → approval/nudge EMAIL. `process-alerts` → alert EMAIL.
  `delete-workspace` → firm Stripe-quantity resync on delete.

**③ Operator secrets/cron — ⏳ NOT DONE** (see ② + the per-PR steps).

**Out of this round (still unapplied):** `20260612170000_cancellation_lifecycle_cron`
(pre-existing; needs `CANCELLATION_LIFECYCLE_CRON_SECRET` + `process-cancellation-lifecycle`
deployed to function).

## Cardinal rules
1. **Migrations + edge functions are applied/redeployed MANUALLY after each merge.**
   This project's CI/CD auto-deploys only the **frontend (Vercel)**. Migrations
   (`supabase db push`) and edge functions (`supabase functions deploy <name>`) are
   not automatic. (Confirm against the current pipeline before relying on this.)
2. **Migrations apply in timestamp order** (`…120000` → `…180000`) regardless of
   merge order — merge order is about the *stack dependency* + *conflict
   resolution*, not migration correctness.
3. **Review already happened before push** (every PR was reviewed clean by the
   security / integrity / code-auditor lane). Gate on CI-green + the conflict
   resolutions below, not re-review.

## Merge order
- **The #111 stack is strictly sequential: #59 → #60 → #61** (each is based on the
  previous branch, not main). GitHub auto-retargets the next PR's base to main as
  each lands.
- **#57, #58, #62 are independent** — any order.
- Every branch appended to `KNOWN_ISSUES.md` (which ends at #107 on main), so
  **each merge after the first conflicts on the appended tail** — resolve by
  keeping all blocks + assigning real sequential #-numbers.

**Recommended sequence:** `#58 → #57 → #59 → #60 → #61 → #62 → #64 → #65`. (#63 is
this doc; #64 process-alerts email + #65 deno-lint CI are independent.)

**⚠ Sequence #65 (deno-lint CI) LAST.** Once it's on `main`, every other open PR's
next CI run gains the `deno-lint` job, which lints the edge `.ts` files that PR
changes. Any PR touching an edge file with a pre-existing lint issue (e.g. #59's
`act-on-chain-step` has an unused `activityType`) would then go red and need a
small lint fix. Merging #65 after the others avoids re-running them against the
new gate; the gate still applies to all *future* PRs.

---

## Per-PR steps

### ① PR #58 — lease hard-delete guard (#116) · → main
- **Merge.**
- **Apply migration:** `20260618140000_prevent_committed_lease_hard_delete.sql`
- **Edge functions:** none.
- **Verify:** as a non-admin client, deleting a committed lease via ImportHistory is blocked (archive-steer shown); a draft/failed import still deletes.

### ② PR #57 — jargon / notify-delivery / firm-counter / CSV · → main
- **Merge** (resolve KNOWN_ISSUES conflict).
- **Apply migrations:** `20260618120000_notification_deliveries.sql`,
  `20260618130000_firm_counter_delete_decrement.sql`
- **Redeploy edge functions:** `dispatch-notifications`, `send-nudge`,
  `delete-workspace` (all bundle the changed `_shared/`). `dispatch-notifications`
  is the email side of the `recipient_ids` rail (the in-app side is PR #62's
  trigger); `_shared/notify_dispatch.ts` includes per-type email copy
  (counter-sig / delegation / execution / signator), commit `ef9673a`.
- **⚠ Operator setup (fail-closed until done — this is what makes approval/
  delegation/counter-sig EMAIL work):** set **`NOTIFICATION_DISPATCH_CRON_SECRET`**
  (32+ char) and **schedule the `dispatch-notifications` cron**; confirm
  `RESEND_*` env for `send-nudge`.
- **Verify:** nudge → row in `notification_deliveries`; delete a firm child
  workspace → firm counter decrements + Stripe quantity resyncs.

### ③ PR #59 — #111 C1/C2/C3/C5 · → main
- **Merge** (resolve KNOWN_ISSUES conflict).
- **Apply migrations:** `20260618150000_backfill_phase7_chain_columns.sql` (C1),
  `20260618160000_reroute_reconcile_chain_steps_rpc.sql` (C5).
- **Redeploy edge functions:** `resolve-approval-chain`, `act-on-chain-step`
  (both bundle changed `_shared/approval_chain.ts`).
- **🔑 This redeploy of `resolve-approval-chain` IS the deferred #84 redeploy that
  C1 depends on** — without it, *new* chains keep getting NULL Phase-7 columns.
  The C1 backfill repairs *existing* chains; the redeploy fixes *new* ones. Ship
  them together.
- **⚠ Expected one-time burst:** right after the C1 backfill, the next
  `detect-stuck-chains` / `process-delegate-timers` run will (correctly) flag
  genuinely-aged chains + fire elapsed delegate timers at once. Warn whoever
  watches alerts.
- **Verify:** fresh lease → first concept step has non-NULL
  `pending_since`/`effective_assignee_user_id`; delegate a step → it leaves the
  delegator's queue and shows under "Delegated by me" with a working Revoke.

### ④ PR #60 — #111 C4 escalate force-reactivation · → main (after #59)
- **Merge** (base auto-retargets to main once #59 lands).
- **Apply migrations:** none (reuses #59's C5 RPC — why the stack order matters).
- **Redeploy edge functions:** `resolve-approval-chain` (now with the
  `forceConceptReactivation` mode), `escalate-to-concept-approver`.
- **Verify:** escalate a negotiation-stage lease back to concept → concept chain
  rebuilt from the *current* policy (no resurrected superseded approvers); a
  no-match policy leaves the lease in `in_negotiation` (not stranded).

### ⑤ PR #66 (was #61) — #111 C6 per-policy SLA · → main (after #60)
- **Merge** (base auto-retargets to main once #60 lands; resolve KNOWN_ISSUES conflict).
- **Apply migration:** `20260618170000_approval_policy_sla_days.sql`
- **Edge functions:** none (frontend-only).
- **Verify:** set a policy's "Approval SLA (days)"; a step pending past it shows
  the red "over SLA" badge in the approver's queue.

### ⑥ PR #62 — notification-rail fanout · → main
- **Merge** (resolve KNOWN_ISSUES conflict).
- **Apply migration:** `20260618180000_fanout_recipient_notifications.sql`
- **Edge functions:** none (DB trigger + frontend).
- **Verify:** trigger an approval/delegation notification → the targeted approver
  sees it in the in-app **Alerts** tab. (In-app only — email is a follow-on.)
- **Sanity-check vs #57:** both touch the notification space (#57 = email
  dispatch + nudge; #62 = in-app `recipient_ids` fanout). Confirm a single action
  doesn't produce a confusing double in-app entry.

### ⑦ PR #64 — process-alerts email · → main (independent)
- **Merge.**
- **Apply migrations:** none.
- **Redeploy edge functions:** `process-alerts`.
- **Operator:** ensure `RESEND_ALERTS_FROM_EMAIL` (or `RESEND_FROM_EMAIL`) +
  `RESEND_API_KEY` are set (already used by other crons). The `process-alerts`
  cron + `PROCESS_ALERTS_CRON_SECRET` are pre-existing.
- **Verify:** with an active `alert_rules` row that fires, the **lease owner**
  gets an email (if their `email_notifications_enabled` is on) + the in-app alert
  still appears. A second cron run within 24h does NOT re-email (dedup).

### ⑧ PR #65 — deno-lint CI gate · → main (independent; sequence LAST — see above)
- **Merge.**
- **Apply migrations:** none.
- **Edge functions:** none (CI config + `supabase/functions/deno.lint.json`).
- **No operator action / no deploy.** Pure CI — adds the PR-only `deno-lint` job.
- **Verify:** the `deno-lint` check appears on PRs and passes for PRs that touch
  no edge `.ts`. (`deno check` type-checking remains deferred — esm.sh supabase-js
  type-resolution 404; tracked in KNOWN_ISSUES.)

---

## At every merge — KNOWN_ISSUES.md reconciliation
Each branch added entries to a file ending at #107 on main. Resolve each conflict
by **keeping all blocks** and **assigning real sequential #-numbers** (the
off-main branches used provisional/descriptive titles to avoid collision). Keep
the RESOLVED stamps already in those entries.

## Post-deploy smoke (after all merges)
- `npm run typecheck` on merged main; `npx vitest run` (expect only the ~49
  pre-existing jsdom failures — a filed follow-on, not a regression).
- Open the app in a fresh Incognito tab (Vite stale-chunk check) — several PRs
  change `App.tsx`-reachable routes.
- Spot-check the Alerts tab, approval-queue SLA badges, and lease archive/delete
  affordances.

## Rollback
- **Frontend:** Vercel → promote the previous deployment.
- **Edge functions:** redeploy the prior committed version
  (`git checkout <prev> -- supabase/functions/<name>` → deploy).
- **Migrations:** all are **additive / idempotent** (new columns/triggers/RPCs;
  `IF NOT EXISTS` / `OR REPLACE`) — none drop or rewrite existing data, so they're
  safe to leave in place on a code rollback. A misbehaving trigger can be
  individually disabled with `DROP TRIGGER`.

---

## Notification email delivery — already covered (correction 2026-06-18)
The `recipient_ids` approval/delegation/counter-sig notifications **deliver by
email via PR #57's `dispatch-notifications`** (verified) and **in-app via PR #62's
fanout trigger** — together they're the two halves of one rail. Email is
**operator-gated, not a missing build** (schedule the cron + set the secret — step
② above). The `send-counter-signature-reminder` "no email" concern was an
off-`main` artifact: it writes a `recipient_ids` row the dispatcher emails (with
counter-sig-specific copy as of #57 `ef9673a`).

**Email for the `notifications`-table rail — now covered by PR #64** (step ⑦):
`process-alerts` emails each new alert (expiry / approval_pending / covenant /
variance) to the lease owner, gated by `email_notifications_enabled`, best-effort.
So both notification rails now deliver in-app **and** by email.

## Follow-on PRs (append as opened)
- **#64** — process-alerts email (step ⑦ above). Independent; reviewed clean.

_(No remaining notification-email gaps. Possible future extension: also email
workspace admins for governance alerts — a one-spot change in `sendAlertEmails`.)_
