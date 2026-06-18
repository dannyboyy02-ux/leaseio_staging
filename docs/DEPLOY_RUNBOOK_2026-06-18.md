# Merge / Deploy Runbook — 2026-06-18 audit-execution round

Covers the PRs produced in the 2026-06-18 execution round. **Living doc** — update
it as later follow-on PRs (notification email delivery, counter-sig email, etc.)
are opened.

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

**Recommended sequence:** `#58 → #57 → #59 → #60 → #61 → #62`.

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

### ⑤ PR #61 — #111 C6 per-policy SLA · → main (after #60)
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

**Genuinely still open (not in any current PR):**
- **Email for the `notifications`-table rail** — `process-alerts`' in-app alerts
  (expiry / approval_pending / covenant / variance) are in-app only;
  `dispatch-notifications` reads `lease_activity_log`, not `notifications`. A
  separate, smaller build if email for those is wanted.

## Follow-on PRs (append as opened)
_(none yet beyond the above)_
