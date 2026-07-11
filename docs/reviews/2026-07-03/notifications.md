# Notifications + Nudge System — Deep Review (2026-07-03)

Reviewer lane: notifications & nudges. Everything below verified against code on the current checkout of `/home/user/leaseio_staging`. Docs were read for intent only; every claim carries file:line evidence.

---

## 1. Architecture as actually built (five rails)

1. **Approval-workflow rail** — writers insert `lease_activity_log` rows with `activity_type='comment'` + `details.{notification_type, recipient_ids, message}`.
   - **In-app delivery:** DB trigger `fanout_recipient_notifications` (migration `supabase/migrations/20260618180000_fanout_recipient_notifications.sql:106-111`) fans each row into per-recipient `public.notifications` rows — **but only `WHEN (NEW.activity_type='comment' AND NEW.details ? 'recipient_ids')`** (line 110). Rows without `recipient_ids` are permanently dead.
   - **Email delivery:** `dispatch-notifications` cron (`supabase/functions/dispatch-notifications/index.ts`) sweeps 2h lookback every 10 min (migration `20260619000000_schedule_dispatch_notifications_cron.sql`), delivers via `_shared/notify_dispatch.ts` → Resend, idempotent via `notification_deliveries` (migration `20260618120000`). Rows without `recipient_ids` skipped (`dispatch-notifications/index.ts:59-60`).
2. **Date-event scheduler** — `lease_notifications` table + `send-lease-notifications` cron (daily 08:00 UTC, archived migration `_archive/20260507260000_cron_secrets_table.sql:48-53`); emails **the lease owner only** (`leases.user_id → profiles.email`, `send-lease-notifications/index.ts:138-159,203-208`). Surfaced in `src/pages/Notifications.tsx` (tabs All/Upcoming/Sent) + `src/pages/app/NotificationDetail.tsx`.
3. **Threshold alerts** — `process-alerts` cron evaluates `alert_rules` × `leases`, inserts broadcast `notifications` rows (no `user_id`) + emails the lease owner (`process-alerts/index.ts:296-352`). **`alert_rules` has no UI anywhere** (grep hits only `src/integrations/supabase/types.ts:17`).
4. **Direct transactional emails** — `process_lease` "abstraction complete" email to uploader, pref-gated (`process_lease/index.ts:2665-2714`); counter-sig/stuck-chain crons write rail-1 rows.
5. **Nudge** — `send-nudge` edge fn (`supabase/functions/send-nudge/index.ts`) + `NudgeApproverButton.tsx`; records `lease_nudges`, `leases.last_nudged_at`, writes a rail-1 row and dispatches the email immediately (`send-nudge/index.ts:129-154`).

Email transport: `_shared/resend.ts` `sendEmail` (never throws, returns `{sent,error}`; `resend.ts:105-133`). Approval-rail failures are recorded (`notification_deliveries.status='failed'` + error, `notify_dispatch.ts:174-184`) and retried on later sweeps — **but only within the 2h lookback** (`dispatch-notifications/index.ts:20,42-50`); a failure older than 2h is never retried. Crons fail closed on missing secrets (`dispatch-notifications/index.ts:28-32`, etc.). Cron secrets documented in `.env.example:85-117`; delivery of the entire approval email rail is operator-gated (cron + `NOTIFICATION_DISPATCH_CRON_SECRET` + `private.cron_secrets` row `notification_dispatch`).

---

## 2. Event × notification matrix

Legend: ids✓ = writer includes `recipient_ids` (so BOTH in-app fanout and email fire). DEAD = comment row written without `recipient_ids` → delivered to no one, no channel.

