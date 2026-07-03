# LeaseIO Audit — Identity & Permission Model (As-Built)

Reviewer lane: auth, membership/functional roles, invites, route guards, RLS-vs-UI enforcement.
All claims verified against code in `/home/user/leaseio_staging` (repo = source of truth). Docs cited only to flag drift.

---

## 1. Executive summary

LeaseIO has **two parallel role systems** plus an implicit third (ownership), and a fourth overlay (firm roles):

1. **Ownership** — `workspaces.owner_id` (no member row required). Owner is a super-role everywhere.
2. **Membership roles** — `workspace_members.role`, Postgres enum `workspace_role` = `admin | editor | viewer` (baseline `20260516120000_baseline_schema.sql:49-53`, table at `:2062-2071`). This is what RLS and `RequireRole` gate on.
3. **Functional roles** — `workspace_roles.role`, free-text with CHECK `submitter | manager_approver | financial_approver | signator | admin` (baseline `:2095-2102`). This is what approval routing and the governance edge functions gate on. A user can hold several.
4. **Firm roles** — `firm_members.role` (`firm_admin | firm_member`), which the docs promise maps to workspace authority but which the code does **not** actually plumb (see §8).

The **server-side core is genuinely enforced**: lifecycle/approval mutations are blocked at the DB by the `prevent_unauthorized_lease_workflow_edits` trigger (baseline `:575-607`) and only flow through `legacy-lease-action` / `act-on-chain-step` / `resolve-approval-chain` / `lease-governance-action`, each of which re-derives authorization server-side. That part is solid.

Around that core, however, the permission model is **frayed at every edge**: the `viewer` role's "read-only" promise is false at both UI and RLS layers; admin member-management is a silent no-op that writes *false audit rows*; removing a member does **not** revoke their functional roles or step assignments (offboarded users retain real write/approval power); the `signator` role — the pivot of the Path-1 CFO gate — has **no assignment UI, is missing from the frontend type, and its notification fan-out can never fire**; and a large fraction of the authorization API surface (`hasPermission`, `hasFunctionalRole`, `canUploadExecutedDocument`, `canAccessVarianceReview`, the entire `firmAccess` effective-access module) is dead code with zero call sites.

Verdict: **fix, not rebuild.** The enforcement skeleton (trigger + edge-fn authorization + RLS helpers) is correct architecture. The work needed is reconciliation: one role-revocation path, one signator assignment surface, one honest viewer policy, and deletion of the dead half-APIs.

---

## 2. Identity layer (what exists)

| Piece | File | Notes |
|---|---|---|
| Session/auth context | `src/contexts/AuthContext.tsx` | Thin wrapper on supabase-js. Sign-in fires `record-login-event` fire-and-forget (`:56`). SIGNED_OUT clears recent-workspaces list (`:33-37`). |
| Login | `src/pages/Login.tsx` | Reads `?next=` (`:65-67`). **Bug:** `rememberMe` checkbox state (`:19`, `:143-150`) is captured and never used — dead control. **Bug:** `ProtectedRoute` redirects with `state={{ from: location }}` (`src/components/auth/ProtectedRoute.tsx:25`) but Login never reads `location.state.from` — deep-link-after-login only works for the `?next=` flows AcceptInvite constructs; a session-expired user on `/app/leases/xyz` always lands on `/app/dashboard`. |
| Signup | `src/pages/Signup.tsx` | Standard; `next` param restricted to same-origin relative paths (`:156-160`). Routes to `/app/onboarding?plan=…`. |
| Onboarding | `src/pages/app/Onboarding.tsx:84-113` | Client-side `workspaces` INSERT (RLS `Users can create workspaces` WITH CHECK `owner_id = auth.uid()`, baseline `:3823`) + self-insert into `workspace_members` as `admin` with full timestamps. **No `workspace_roles` rows are seeded** — a fresh workspace has zero functional roles, so the legacy router auto-approves everything (see §6). |
| Forgot/Reset password | `src/pages/{ForgotPassword,ResetPassword}.tsx` | Standard supabase recovery; ResetPassword relies on the recovery session (`:21-27`). |
| Profile bootstrap | `handle_new_user()` trigger fn (baseline `:306-317`); trigger `on_auth_user_created` lives on `auth.users` (only visible in `migrations/_archive/20260110050403…sql:18-23` — public-schema dump omits it). Inserts `(id, email)` only. |
| Login activity | `supabase/functions/record-login-event/index.ts` | Correct: server-derived IP (last XFF entry / cf-connecting-ip, `:55-60`), self-scoped insert, 25-row retention. `login_events` RLS = read-own (`20260612220000:35`). |

