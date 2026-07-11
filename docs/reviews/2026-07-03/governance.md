# Post-Approval Governance Review — LeaseIO

Reviewer scope: locking, unlock/change-set flow, attestation, the three removal paths (archive / 14-day soft delete / import hard delete), cancellation lifecycle, Vault read-only enforcement. Everything below was verified against code in `/home/user/leaseio_staging`; docs were used for intent only.

---

## 1. How the lock actually works (as built, verified)

**When a lease locks.** `model_locked` flips true only at activation. The server-side writer is `legacy-lease-action` `model_lock` (`supabase/functions/legacy-lease-action/index.ts:401-411`): sets `model_locked`, `model_locked_at`, `model_locked_by`, `lifecycle_status='active'`, `status_changed_at`, and writes the convention activity row (`:464`). The browser cannot flip these — `prevent_unauthorized_lease_workflow_edits` (baseline `20260516120000_baseline_schema.sql:575-607`) rejects any authenticated write to lifecycle/lock/approval columns, and `prevent_locked_lease_edits` (`:526-569`) freezes every other column of a locked lease except a deliberate allowlist (`updated_at`, the 7 `vendor_*` columns, the 3 `archived*` columns).

**Locked+active rendering.** `LeaseReview.tsx:2728-2730` early-returns to `LockedLeaseDetail` for `model_locked && lifecycle_status==='active'`; the read-only card layout with tabs, unlock affordances in `LockedHeader`.

**Who can request unlock.** Any workspace member or owner (`request-lease-unlock/index.ts:69-93`), only for locked+active leases (`:96-100`), one pending request per lease (`:102-114`). Writes `unlock_requested` to both `lease_activity_log` (`:140-145`) and the append-only `lease_governance_audit` (`:148-156`).

**Who approves.** Workspace owner or accepted admin (`lease-governance-action/index.ts:122-139`) via `approve_unlock_request`/`direct_unlock`; change-set approval additionally admits `workspace_roles.role='financial_approver'` (`:141-151`). Approve = unlock + create/reuse a draft change set; edits stage into `lease_change_set_items` (`LeaseReview.tsx:682-709`); submit re-locks the lease and flips the set to `pending_approval` (`lease-governance-action:748-776`); approver applies via `FIELD_TO_COLUMN` and re-locks (`:494-575`), or admin self-approves with `self_approved=true` (`:625-721`). Approve/reject surfaces exist in `ApprovalQueue.tsx:907-965` and on the lease pages.

**#158 guard — verified RESOLVED as claimed.** Partial unique index `lease_change_sets_one_open_per_lease` exists (`supabase/migrations/20260626150000_changeset_one_open_per_lease.sql:27-29`); `createDraftChangeSet` catches the 23505 race and reselects the winner (`lease-governance-action:225-235`); `hasPendingChangeSet` 409-guards both unlock branches (`:245-254`, `:317-319`, `:398-400`). Code matches KNOWN_ISSUES #158's as-built note.

**Tamper hardening — verified real.** `lease_governance_audit` is service-role-append-only (`20260516130000_restore_governance_hardening.sql:43-46`); change-set state columns are trigger-guarded (`prevent_change_set_field_tampering`, `20260517000000:415-532`); items are draft-only mutable (`20260517000000:284-333`); the 26-key `audit_rls_smoke_check` pins all of it. This layer is genuinely well built.

---

## 2. GAPS (functional / security)