| Workflow event | Writer (file:line) | In-app | Email | Recipients | Deep link | Requestor told? |
|---|---|---|---|---|---|---|
| Request submitted (legacy) | client `notifyRoleHolders` — `LeaseRequestForm.tsx:374-394`, `leaseNotifications.ts:63-90` ids✓ | ✓ | ✓ | manager_approver (or financial_approver) role holders | email → `/app/leases/{id}` | n/a (self-action) |
| Request submitted (chain) | client `notifyChainAssignees` — `LeaseRequestForm.tsx:397-404`, `leaseNotifications.ts:102-139` ids✓ | ✓ | ✓ | FIRST-step assignees only | same | n/a |
| Concept step approved, next sequential step activated | **nobody** — `act-on-chain-step/index.ts:615-643` computes `nextAssignees` but only returns them; the sole callers discard them (`ApprovalQueue.tsx:311-338`, `SignatorReview.tsx:276,309`) | ✗ | ✗ | — | — | ✗ |
| First concept approval (`concept_submitted→concept_under_review`) | nobody (`act-on-chain-step/index.ts:597-614`) | ✗ | ✗ | — | — | ✗ |
| **Concept stage complete → `in_negotiation` ("you may seek a quote")** | **nobody** (`act-on-chain-step/index.ts:546-589`; line 586-589 comment: "Phase 2/3 does not notify signator yet") | ✗ | ✗ | — | — | **✗ — THE silent gate the owner asked about** |
| Concept send-back → `concept_submitted` (chain) | nobody (`act-on-chain-step/index.ts:462-537`) | ✗ | ✗ | — | — | ✗ |
| Chain reject → `rejected` | nobody (`act-on-chain-step/index.ts:433-461`) | ✗ | ✗ | — | — | ✗ |
| Legacy manager approve → `under_review` | client — `ApprovalQueue.tsx:1013-1031` `notify_financial_approver` ids✓ | ✓ | ✓ | financial approvers | ✓ | submitter ✗ |
| Legacy manager/financial reject | client — `ApprovalQueue.tsx:1068-1078` `notify_submitter_rejected` **no recipient_ids** | **DEAD** | **DEAD** | — | — | **✗** |
| Legacy financial approve | client — `FinancialReview.tsx:247-256` `notify_submitter_approved` **no recipient_ids** | **DEAD** | **DEAD** | — | — | **✗** |
| Legacy financial send-back | client — `FinancialReview.tsx:289-297` `notify_submitter_returned` **no recipient_ids** | **DEAD** | **DEAD** | — | — | **✗** |
| Legacy financial reject (FinancialReview page) | `FinancialReview.tsx:301-309` **no recipient_ids** | **DEAD** | **DEAD** | — | — | **✗** |
| Quote / negotiation doc uploaded | `upload-lease-document/index.ts:282` writes `document_iteration_uploaded` only | ✗ | ✗ | — | — | manager/approver never told a quote arrived |
| Requestor escalates to concept re-review | `escalate-to-concept-approver/index.ts:384-396` `concept_re_review_required` ids✓ | ✓ | ✓ | `workspace_roles.role='manager_approver'` cohort — NOT the actual rebuilt chain assignees; silently no one if role unheld | ✓ | n/a |
| Advanced to final review | `advance-to-final-review/index.ts:369-389` `signator_review_required` ids✓ | ✓ | ✓ | `signator` role cohort | `/app/leases/{id}` (not the SignatorReview page) | n/a (requestor triggers) |
| Signator approve → `pending_counter_signature` | `act-on-chain-step/index.ts:770-783` `execution_owner_assigned` ids✓ | ✓ | ✓ | execution owner (defaults to requestor, :686) | ✓ | indirectly ✓ |
| Signator send-back → `in_negotiation` | nobody (`act-on-chain-step/index.ts:488-506`) | ✗ | ✗ | — | — | ✗ |
| Counter-signature reminders (5 tiers) | `send-counter-signature-reminder/index.ts:269-279` ids✓ | ✓ | ✓ | t1 exec owner; t2 +submitter; t3+ +admins+owner (:224-252) | ✓ | ✓ from tier 2 |
| Counter-signed → `fully_executed` | `record-counter-signature/index.ts:341-394` `counter_signature_received` ids✓ | ✓ | ✓ | submitter + signator + admins + owner | ✓ | ✓ |
| Extraction complete | `process_lease/index.ts:2665-2714` direct email, gated on `notify_abstraction_complete` && `email_notifications_enabled` | ✗ | ✓ | uploader only | `/app/leases/{id}/review` | ✓ |
| Extraction failed / stuck-extraction reclaimed | nobody — `process_lease/index.ts:2335` sets `status='Failed'` silently; `reclaim-stuck-extractions` has zero notify code | ✗ | ✗ | — | — | ✗ |
| Unlock requested | nobody — `request-lease-unlock/index.ts:143` writes `unlock_requested` only | ✗ | ✗ | admins learn only by visiting the queue | — | — |
| Unlock approved/rejected; change set approved/rejected | nobody — `lease-governance-action/index.ts:280-302` audit rows only | ✗ | ✗ | requester never told | — | ✗ |
| Voluntary delegation given / chain notified | `voluntary-delegate-step/index.ts:215-232` ids✓ | ✓ | ✓ | delegate + original approver | ✓ | — |
| Delegation revoked | `revoke-voluntary-delegation/index.ts:198-203` ids✓ | ✓ | ✓ | delegate | ✓ | — |
| OOO declared → steps delegated | `declare-out-of-office/index.ts:230-236` ids✓ | ✓ | ✓ | delegate | ✓ | — |
| OOO revoked | nobody (`revoke-out-of-office` — no notify code) | ✗ | ✗ | delegate loses items silently | — | — |
| Policy delegate timer fired | `process-delegate-timers/index.ts:158-170` ids✓ | ✓ | ✓ | delegate | ✓ | — |
| Admin override / reassign | `admin-override-step/index.ts:231-240,311-320` ids✓ | ✓ | ✓ | new assignee + original approver | ✓ | — |
| Deactivated approver handled | `handle-deactivated-approver/index.ts:197-206,238-247` ids✓ | ✓ | ✓ | delegate; admins on validation failure | ✓ | — |
| **Reroute (auto on material change / manual admin)** | **nobody** — `process-pending-reroute-evaluations` writes no notification rows; `admin-trigger-manual-reroute/index.ts:194-270` writes `manual_reroute_*` audit rows only | ✗ | ✗ | new approvers added by a reroute are never told; submitter sees `RerouteNotificationModal` only on next visit to the lease (localStorage-seen, `RerouteNotificationModal.tsx:1-10,29`) | — | passive only |
| Stuck chain (7d+) | `detect-stuck-chains/index.ts:170-181` ids✓ | ✓ | ✓ | admins + owner | message embeds literal text "/app/admin/exceptions" (:178); email button still links `/app/leases/{id}` | — |
| Nudge | `send-nudge/index.ts:129-154` ids✓, dispatched immediately | ✓ | ✓ | ALL pending required steps' assignees (over-broad, see F-8) | ✓ | requester gets toast w/ names |
| Date events (expiry/escalation/renewal/commencement) | `send-lease-notifications` cron | ✗ (list page only) | ✓ | lease owner only | `app.theleaseio.com` root | — |
| Threshold alerts (expiry_approaching, approval_pending, covenant_breach, variance_high) | `process-alerts/index.ts:296-352` | ✓ broadcast (all members) | ✓ owner, pref-gated | — | alert click → `/app/leases/{id}` (`Notifications.tsx:253`) | — |