---

## 3. The two role systems, precisely

### 3.1 Membership roles (`workspace_members.role`)
- Enum `admin | editor | viewer`; default `viewer` (baseline `:2067`).
- `owner` is **not** a member role — it is `workspaces.owner_id`; the frontend synthesizes `userRole = 'owner'` (`src/contexts/AppContext.tsx:175-176`), and `src/lib/authorization.ts:6-9` normalizes `owner → admin` for every check.
- Frontend type: `WorkspaceRole = 'admin' | 'editor' | 'viewer'` (`src/types/index.ts:38`).
- Every membership row in practice has `accepted_at` set at creation (Onboarding `:102-110`, accept-invite `:154-161`/`:281-288`, send-invite direct-add `:223-226`) — there is no "pending member" state in `workspace_members`; pending invites live in `invite_tokens`.

### 3.2 Functional roles (`workspace_roles.role`)
- CHECK: `submitter | manager_approver | financial_approver | signator | admin` (baseline `:2101`), UNIQUE (workspace, user, role) `:2413-2414`.
- Frontend type: `FunctionalRole = 'submitter' | 'manager_approver' | 'financial_approver' | 'admin'` (`src/types/lifecycle.ts:76`) — **`signator` is missing from the type** even though the DB, the policy editor (`src/pages/settings/ChainDiagram.tsx:56-66` offers "Signatory"), and Phase 5 all depend on it.
- Loaded into context per active workspace (`AppContext.tsx:288-297`).
- RLS on `workspace_roles`: SELECT any member; INSERT/UPDATE/DELETE owner **or admin member** (baseline `:4686-4722`). Neither the policies nor the `set_workspace_roles` RPC (`20260621120000:30-97`) validate that the **target `user_id` is a member of the workspace** — an admin can (via API) grant functional roles to arbitrary auth users, and those grants confer real RLS power (see §5, finding F-1/F-6).

### 3.3 Are they redundant? (owner asked for simplification pushback)
Partially. `workspace_roles.role='admin'` vs `workspace_members.role='admin'` are two different "admin" bits that the code must constantly reconcile (`legacy-lease-action/index.ts:210-224` literally comments "Admin-on-workspace_members ≠ functional admin; check explicitly"). `submitter` grants nothing and restricts nothing server-side (its only effect is hiding the Approvals nav item, `src/lib/authorization.ts:33-37` + `AppSidebar.tsx:292-300`). The genuinely load-bearing functional roles are exactly two: `manager_approver` and `financial_approver` (plus the never-assignable `signator`). Recommendation in §10.

---

## 4. Permission matrix as-built

Legend for the "enforced at" column: **UI** = client-only gate; **RLS** = row-level security; **EF** = edge-function check; **TRG** = DB trigger.

### 4.1 By membership role