### G1 — HIGH: `delete-lease` / `restore-lease` skip the workspace-liveness gate every other mutator enforces → leases in a Vault/grace workspace are permanently destructible
`_shared/workspace_live.ts:1-4` states the invariant: "every user-invokable mutator must check this explicitly" (service_role bypasses the restrictive RLS). `lease-governance-action` (`:106-120`), `request-lease-unlock` (`:60-67`), `legacy-lease-action`, and ~20 other functions comply. **`delete-lease/index.ts` and `restore-lease/index.ts` contain no `checkWorkspaceLive` call at all** (verified by grep — zero hits). `delete-lease` authorizes any workspace admin/owner (`delete-lease/index.ts:114-118`) and then soft-deletes as service role (`:133-146`); 14 days later `process-lease-retention` hard-purges row + audit trail + storage regardless of workspace state (`process-lease-retention/index.ts:126-234`). Consequences:
- An admin of a **Vault** workspace (sold as a read-only, audit-defensible retention repository; VaultBanner.tsx:3-11) can permanently destroy any lease via a direct call to the deployed function — the UI merely hides the kebab (`Leases.tsx:995`), which is exactly the "UI-only authorization" class the project's own rules flag.
- During a **cancellation grace window**, a departing admin can delete leases; if the company renews on day 20, the leases purge anyway on the cron.
This contradicts the Vault V1 invariant stated in the functions themselves ("no mutations on canceled / soft-deleted / vault workspaces (fail closed)", `lease-governance-action:106-108`). **Fix:** add the same `checkWorkspaceLive` 403 to `delete-lease` (and, for symmetry, decide `restore-lease`'s posture — restore is arguably legitimate in grace); consider having `process-lease-retention` defer purges for non-live workspaces.

### G2 — HIGH: change-set apply writes staged text verbatim into typed columns — cast failures break approval with a generic 500
Staged values are raw strings: `stageFieldChange` stores `proposed_value: newValue ?? ''` (`LeaseReview.tsx:687-696`) and explicitly supports clear-to-empty (`:683-686`). Number fields render as free-text inputs while editing (`LeaseReviewSections.tsx:404-406`; field types at `src/lib/leaseReviewSectionConfig.ts:54,75-76`). On approve, the edge function assigns the string directly: `leaseUpdate[column] = item.proposed_value` (`lease-governance-action:500-509` and self-approve `:633-642`) — no parsing, unlike the draft-save path which does `parseFloat(form.current_monthly_rent.replace(/[^0-9.]/g,''))` (`LeaseReview.tsx:1651-1652`). So:
- `current_monthly_rent` (numeric), `term_months` (int), `square_footage` (numeric): a user typing "3,600" or "$3,600" produces a Postgres `22P02` at approval time.
- Clearing a date field (`lease_start`/`lease_end`/`rent_commencement_date`) stages `''`, which is an invalid date literal.
The thrown error is swallowed into the generic `{"error":"Governance action failed"}` 500 (`:858-861`); the approver has no idea which field is bad, the submitter's edit session is already closed, and the change set is stuck in `pending_approval` (which also blocks any further unlock via the #158 guard — a lease-level deadlock until someone rejects the set). **Fix:** normalize/validate per-column at stage time or in the apply path (map `''`→NULL, strip currency formatting, validate dates), and return a field-specific 422.

### G3 — MEDIUM (tracked, confirmed still open — KNOWN_ISSUES #A7): apply path never recomputes `calc_*`
`FIELD_TO_COLUMN` includes calc inputs (`current_monthly_rent`, `term_months`, `base_rent_amount`, `lease_start/end`, `rent_escalation_type`) but the apply path (`lease-governance-action:500-524`, `:633-659`) writes only the raw columns; `calc_total_commitment` / `calc_pv_liability` / `calc_straight_line_exp` / `calc_cash_pl_delta` are recomputed only on the client draft-save/resubmit paths (`LeaseReview.tsx:1671-1693`, `:490-506`). Approved governed edits leave portfolio/report analytics stale. Verified no calc writes exist in the function (grep). Filed as #A7 2026-06-23, still unfixed.

### G4 — MEDIUM-HIGH: an approved rent change can be invisible on the locked page (rent_schedules never updated, and the display prefers the schedule)
`LockedLeaseDetail` documents `leases.current_monthly_rent` as "unreliable" and derives displayed rent from `rent_schedules` first (`LockedLeaseDetail.tsx:163-200`, used `:429-432`). But the governed edit path can only change `current_monthly_rent` — the schedule table is deliberately not editable in an unlock session (`LeaseReview.tsx:3503-3510`, "must wait for governed routing (Stream C)") and the apply path never touches `rent_schedules`. Net effect: a user requests unlock, edits the rent, an approver approves — and the locked detail page still shows the old schedule-derived rent. The approved change "took" in the column but not in the primary display, exports keyed off the schedule, or the Critical Dates strip. **Fix:** on apply of a rent-affecting field, either regenerate/flag the schedule or at minimum surface a "schedule out of date vs approved terms" banner.

### G5 — MEDIUM: vendor fields on a LOCKED ACTIVE lease are directly editable with NO audit trail
The lock trigger deliberately ignores `vendor_name/phone/address_*` (`baseline_schema.sql:533-545`; archived carveout `_archive/20260429000004`). `VendorCard.tsx:57-82` does a plain client `leases.update(...)` and **writes no `lease_activity_log` row and no governance audit row** — unlike every other locked-lease writer (risk dismiss logs at `LockedLeaseDetail.tsx:264-275`, ASC842 at `Asc842InputsTab.tsx:291-295`, discount rate at `LeaseDiscountRateCard.tsx:145-149`). `vendor_name` is simultaneously a *governed* change-set field (`lease-governance-action:43 FIELD_TO_COLUMN`), so the same field has a full approval+audit path and a silent bypass path. Any member with lease UPDATE access can also PATCH vendor_* via PostgREST with no trail. Violates "every post-active edit is attributable." Not in KNOWN_ISSUES. **Fix:** log a `vendor_updated`-class activity row on save (add to the client-insert allowlist), or fold vendor edits into the change-set path for locked leases.

### G6 — MEDIUM (tracked, open — KNOWN_ISSUES #21): `lease_unlock_requests` UPDATE policy is tamper-open
`baseline_schema.sql:3935-3940`: requesters and admins can UPDATE unlock requests with no `WITH CHECK` and no field-tampering trigger (the #17 hardening covered change sets only). A requester can PATCH their own pending request to `status='approved'`, forge `reviewed_by`/`review_note`. It does NOT unlock the lease (lock columns are trigger-guarded), but it forges a governance record shown to admins and 409-blocks the real admin action (`lease-governance-action:271-273`). #21 filed the audit; never closed.

### G7 — MEDIUM (tracked, open — KNOWN_ISSUES #159): `lease_change_sets` INSERT open to any member
`baseline_schema.sql:4534` lets any member insert a draft directly, bypassing `createDraftChangeSet`'s audit event. Post-#158 the unique index prevents duplicate open sets, but the un-audited creation path remains.

### G8 — MEDIUM: committed-but-not-yet-locked leases' source PDFs are client-deletable in storage with no trail
The storage destruction guard covers `model_locked` leases only (`20260613030000_destruction_guards.sql:53-65`). `model_locked` flips only at activation (confirmed in `20260618140000:33-37`), so a lease at `submitted` / `under_review` / `executed` / `fully_executed` is row-protected (`prevent_committed_lease_hard_delete`) but its source PDF in the `leases` bucket is deletable by its uploader (`20260516120001_storage_policies.sql:26`: bucket `leases`, folder = own uid). Related: `ImportHistory.tsx:174-202` deletes storage and risks BEFORE the row delete the trigger might reject — the UI steer (`:353 isCommittedLease`) makes it unlikely, but the defense-in-depth ordering destroys evidence before the backstop fires.

---

## 3. UX issues

### U1 — MEDIUM-HIGH: the whole unlock/change-set loop is silent — nobody is notified of anything
- `request-lease-unlock` writes activity+audit only (`:140-156`) — no `notifications` insert, no email; grep of `dispatch-notifications` and `send-lease-notifications` for "unlock" returns nothing. An admin learns of a request only by visiting Approval Queue or that lease.
- Change-set submit/approve/reject notify nobody. The reject toast tells the *approver* "submitter can revise or cancel" (`ApprovalQueue.tsx:953`) but the submitter is never told, and a rejected set is terminal — the lease is already re-locked, so "revise" actually means "start a new unlock cycle." Misleading copy on top of a missing notification.
- `useNeedsAction.ts` surfaces only *draft* change sets (`:59-66,106-111`) — pending-approval sets and pending unlock requests never reach the dashboard.
Given the product has a nudge/notification rail for chain approvals (#109/#123), the governance lane is a conspicuous dead zone.

### U2 — MEDIUM: the Lock dialog's "Send approval request to:" picker is decorative
The dialog loads candidates and requires a selection (`LeaseReview.tsx:1036-1107`, `:3806-3828`, submit disabled without one `:3880`), the server validates the target is an admin/owner and stores `requested_approver_id` (`lease-governance-action:727-746,763`) — and then **nothing consumes it**: no notification, no ApprovalQueue filter (it lists all pending sets to any admin/financial approver, `ApprovalQueue.tsx:845-853`), not even display of the requested reviewer. Grep confirms the only writers/readers are the edge function + generated types. A user picks a person; that person never finds out. Half-built feature.

### U3 — MEDIUM: unlock "reason" is displayed everywhere but collectable nowhere
Both request paths send `{leaseId}` only (`LeaseReview.tsx:1935-1937`; `LockedLeaseDetail.tsx:323-325`), so the server always stores 'No reason provided' (`request-lease-unlock:117`). Yet three surfaces render the reason (`LockedHeader.tsx:214-218`, `LeaseReview.tsx:3380-3382`, ApprovalQueue). Admins will forever review reason-less requests. Same pattern for delete: `delete-lease` accepts `reason` (`:94`) and stores `deletion_reason`, but `Leases.tsx:359-361` never sends one and `DeleteLeaseWithRetentionDialog` has no input — the forensic column is always NULL.

### U4 — MEDIUM (tracked — #153): no "recently deleted" view; restore is toast-or-support
`leases_hide_soft_deleted` hides soft-deleted leases from every authenticated read (`20260625130000:62-67`). The only self-serve restore is the transient Undo on the success toast (`Leases.tsx:365-370`); after that, the honest dialog copy says "contact support" (`leases.delete_desc`). `restore-lease` is built and ready; the listing endpoint isn't.

### U5 — LOW/MEDIUM: three removal paths are mostly comprehensible, with two copy regressions
The Archive vs Delete distinction is well drawn in the kebab (`Leases.tsx:1004-1022`) and dialog copy is honest about the 14-day window. But: (a) `archive.deleted_banner` still says the lease is 'hidden from the Leases list unless "Show archived" is on' (en/es `common.json`) — the redesign replaced that toggle with a Status scope whose default 'all' actually SHOWS archived leases (`Leases.tsx:182-185`); (b) `LockedHeader.tsx:100-103` styles the Archived pill destructive-red and the archived banner destructive (`:186-191`) while archive is explicitly non-destructive — a residue of the #92 vocabulary problem. (c) ImportHistory's third path (true hard delete) is correctly confined to disposable drafts (`isCommittedLease` steer `:353`, DB backstop `20260618140000`).

### U6 — LOW: one-click admin unlock without confirmation or note on the locked page
`LockedHeader` "Unlock" (`:127-137`) fires `direct_unlock` immediately — no dialog, no note — while the same action in ApprovalQueue collects a review note. An accidental click opens an edit session (recoverable, relock discards).

### U7 — LOW: un-approve ("Reopen") leaves no trail; `_approval` attestation is client-forgeable pre-lock
`handleReopenLease` strips `extracted_json._approval` with no activity row (`LeaseReview.tsx:1798-1826`); approve does log (`:1770-1780`). Pre-lock, any member with UPDATE access can write arbitrary `_approval` (it lives in client-writable `extracted_json`; the code itself notes it is "overwritable by re-extraction" `:1767-1769`).

---

## 4. Cancellation lifecycle & Vault — verified sound (with the G1 exception)

- **Spec vs code:** `docs/CANCELLATION_LIFECYCLE_SPEC.md` matches `process-cancellation-lifecycle/index.ts` — notice ledger claim-first (`:179-194`), per-recipient outcomes recorded (`:226-231`), soft-delete conditional on `canceled_at` still set (`:287-292`), purge order re-verify → Stripe cleanup (defer on failure `:351-361`) → forensic row first (`:389-411`) → conditional deletes → storage last (`:429-438`), self-heal orphans (`:444-452`). Pure logic mirrors are in sync (diff of `src/lib/cancellationLifecycle.ts` vs `_shared/cancellation_lifecycle.ts`: identical).
- **Cron wiring:** pg_cron schedules exist in-repo for cancellation (`20260612170000`) and lease retention (`20260625130100`), fail-closed on missing secrets. **`vault-renewal-reminder` has NO cron.schedule migration** — operator STOP 10; until scheduled it never runs (documented, but note the whole no-surprise-billing promise is inert).
- **Vault server-side read-only:** the restrictive layer (`20260613000000`) gates INSERT/UPDATE/DELETE across 25+ tables + storage; `#83` blocks client workspace DELETE and `#77` locked-file deletion (`20260613030000`); the read-only frontend gate is the shared `isWorkspaceReadOnly` helper covering Vault AND grace (#136/#137 verified adopted at `LeaseReview.tsx`, `Leases.tsx:995`, Dashboard, Reports). `SoftDeletedWall`/`VaultMemberWall` mount correctly (`AppLayout.tsx:37-76`), AI assistant unmounted on Vault (`:76`). The one hole is G1.
- **Retention purge quality:** forensic row carries the full pre-CASCADE activity-log snapshot (`process-lease-retention:140-201`), restore-wins conditionals (`:129-135`, `:209-213`), lease-reports paths resolved before CASCADE (`:163-171`). Good work.
- **`handle-unlock-action`** is a deliberate 410 tombstone (`handle-unlock-action/index.ts`) referenced by nothing (grep clean) — retired email-link endpoint; fine, but worth a README note so it isn't mistaken for a live surface.

## 5. Docs drift

1. `docs/CANCELLATION_LIFECYCLE_SPEC.md:76` — "grace read-only currently covers processing + pack purchases only; broader write-gating is KNOWN_ISSUES #75" is stale: the V1 restrictive layer (`20260613000000`) now gates all writes and #75 is stamped RESOLVED. Minor but the spec is the ratified reference.
2. `docs/CANCELLATION_LIFECYCLE_SPEC.md:37-44` instructs the operator to create the cron job manually in the Dashboard; migration `20260612170000` now schedules it via `cron.schedule` (secret via `private.cron_secrets`). The manual instruction is superseded/duplicative — following it would double-schedule.
3. `_shared/workspace_live.ts:3-4` documents "every user-invokable mutator must check this explicitly" — contradicted by `delete-lease`/`restore-lease` (G1); either the code or the invariant is wrong, and it's the code.
4. KNOWN_ISSUES #158 "RESOLVED" — verified TRUE against code (index + 23505 handling + 409 guards). No drift.

## 6. Recommendations (priority order)

1. Add `checkWorkspaceLive` to `delete-lease` (403 `subscription_inactive`) and decide `restore-lease`/retention-cron posture for non-live workspaces (G1).
2. Normalize staged values on apply — `''`→NULL, currency/thousands stripping for numeric columns, date validation — with a 422 naming the bad field; add a test staging "$3,600" + a cleared date (G2).
3. Close #A7 (recompute `calc_*` in the apply path — port `leaseCalculations` to a Deno mirror) and reconcile `rent_schedules` visibility after approved rent edits (G3/G4).
4. Give VendorCard an audit row (or route locked-lease vendor edits through the change set) (G5).
5. Wire notifications for unlock-requested / change-set-submitted / approved / rejected — and either make `requested_approver_id` mean something (notify + badge in ApprovalQueue) or drop the picker (U1/U2).
6. Add the reason textarea to the unlock-request and delete dialogs — the plumbing already exists end-to-end (U3).
7. Ship the "Recently deleted" admin view (#153) — `restore-lease` is ready; needs a service-role list endpoint (U4).
8. Copy fixes: rejected-change-set toast, `archive.deleted_banner` "Show archived" reference, LockedHeader's destructive-red Archived styling (U5, U1).
9. Track/close #21 (unlock-request WITH CHECK/tamper trigger) and #159 (change-set INSERT policy) — both are open hardening stubs in a lane that is otherwise excellent.

**Verdict: FIX.** The governance core (lock triggers, append-only audit, change-set tamper guards, forensic purge lifecycle, restrictive read-only layer) is coherent, defense-in-depth, and matches its documentation almost everywhere. The defects are point gaps — two high (G1, G2), a cluster of half-wired UX (notifications, reason fields, requested approver), and tracked residuals — not architectural flaws.