### Nudge coverage summary
- **Who may nudge:** lease submitter (`requestor_id`/`user_id`) OR workspace owner/admin (`send-nudge/index.ts:69-79`).
- **Cooldown:** 30 min, server-enforced per LEASE (not per approver), `send-nudge/index.ts:22,82-89`; client mirrors it (`NudgeApproverButton.tsx:20,35-57`). Plus workspace rate limit 20/hr (:91).
- **Stages nudgeable:** any lease with pending required chain steps; legacy fallback nudges manager+financial role holders (:110-113). Never self (:119).
- **Automatic nudges:** schema supports `automatic_day2/day5/day10` (`baseline_schema.sql:1335`, `src/types/lifecycle.ts:78`) — **no code anywhere writes them**. The nudge system is manual-only.
- **Reachability: ZERO.** See F-1.

---

## 3. Findings

### F-1 (HIGH, arguably CRITICAL for this audit) — The nudge button never renders; the entire nudge system is unreachable
`NudgeApproverButton` is mounted in exactly one place — `src/pages/app/LeaseReview.tsx:2989-2991` — gated on `isPendingApproval`, which is **hardcoded** at `LeaseReview.tsx:436`:
```ts
const isPendingApproval = false;
```
`git log -L` shows this constant has been `false` since the file's tracked history began; the #109 session rewired the *component* (real `send-nudge` call, real cooldown) but never checked its mount gate. Grep confirms no other usage (`src/`). Net: the owner's explicit requirement ("a nudge system in here, too") is fully built server-side (`send-nudge`, `lease_nudges`, `last_nudged_at`, immediate email dispatch) and **completely inaccessible in the UI**. KNOWN_ISSUES #109's "BUILT" claim is misleading on this point.
**Fix:** derive `isPendingApproval` from lifecycle (`submitted / under_review / concept_submitted / concept_under_review / final_review`) or delete the constant and gate on the same predicate the status strip uses; consider a second mount on the requestor's lease card / Approvals "my submissions" surface.