| Capability | owner | admin | editor | viewer | Enforced at | Evidence |
|---|---|---|---|---|---|---|
| Read workspace + leases + activity | ✅ | ✅ | ✅ | ✅ | RLS `is_workspace_member` | baseline `:3917`, `:4210` |
| **Create lease / lease request** | ✅ | ✅ | ✅ | **✅ (!!)** | RLS — membership only, no role check | baseline `:3845` (`Users can insert leases`); client insert `LeaseRequestForm.tsx:275-308`; "Add lease" button not role-gated `Leases.tsx:706-707` |
| Update lease fields | ✅ | ✅ | ✅ | own-created leases only (`user_id = auth.uid()`) — plus **any** lease if they hold a manager/financial/admin functional role | RLS | baseline `:4214-4216` |
| Delete lease (client path) | ✅ | ✅ | own-created | own-created | RLS | baseline `:4206` (`user_id = auth.uid()` OR admin) |
| Upload lease document (storage-backed) | ✅ | ✅ | ✅ | ❌ (403) | EF | `upload-lease-document/index.ts:181-201` (writer = admin/editor/owner) |
| Edit workspace settings (name, tz, thresholds, option lists) | ✅ | ✅ | ❌ | ❌ | UI + RLS | `authorization.ts:14`; `20260613060000:51-64` (owner + accepted admin), column guards by TRG |
| Reassign `owner_id` | ❌ (transfer flow only) | ❌ | ❌ | ❌ | TRG | `20260613060000:67-90` `enforce_workspace_owner_immutable` |
| Invite member (any role incl. admin) | ✅ | ✅ | ❌ | ❌ | EF | `send-invite/index.ts:144-155` |
| Revoke/resend/list invites | ✅ | ✅ | ❌ | ❌ | EF | `revoke-invite:60-80`, `resend-invite:160-182`, `list-pending-invites:39-59` |
| **Change member role / remove member** | ✅ | **UI shows it, RLS silently blocks (owner-only)** | ❌ | ❌ | UI≠RLS **mismatch** | UI gate `WorkspaceSettings.tsx:566` (admin+owner); RLS baseline `:3787`, `:3791` (`is_workspace_owner` only); writers `MemberRoleSelect.tsx:43-52`, `MembersPanel.tsx:114-127` |
| Assign functional roles | ✅ | ✅ | ❌ | ❌ | RPC + RLS | `set_workspace_roles` `20260621120000:47-58` |
| Approval-policy admin | ✅ | ✅ | ❌ | ❌ | UI (`RequireRole`) + RLS | `App.tsx:363-381`; baseline `:3989` |
| Reports: audit log | ✅ | ✅ | ❌ | ❌ | UI only (route) — underlying tables readable per-RLS by any member | `App.tsx:405-414`, `authorization.ts:23` |
| Reports: export CSV / rent roll | ✅ | ✅ | ✅ | ❌ | **UI only** (data is already RLS-readable by viewer) | `authorization.ts:25`; `RentRollExport.tsx:20` |
| Billing tab / checkout / portal | ✅ | ✅ | ❌ | ❌ | UI + EF | `get-billing-summary` (owner/admin-gated), `create-checkout`, `customer-portal` |
| Generate disclosure reports | ✅ | ✅ | ✅ | ❌ | RLS | baseline `:4220-4226` (`members initiate reports` admin/editor+owner) |

### 4.2 By functional role (server-enforced in edge functions)

| Capability | admin(func) | manager_approver | financial_approver | signator | submitter | Enforced at | Evidence |
|---|---|---|---|---|---|---|---|
| `manager_approve/reject` (legacy) | ✅ | ✅ | ❌ | ❌ | ❌ | EF | `legacy-lease-action:223-228` (owner/member-admin also pass) |
| `financial_approve/send_back/reject` (legacy) | ✅ | ❌ | ✅ | ❌ | ❌ | EF | `legacy-lease-action:224-231` |
| `model_lock` (activate/post a lease record) | ✅ | ❌ | ✅ | ❌ | ❌ | EF | `legacy-lease-action:232-234` |
| Act on a role-based chain step | if step's role | if step's role | if step's role | if step's role | n/a | EF | `act-on-chain-step:322-331` |
| Act on any chain step (override) | via *membership* admin/owner only | — | — | — | — | EF | `act-on-chain-step:333-351` |
| Self-approve staged change set | via *membership* admin/owner | ❌ | ❌ | ❌ | ❌ | EF | `lease-governance-action:625-629` |
| Update any workspace lease row (raw RLS) | ✅ | ✅ | ✅ | **❌ (signator omitted)** | ❌ | RLS | baseline `:4214-4216` |
| See Approvals nav | ✅ | ✅ | ✅ | ❌ (not in `canAccessApprovals`) | hides it | UI | `authorization.ts:29-37`, `AppSidebar.tsx:292-300` |
| Submit a lease request | any member can — role not required | | | | | none | `LeaseRequestForm.tsx` has no role check |