### F-2 (HIGH) — Requestor is never notified of ANY chain-mode outcome — including "concept approved, you may proceed"
`act-on-chain-step` writes zero notification rows for: concept-stage completion → `in_negotiation` (`index.ts:546-589`), reject → `rejected` (:433-461), send-back → `concept_submitted` (:462-537), signator send-back → `in_negotiation` (:488-506). The only notification in the whole file is `execution_owner_assigned` at signator approve (:770-783). So in chain mode (the current model — approval policies), the requestor learns their request was approved/denied/returned **only by polling the app**. This is precisely the owner's named question: *"is the REQUESTOR notified after concept approval that they may proceed?"* — **No, on no channel.**
**Fix:** in `act-on-chain-step`, after each lifecycle transition write a `comment`+`recipient_ids:[requestor_id ?? user_id]` row with a stage-appropriate `notification_type` (the email copy for `notify_submitter_*` already exists in `notify_dispatch.ts:43-48` and is currently unreachable). Server-side, not client-side.

### F-3 (HIGH) — Legacy-path submitter notifications are dead rows (written without `recipient_ids`)
Four writer sites emit `notify_submitter_approved / notify_submitter_returned / notify_submitter_rejected` with `details` = `{notification_type, message}` and **no `recipient_ids`**:
- `src/pages/app/FinancialReview.tsx:247-256` (approved), `:289-297` (returned), `:301-309` (rejected)
- `src/pages/app/ApprovalQueue.tsx:1068-1078` (rejected)

The fanout trigger requires `details ? 'recipient_ids'` (`20260618180000:110`) and the email dispatcher skips rows without them (`dispatch-notifications/index.ts:59-60`). These rows reach **no one, on no channel** — yet `notify_dispatch.ts:43-48` carries polished email copy for exactly these types. The #123 "resolved" fanout never fixed the four writers that lack ids.
**Fix:** add `recipient_ids: [lease.requestor_id ?? lease.user_id]` — or better, move these writes into `legacy-lease-action` server-side (it already knows `requestor_id`, `legacy-lease-action/index.ts:154`).

### F-4 (HIGH) — Next sequential chain approver is never notified
Only the FIRST step's assignees are notified, client-side at submission (`LeaseRequestForm.tsx:397-404`). When an approval crosses a sequential level, `act-on-chain-step` computes `nextAssignees` (`index.ts:615-643`) and returns them in the response — the only callers throw them away (`ApprovalQueue.tsx:321-334` uses only `ok`/`error`; `SignatorReview.tsx:276-320` likewise). A 2-step concept chain: approver #2 hears nothing until they happen to open Approvals, then 7 days later the stuck-chain cron alerts admins (`detect-stuck-chains`). Same gap when concept completes: the pre-inserted signator rows exist but signators are only notified later when the requestor invokes `advance-to-final-review` — that leg is fine; the intra-stage sequential leg is not.
**Fix:** write the `notify_chain_step_users`/role notification inside `act-on-chain-step` when `advancedPastStepOrder` is true (it already computes recipients and sets `pending_since`, :624-642).

### F-5 (HIGH) — The in-app Notifications page is unreachable from navigation
The sidebar nav is Dashboard/Leases/Firm/Approvals/Portfolio/Reports (`src/components/layout/AppSidebar.tsx:297-302`) — no Notifications item, no unread badge. The header bell was deliberately removed with the rationale "the bell duplicated /app/notifications" (`AppHeader.tsx:28-29`) — but nothing else links there. The only in-product link is one onboarding-checklist item (`OnboardingChecklist.tsx:53`). Everything the #123 fanout trigger delivers (approver prompts, delegation notices, stuck-chain alerts, process-alerts rows) lands on a page users cannot find, with no unread indicator anywhere. Routes exist (`App.tsx:320,328`) but are orphaned.
**Fix:** restore a bell with unread count (query `notifications where read_at is null`) or a sidebar item with badge, mirroring the existing `approvalBadge` pattern (`AppSidebar.tsx:300`).

### F-6 (MEDIUM-HIGH) — `alert_rules` has no product surface; the whole threshold-alert engine is dead for customers
`process-alerts` evaluates `alert_rules` (`process-alerts/index.ts:296-299`); the only frontend reference to `alert_rules` is the generated types (`src/integrations/supabase/types.ts:17`). No page creates/edits rules; no migration seeds defaults per workspace. The Alerts tab's empty state ("System alerts will appear here when thresholds are breached", `Notifications.tsx:224-226`) is unfulfillable without Studio inserts. Note `approval_pending` (SLA breach) alerts also live here — so the *only* built approval-SLA warning path is dead too.
**Fix:** seed sensible default rules on workspace creation (expiry 90d, approval_pending 7d) and/or add a small settings card in WorkspaceSettings.

### F-7 (MEDIUM) — Reroutes silently change who must approve
After a material-change reroute adds/supersedes steps: no notification to newly added approvers (verified: `process-pending-reroute-evaluations/index.ts` writes no comment rows — zero grep hits for notify/recipient; `admin-trigger-manual-reroute/index.ts:194-270` writes only `manual_reroute_*` audit rows). The submitter gets a passive modal on their NEXT visit to that lease (`RerouteNotificationModal.tsx` — localStorage `SEEN_PREFIX`, submitter-only, mounted `LeaseReview.tsx:2872`). New approvers can sit unaware until stuck-chain fires at day 7.

### F-8 (MEDIUM) — `send-nudge` nudges the wrong people: every pending required step, not the active frontier
`send-nudge/index.ts:95-108` selects `lease_approval_chain` rows `status='pending', is_required=true` with **no step_order/stage frontier filter**. In this schema, future sequential steps and pre-inserted signator rows are also `status='pending'` (see `findFirstPendingAssignees`, `_shared/approval_chain.ts:111-128`, which exists precisely to compute the frontier). A nudge on a step-1-pending lease emails step-2 approvers and the signator "a lease is awaiting your approval" — false. Latent today only because of F-1.
**Fix:** reuse `findFirstPendingAssignees` per stage, and only for the stage matching the current lifecycle.

### F-9 (MEDIUM) — Soft-deleted leases keep notifying for up to 14 days
The lease soft-delete rail (`deleted_at`, migrations `20260625130000`) is filtered by the four sites CLAUDE.md names — but **none of the notification crons filter it**: `send-counter-signature-reminder/index.ts:141-146` (selects by `lifecycle_status='pending_counter_signature'` only), `detect-stuck-chains/index.ts:67-71` (chain rows of deleted leases stay `pending` — `delete-lease/index.ts` never supersedes them, no `lease_approval_chain` reference in the file), `process-alerts/index.ts:327-332`, `send-lease-notifications/index.ts:138-151`, `notify_dispatch.ts:129-133`, `send-nudge/index.ts:58-62`. All check *workspace* liveness only. Result: reminders/stuck alerts/expiry alerts about a lease every recipient's RLS hides (`leases_hide_soft_deleted`), with dead deep links.
**Fix:** add `.is('deleted_at', null)` to each lease read; have `delete-lease` supersede pending chain rows.

### F-10 (MEDIUM, security/integrity) — `notifications` UPDATE/DELETE RLS lets any authenticated user tamper with broadcast rows
`baseline_schema.sql:4269` (`notifications_delete`) and `:4290` (`notifications_update_read`) both `USING ((user_id = auth.uid()) OR (user_id IS NULL))` with **no workspace scoping** and an UPDATE `WITH CHECK` that constrains nothing but `user_id`. Every `process-alerts` row is `user_id IS NULL` (broadcast). Consequences: (a) any member can edit a broadcast alert's `title`/`body` or delete it for the whole workspace; (b) one member marking a broadcast alert read (`Notifications.tsx:142-145`) hides "unread" for everyone; (c) an unfiltered `UPDATE`/`DELETE` (no WHERE) can reach `user_id IS NULL` rows **across workspaces** (filtered queries pull in the workspace-scoped SELECT policy, but a bare statement is found via the UPDATE/DELETE USING alone). Not modified by later policy migrations (only `20260613000000` added a restrictive INSERT gate; `20260623160000` doesn't touch `notifications`).
**Fix:** scope UPDATE/DELETE to workspace membership; restrict UPDATE to `read_at` (column-level or trigger); consider per-user read-state rows instead of shared `read_at`.