Notes:
- **`submitter` has zero enforcement semantics.** It grants nothing; its only effect is `isSubmitterOnly` hiding the Approvals nav (`authorization.ts:33-37`).
- **`signator` can gate a chain step but is excluded from the leases UPDATE RLS** (`:4216` lists only manager/financial/admin) **and from `canAccessApprovals`** — a pure signator would not even see the Approvals nav item (`AppSidebar.tsx:292`) unless they're also an admin. The SignatorReview page itself gates per-step server-side via `act-on-chain-step`.

### 4.3 Route guard map (`src/App.tsx`)

| Route | Guard |
|---|---|
| `/`, `/privacy`, `/terms`, `/share/:token`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/accept-invite`, `/firm/accept-invitation` | Public |
| `/lease-audit` | `ProtectedRoute` (auth only) — `App.tsx:128-135` |
| `/app/dashboard`, `/app/leases`, `/app/leases/:id(+/review)`, `/app/leases/:id/financial-review`, `/app/leases/:id/signator-review`, `/app/leases/:id/reports/:rid`, `/app/portfolio`, `/app/approvals`, `/app/imports`, `/app/notifications(+/:id)`, `/app/reports`, `/app/reports/disclosure`, `/app/settings/workspaces(+/:section)`, `/app/settings/account`, `/app/support`, `/app/needs-action`, `/app/onboarding` | `ProtectedRoute` only. Pages self-gate content by role/plan; all mutations are EF/RLS-enforced. |
| `/app/admin/reroute-audit`, `/app/admin/reports`, `/app/admin/exceptions`, `/app/settings/approval-policies(+/:id)` | `ProtectedRoute` + `RequireRole(canEditWorkspaceSettings)` (admin/owner) — `App.tsx:240-381` |
| `/app/reports/audit-log` | `RequireRole(canAccessReportsAuditLog)` (admin/owner) — `App.tsx:405-414` |
| `/app/reports/data-quality` | DEV builds only + `RequireRole(canAccessReportsDataQuality)` — `App.tsx:390-404` |
| `/app/admin/operations` | `ProtectedRoute` only; data gated by `is_ops_admin` RLS — `App.tsx:287-294` |
| `/app/firm/*` (7 routes) | `ProtectedRoute`; pages self-guard on `useFirm().isFirmUser` (`FirmDashboard.tsx:50`) |

`RequireRole` (`src/components/auth/RequireRole.tsx`) gates **only on the membership role** (`userRole`); no route is gated on functional roles. `/app/approvals` is reachable by anyone authenticated — harmless (actions are EF-enforced) but a submitter-only or viewer user who types the URL gets a queue page whose buttons will 403.

---

## 5. Findings

### F-1 (HIGH, security/off-boarding): Removing a member does not revoke their power
Removing a member deletes only the `workspace_members` row (`MembersPanel.tsx:114-127`). Nothing deletes their `workspace_roles` rows (verified: only whole-workspace deletion cascades — `delete-workspace/index.ts:318`; no other writer). Consequences for the removed user (still holding a valid session/JWT):
- They still pass the `leases` UPDATE RLS third clause (baseline `:4214-4216` — `workspace_roles` manager/financial/admin) and can modify any lease in the workspace via PostgREST.
- `act-on-chain-step` **never checks workspace membership** — authorization passes on named assignee (`:289-299`), voluntary delegation (`:305-320`), or `workspace_roles` holder (`:322-331`). A removed member who is a named `approver_user_id`/`effective_assignee_user_id` on a pending step, or who retains an orphaned functional role matching a role-based step, can still approve/reject/send-back chain steps — including the signator stage.
- Contrast: `legacy-lease-action:185-199` *does* require membership — the two governance functions disagree on this boundary.
Fix: revoke `workspace_roles` rows + reassign/void pending chain assignments on member removal (server-side, in one transaction — this also argues for moving member-removal into an edge function, which F-2 independently requires); add a membership gate to `act-on-chain-step`.

### F-2 (HIGH, broken flow + audit integrity): Admin member management is a silent no-op that writes false audit rows
UI gates member management to admin+owner (`WorkspaceSettings.tsx:566`, `canManageWorkspaceMembers`), but `workspace_members` UPDATE/DELETE RLS is **owner-only** (baseline `:3787`, `:3791`). A non-owner admin changing a role or removing a member matches 0 rows, PostgREST returns success, and the UI toasts "Role updated successfully"/"Member removed" (`MemberRoleSelect.tsx:50-54`, `MembersPanel.tsx:120-126`) **and then writes a `member_role_changed`/`member_removed` row to `workspace_activity_log`** (`MemberRoleSelect.tsx:59-72`, `MembersPanel.tsx:130-143`) — the insert succeeds because the log's INSERT policy only requires membership (`20260609120000:58-65`). Net: the audit trail asserts a permission change that never happened. This is the exact class fixed for `workspaces` in #70 (`20260613060000`) but left broken here. KNOWN_ISSUES **#39 understates it** (filed Low as "the write is rejected by RLS" — it is not rejected; it silently succeeds-with-zero-rows and forges audit). Fix: either widen `workspace_members` UPDATE/DELETE to accepted admins (mirroring #70, with a trigger guarding self-escalation) or hide the controls from non-owners; either way add `.select()` + row-count check so 0-row writes surface, and make the audit row transactional (server-side).

### F-3 (HIGH, half-built feature blocking Path 1's CFO gate): `signator` is unassignable and unnotifiable
- DB allows `workspace_roles.role='signator'` (baseline `:2101`); the policy editor offers "Anyone with role → Signatory" steps (`ChainDiagram.tsx:56-66`); Phase-5 spec says "workspaces that don't have a designated signator … will fail to advance … call this out clearly in error messages" (`docs/PHASE_5_BUILD_SPEC.md:369`).
- But: the frontend `FunctionalRole` type omits `signator` (`src/types/lifecycle.ts:76`); the **only** functional-role assignment UI (WorkspaceSettings → Users → Approval Chain + "Other Roles", `WorkspaceSettings.tsx:596-732`) exposes only manager_approver, financial_approver, submitter, admin — there is **no screen anywhere that assigns `signator`**.
- So a role-based signator step matches nobody: `act-on-chain-step:322-331` authorizes no one (only owner/membership-admin override can act); `advance-to-final-review:369-389` notifies only the `workspace_roles` signator cohort and **silently skips when empty** (`recipientIds.length > 0` guard) — which is always, via the product UI; `notifyRoleHolders` is documented to no-op on zero holders (`src/lib/leaseNotifications.ts:56-89`). The promised "clear error message" does not exist.
- Even the workable configuration (a *named user* signator step) gets no notification at `final_review`: nothing notifies `approver_user_id` — `act-on-chain-step` computes `nextAssignees` but no caller notifies them (`act-on-chain-step:586-589`; `notifyChainAssignees` is only invoked at initial submission, `LeaseRequestForm.tsx:397`, `retryRequestRouting.ts:103,147`).
- Answering the brief's question directly: **yes, a workspace can exist where nobody holds signator and a chain's signator stage cannot resolve to any actor except an owner/admin override, with zero notification to anyone.** The lease sits in `final_review` until someone happens to look.
Fix: add Signatory to the Approval Chain assignment UI (one more slot, same `set_workspace_roles` path), add `'signator'` to `FunctionalRole`, and make `resolve-approval-chain`/`advance-to-final-review` hard-fail (or loudly warn) when a role-based step's role has zero holders.

### F-4 (HIGH, docs-vs-code): Firm-derived workspace authority is documented but not implemented
Docs (CLAUDE.md Phase-9 section; `firmAccess.ts:7-11` header) promise `firm_admin → admin`, `firm_member → editor` in child workspaces. In code:
- Only `is_workspace_member()` is firm-aware (`20260615172439:348-…`). `has_workspace_permission()` and `get_workspace_role()` (baseline `:292-349`) and every admin-scoped RLS policy (e.g. `20260623160000:55-132`) check `workspace_members` directly — firm users fail all of them.
- `resolveEffectiveAccess`/`hasWorkspaceAuthority` (`src/lib/firmAccess.ts:22-81` + Deno mirror) have **zero call sites** (only a comment reference at `AppContext.tsx:383`). Dead module, mirror-parity-enforced dead code.
- `AppContext.fetchProfile` resolves `userRole = null` for a firm user in a child workspace (`AppContext.tsx:175-185` — owner? no; member row? no) → `RequireRole`/`canEditWorkspaceSettings` deny; the switcher hardcodes every firm child as `role: 'editor'` regardless of firm role (`AppContext.tsx:375-387`).
Net effect: firm users get **read-only** access to children (membership-level reads via RLS), not the documented editor/admin authority. Either implement the mapping (make `has_workspace_permission` firm-aware, resolve firm-derived `userRole` in AppContext) or correct the docs to "firm access is read-only pending Phase 11".

### F-5 (MEDIUM-HIGH, honesty of the model): `viewer` "Read-only access" is false
`InviteMemberDialog.tsx:30` promises viewer = "Read-only access to view leases and reports". In reality a viewer can: create lease requests through the UI (Leases "Add lease" button gated only by Vault read-only, `Leases.tsx:706-707`; `LeaseRequestForm` has no role gate) and at the API (leases INSERT RLS requires only membership, baseline `:3845`); update leases they created (`:4214` `user_id = auth.uid()` clause); insert activity-log rows. The only true viewer restrictions are storage-backed upload (`upload-lease-document:181-201`), report initiation (`:4220`), and workspace/member admin. Decide what viewer means, then align RLS + copy: the INSERT policy should require `has_workspace_permission(…, 'editor')` if viewer is to be read-only.

### F-6 (MEDIUM, integrity): Functional roles can be granted to non-members and to arbitrary users
Neither the `workspace_roles` INSERT policy (baseline `:4696-4702`) nor `set_workspace_roles` (`20260621120000:69-77`) validates the target `user_id` is a member of the workspace (or even exists beyond the auth FK). Combined with F-1's RLS grants, an admin can via API give a total outsider lease-UPDATE power and role-based chain authority in the workspace. The UI only offers members, so this is API-only, but the server is the boundary that matters. Fix inside `set_workspace_roles`: require each `user_id` to be owner or an accepted member.

### F-7 (MEDIUM, incomplete/dead API surface)
- `hasPermission` + `hasFunctionalRole` on AppContext (`AppContext.tsx:431-454`) — **zero call sites** anywhere. The `permissions` table there (viewer gets nothing, editor gets leases/export) describes a model nothing implements.
- `canUploadExecutedDocument`, `canAccessVarianceReview` (`authorization.ts:41-46`), `canAccessWorkspaceBilling`, `canAccessWorkspaceIntegrations`, `canAccessIntegrationsPage` (`authorization.ts:16-21`) — no call sites outside the module.
- `resolveEffectiveAccess` / `hasWorkspaceAuthority` + Deno mirror — no call sites (F-4).
- `workspace_approvers` table: read path exists (`LeaseReview.tsx:1048-1076` merges it into approver candidates; RLS baseline `:3927-3931`), but there is **no write path anywhere** — the "explicit approver allowlist" can never be populated, so the feature is inert. CLAUDE.md says "no read/write path" — half wrong (read exists), and the gap is really "no writer".
Delete or wire up; every dead helper is a trap for the next session (it *looks* like the gate).

### F-8 (MEDIUM, invite pipeline)
- **Invited users lose their name and starting workspace**: in `accept-invite`'s new-user path, `auth.admin.createUser` fires `on_auth_user_created` → `profiles (id,email)` row exists; the subsequent plain `profiles.insert({first_name,last_name,current_workspace_id,…})` (`accept-invite/index.ts:145-151`) hits duplicate-key and the error is **unchecked/discarded** (no upsert, no `onConflict`). `handle_new_user` ignores `user_metadata` (baseline `:306-317`). Result: first/last name captured as *required* fields in `InviteMemberDialog` (`:60-61`) are silently dropped; member lists fall back to email. (AppContext still finds the workspace via the membership fallback, `AppContext.tsx:145-166`, so login works.)
- **Silent direct-add without consent or notification**: if the invited email already has an account, `send-invite:216-230` inserts them into `workspace_members` immediately (`accepted_at = now()`), sends **no email**, and reports "User added directly". The user is never told they were added to someone's workspace.
- **Email-then-insert ordering**: for a brand-new invite the email is sent *before* the `invite_tokens` insert (`send-invite:232-247`); on insert failure the recipient holds a dead link (`DB_COMMIT_FAILED_AFTER_SEND`).
- `role` from the request body is not whitelisted (KNOWN_ISSUES #38, still open) — the `workspace_role` enum is the only guard; an admin can also mint other admins by invite (design decision — note the asymmetry with the firm layer's "owner-only-mints-admins" rule).
- Invite functions correctly do their own Bearer validation despite `verify_jwt = false` in `supabase/config.toml:12-34` (needed for the unauthenticated new-user path on `accept-invite`/`get-invite-info`).

### F-9 (MEDIUM, workflow notification continuity)
Only the **first** stage's assignees are ever notified (submission-time `notifyChainAssignees`). When a concept step is approved and the frontier advances, `act-on-chain-step` notifies nobody (`:586-589` computes `nextAssignees`, no caller uses them; only `execution_owner_assigned` is written, `:776-782`). Mid-chain approvers and signators learn it's their turn only via the queue, a manual nudge (`send-nudge`), or the stuck-chain sweep. For the owner's Path-1 narrative ("requestor is notified they may seek a quote", "CFO signs with Finance visibility") the identity plumbing exists but the event plumbing between identities is missing in the middle.

### F-10 (LOW/MEDIUM, misc)
- Login `rememberMe` dead control; `state.from` redirect broken (§2).
- `profiles` has two overlapping permissive UPDATE policies (baseline `:4346-4350`), so the WITH CHECK on `current_workspace_id` is bypassable — filed as #106 (Low is fair: pointers are re-validated downstream). The legacy per-user billing columns on `profiles` (`plan`, `stripe_*`, `trial_ends_at`, baseline `:1676-1688`) are self-writable but consumed nowhere (verified: no reader outside generated types) — dead columns; drop or guard.
- `workspace_activity_log.event_type` is free-text with member-level INSERT (`20260609120000:58-65`) — any member can forge arbitrary workspace audit events (already filed; F-2 makes it acute).
- The solo-workspace approver fallback (`approverCandidates.ts:87-90`) surfaces *yourself* as the only approval candidate — intentional (documented), but it means "request approval" can be a self-approval in disguise for solo operators; the SoD story only holds in multi-member workspaces.
- Route-level dev-gate on `/app/reports/data-quality` uses build-time `import.meta.env.DEV` (`App.tsx:390-404`) — correct.

---

## 6. How "post without approval" works *today* (baseline for the proposal)

- **Path 1 (request workflow)**: `LeaseRequestForm` inserts a `draft`, then `resolve-approval-chain` decides. If the workspace has policies → chain (`concept_submitted`). If not → legacy fallback: `getApprovalRequirements` (`src/lib/approvalRouting.ts:37-74`) — **if nobody holds `manager_approver` and nobody holds `financial_approver`, the lease is auto-`approved` on submission** (`getInitialStatusAfterSubmission → 'approved'`), server-applied by the edge fn. So "no approval" is currently an emergent *workspace* state (no roles configured), not a *person's* permission.
- **Path 2 (direct add)**: upload → `process_lease` creates/executes → review → the post moment is `model_lock` via `legacy-lease-action:232-234`, which requires **financial_approver ∪ functional-admin ∪ membership-admin ∪ owner**. So today, "permission to post without approval" ≈ holding financial_approver/admin — but it's implicit, unnamed, and invisible in the UI.
- Staged edits to a locked lease: `lease-governance-action` `submit_changes` with `mode='self_approve'` — membership-admin/owner only (`:625-629`); server-validated.

## 7. Proposal: a clean, server-enforced `direct_publisher` permission

Goal: "user X may post a lease to the repository without routing it through approval" — explicit, per-user, workspace-scoped, enforced only server-side, consistent with both role systems.

1. **Model it as a functional role** — the machinery already exists end-to-end (table, CHECK, RPC, RLS, context loading, audit row on change). One migration:
   `ALTER TABLE workspace_roles DROP CONSTRAINT workspace_roles_role_check; ADD CHECK (role IN ('submitter','manager_approver','financial_approver','signator','admin','direct_publisher'))` (new file per the Schema Change Rule; idempotent). Add `'direct_publisher'` to `FunctionalRole` in `src/types/lifecycle.ts:76` (and finally add `'signator'` while there).
2. **Assignment UI**: one more checkbox column in the existing "Other Roles" grid (`WorkspaceSettings.tsx:676-732`), saved through the existing atomic `set_workspace_roles` RPC — which also writes the `functional_roles_changed` audit row for free. While touching the RPC, add the F-6 member-validation guard.
3. **Server enforcement — exactly two choke points, both already service-role:**
   - **Path 2 (the main use case):** `legacy-lease-action` `model_lock` gate becomes `canFinancial || userRoles.has('direct_publisher')` (`legacy-lease-action:232-234`). That single line *is* the permission: posting a reviewed direct-upload into the active repository without an approver. Log `details.posted_via = 'direct_publisher'` in the existing activity row so the audit trail distinguishes it.
   - **Path 1 (optional, recommend OFF):** do **not** let `direct_publisher` bypass the request workflow. The request chain exists precisely to give managers/finance the gate; a person-level bypass there recreates the shadow-lease problem the product exists to kill. If the owner wants it anyway, the hook is one branch in `resolve-approval-chain`'s `initialResolution` path: if requestor holds `direct_publisher`, skip chain creation, apply `draft → approved` server-side with a `status_change` row (`routing_path: 'chain'`, `details.bypass: 'direct_publisher'`) — never client-side (the lifecycle trigger already blocks that).
4. **Do not** implement it as a workspace_members role variant, an RLS carve-out, or a client flag: RLS can't express "may transition lifecycle" (the trigger forbids all client lifecycle writes — good), and membership roles are access-shaped, not workflow-shaped.
5. **Guardrails**: exclude Vault/grace workspaces (the liveness gate in `legacy-lease-action:165-174` already covers this); keep SoD untouched (direct publish is not an approval, it's an attributed unilateral post — the activity row is the accountability).

## 8. Simplification pushback (owner explicitly invited it)

The permission model as felt by an SMB finance user is currently **five vocabularies**: owner / admin-member / editor / viewer, plus submitter / manager_approver / financial_approver / signator / functional-admin, plus firm roles, plus per-policy user/role steps, plus the implicit "no roles configured = auto-approve". Concrete reductions that lose nothing:

1. **Kill functional `admin`** — it duplicates membership admin; every server check treats them as a union anyway (`legacy-lease-action:223-224`, `act-on-chain-step:342-351`). One "admin" concept.
2. **Kill `submitter` or give it meaning** — today it only hides a nav item. Either "any member can submit" (current server truth — say so in the UI) or make it a real gate in `resolve-approval-chain`.
3. **Make viewer honest** (F-5) — read-only at RLS, and the invite dialog stops lying.
4. **One assignment surface** — Approval Chain slots (Manager, Financial, **Signatory**) + checkboxes (Submitter?, Direct publisher, Admin) in one card, saved by one RPC. The pieces already exist; signator is the only missing slot.
5. **Delete the dead APIs** (F-7) so future work gates on the one real module (`authorization.ts` + edge functions).

---

## 9. What is genuinely good (so it doesn't get rebuilt away)

- The lifecycle write-guard trigger (baseline `:575-607`) + "browser can never flip lifecycle" convention is the right backbone and is consistently respected by the current writers.
- `legacy-lease-action` and `lease-governance-action` re-derive every authorization server-side from DB state, never trusting client-supplied targets (`legacy-lease-action:302-304` even documents the self-approval threat).
- `set_workspace_roles` fixed the delete-then-insert data-loss class atomically and audits in-transaction (`20260621120000` header).
- Invite functions derive `workspace_id` from the invite row, never the client (`revoke-invite:45-50`), build URLs from deploy-time `APP_URL` not Origin (`send-invite:175-182`), and the new-user path guards account takeover via the profiles lookup (`accept-invite:95-111`).
- `record-login-event` gets IP provenance right (`:51-60`).