### F-11 (MEDIUM) — Approval notifications on the legacy/submission paths are client-side fire-and-forget
Submission (`LeaseRequestForm.tsx:374-404`), retry (`retryRequestRouting.ts:98-103,147`), manager-approve (`ApprovalQueue.tsx:1013-1031`) and all F-3 rows are written **by the browser after** the server action, with errors ignored (`leaseNotifications.ts:80-89` discards the insert result; no error handling at any call site). Tab closed / network blip between the edge call and the insert = approver never notified, no trace, no retry. The chain-side functions moved lifecycle writes server-side for exactly this reason (CLAUDE.md Lifecycle Transition Convention); notifications were left behind.
**Fix:** emit these rows inside `resolve-approval-chain` / `legacy-lease-action` (both already run service-role and know the recipients).

### F-12 (MEDIUM) — Silent governance: unlock requests and change sets notify no one, either direction
`request-lease-unlock/index.ts:143` writes only `unlock_requested`; approve/reject (`lease-governance-action/index.ts:261-330`) writes audit rows only; `handle-unlock-action` is a 410 tombstone (`index.ts:17-22`). Admins learn of unlock requests only by visiting the queue; the requester is never told the outcome. Same for `approve_change_set`/`reject_change_set` — the submitter of staged edits is never notified of the decision.

### F-13 (MEDIUM) — Quote/negotiation-document upload notifies nobody
`upload-lease-document/index.ts:282` writes `document_iteration_uploaded` only. In the owner's Path-1 model ("requestor brings quote back → manager approves/denies the quote"), the manager is never told a quote arrived; review of negotiation docs is purely pull-based. (The requestor CAN escalate for re-review — `EscalateToConceptDialog` → F-14 — but ordinary uploads are silent.)

### F-14 (MEDIUM-LOW) — Escalation notifies the legacy role cohort, not the rebuilt chain's actual assignees
`escalate-to-concept-approver/index.ts:375-396` notifies `workspace_roles.role='manager_approver'`, but the C4 fix rebuilds the concept stage from the live **policy** (whose steps may be direct users without that role). If no one holds `manager_approver`, `recipientIds.length===0` and the notification is silently skipped (:384). The resolver response contains the fresh assignees — use them.

### F-15 (MEDIUM-LOW) — Extraction failure is silent
Success emails the uploader (pref-gated, `process_lease/index.ts:2665-2714`); failure just sets `status='Failed'`+`error_message` (:2206, :2335), and `reclaim-stuck-extractions` flips stuck rows to Failed with zero notify code (grep: no matches). A user who uploads and walks away (the exact persona the success email serves) never learns it failed.

### F-16 (LOW-MEDIUM) — Email/alert deep links land where the action isn't
`notify_dispatch.ts:17,146` hardcodes `https://app.theleaseio.com/app/leases/{id}` for every type — including approver-action types, but LeaseReview has **no chain approve/reject surface** (grep for ApprovalPanel/chain-act in `LeaseReview.tsx`: none); actions live at `/app/approvals` (`ApprovalQueue.tsx`) or `/app/leases/:leaseId/signator-review`. `detect-stuck-chains/index.ts:178` embeds the literal string "/app/admin/exceptions" in the message body (not a link) while the button still points at the lease. In-app alert cards likewise always navigate to the lease (`Notifications.tsx:253`).

### F-17 (LOW-MEDIUM) — Notification preferences are inconsistently honored, and one is a dead toggle
`profiles.email_notifications_enabled` is respected by `process-alerts` (:243) and `process_lease` (:2673) — but **not** by `notify_dispatch.ts` (selects only `email`, :160-161), so approval prompts, nudges, counter-sig reminders and stuck-chain emails ignore the AccountSettings "Email notifications" master toggle (`AccountSettings.tsx:217-223,349-351`). `sms_notifications_enabled` is stored and toggleable (`AccountSettings.tsx:222,350`) with **no SMS code anywhere in the repo**. Decide and document which emails the toggle governs; remove or build the SMS toggle.

### F-18 (LOW) — Assorted dead/orphaned pieces
- `useLifecycleWorkflow.sendNudge` (`src/hooks/useLifecycleWorkflow.ts:349-394`) — the pre-#109 dead nudge (writes `lease_nudges` only, notifies no one); the hook has **no importers** (`App.tsx:184` says the page using it was retired). Dead code that contradicts the current server cooldown (24h vs 30min).
- `escalation_reactivation_failed` comment rows lack `recipient_ids` (`escalate-to-concept-approver/index.ts:315-323,333-341`) — dead rows (caller does get the HTTP error, so impact is audit-noise only).
- `RESEND_APPROVALS_FROM_EMAIL` is documented as the "approval-notification sender" (`.env.example:56`) but the approval dispatcher never reads it (only `generate-summary-token/index.ts:188` does); approval emails send from `RESEND_FROM_EMAIL`.
- `_extractLeaseDataWithOpenAI_DEPRECATED` (`process_lease/index.ts:1242-1648`) — 400 lines of dead OpenAI code incl. `api.openai.com` fetch; unreferenced, but sits in a repo whose hard rule #3 says "No OpenAI". Flagging for the extraction reviewer.
- Notifications page "Alerts" tab label is hardcoded English (`Notifications.tsx:199`) while sibling tabs are localized; alert/event queries have **no workspace filter** (`Notifications.tsx:102-105,121-129`) so multi-workspace users see other workspaces' items mixed into the current workspace context.

---

## 4. Docs-vs-code drift

| Claim | Reality |
|---|---|
| KNOWN_ISSUES #109: "NudgeApproverButton rewired… BUILT" | Component rewired but its only mount is behind hardcoded `isPendingApproval = false` (`LeaseReview.tsx:436`) — never renders. |
| KNOWN_ISSUES #123: notification rail "RESOLVED (in-app)"; "~17 writers" fan out | Fanout works only for rows WITH `recipient_ids`; the 4 submitter-outcome writers lack them (F-3), and the destination page is unreachable from nav (F-5). |
| CLAUDE.md file map: `src/hooks/useLifecycleWorkflow.ts` listed under Path-1 workflow | Hook has zero importers; retired per `App.tsx:184`. |
| `.env.example:56` `RESEND_APPROVALS_FROM_EMAIL` "approval-notification sender" | Read only by `generate-summary-token`; `notify_dispatch` uses `RESEND_FROM_EMAIL`. |
| Fanout migration scope note ("send-counter-signature-reminder sends no email despite its name") | Superseded — it writes a `recipient_ids` row the dispatcher emails; the stale note survives in the migration file (`20260618180000:29-31`). |
| CLAUDE.md hard rule #3 "No OpenAI" | Dead-but-present OpenAI fallback in `process_lease/index.ts:1242-1648`. |

---

## 5. Rebuild vs fix

**Fix.** The delivery architecture is genuinely sound: one canonical row shape, an idempotent email dispatcher with a failure ledger (hard rule #9 compliant), an in-app fanout trigger, workspace-liveness gates everywhere. Every major failure is a small, well-localized gap: one hardcoded boolean (F-1), four writers missing one array field (F-3), missing writes at four chain transitions (F-2/F-4), one missing nav entry (F-5), missing `deleted_at` filters (F-9), a frontier filter in send-nudge (F-8). A focused 2–3 day pass closes the top six; nothing here argues for re-architecture.

**Suggested fix order:** F-1 → F-2 → F-3 → F-5 → F-4 → F-8 → F-6 → F-9 → F-7/F-11 (move writes server-side) → rest.

**Simplification note for the owner:** there are effectively three parallel notification vocabularies today (activity-log rail, `lease_notifications` date scheduler, `notifications` alerts). The Notifications page mixes two of them across four tabs and is itself unreachable. Consolidating the user-facing story to ONE inbox ("things that need you" + "things that happened") with one badge would remove more confusion than any copy fix.
