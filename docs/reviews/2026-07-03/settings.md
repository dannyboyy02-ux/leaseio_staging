# Settings Information Architecture — Full Audit

**Scope:** every settings surface: `/app/settings/account` (AccountSettings), `/app/settings/workspaces[/:section]` (WorkspacesSection → WorkspaceSettings + WorkspaceManagementContent), the approval-policies satellite pages, member/invite components + edge functions, settings-adjacent cards on `/app/reports`, and FirmSettings. All claims verified against code; every claim carries file:line evidence. Benchmark: Claude desktop settings (few clear sections, everything findable, nothing orphaned).

---

## 1. Surface map (what exists)

Settings are spread across **five distinct surfaces**:

| # | Surface | Route | Shell |
|---|---|---|---|
| A | Account settings (6 tabs + link) | `/app/settings/account?tab=` | vertical rail, Claude-style (`AccountSettings.tsx:611-653`) |
| B | Workspaces drill-down (8 sections) | `/app/settings/workspaces[/:section]` | second-level rail w/ back arrow (`WorkspacesSection.tsx:94-135`) |
| C | Approval Rules satellite | `/app/settings/approval-policies[/:id]` | own full pages OUTSIDE the settings shell (`ApprovalPoliciesListPage.tsx:191-207` — has an explicit back-link because it "sits outside the Settings shell") |
| D | Report settings on the Reports page | `/app/reports` | `ReportSettingsCard` + `DiscountRateCard` mounted at `Reports.tsx:167-168, 354-355` |
| E | Firm settings (firm mode) | `/app/firm/settings` | `FirmSettings.tsx` |

Entry points: user-menu → Settings (`AppSidebar.tsx:803-808`), workspace switcher → "Manage workspaces" (`AppSidebar.tsx:661`), trial pill / upgrade item → `?tab=billing` (`AppSidebar.tsx:744,755,837`), quota banner `?packs=1` deep-link (`AccountSettings.tsx:184-189`). Legacy redirects are complete and correct (`App.tsx:433-440`; tab aliases `AccountSettings.tsx:152-164`).

The two-surface split itself (account-level vs workspace-level, separated by a rail divider at `AccountSettings.tsx:637-652`) is genuinely good and close to the Claude benchmark. The problems are (a) orphaned/dead controls, (b) UI promising things the server forbids or that no code implements, and (c) a three-way role-system muddle.

---

## 2. Full control inventory

Legend: **Server-enforced?** = is the write/read authorized server-side (RLS/edge fn), independent of UI gating. **Effect?** = does anything consume the stored value.

### Surface A — Account settings (`/app/settings/account`)

| Tab | Control | What it does | Role required (UI) | Server-enforced? | Effect? |
|---|---|---|---|---|---|
| Profile | First/Last name, Company | `profiles` UPDATE (`AccountSettings.tsx:279-287`) | self | RLS (self) | name yes; company only dashboard-subtitle fallback (`Dashboard.tsx:61`) |
| Profile | Email | disabled input (`:691`) | — | — | display only |
| Profile | Timezone (user) | `profiles.timezone` (`:285`) | self | RLS | **NONE — dead.** Only consumer is AppContext hydration (`AppContext.tsx:108,266`); no date formatting or scheduling reads it |
| Profile | Email notifications toggle | `profiles.email_notifications_enabled`, autosave (`:349`) | self | RLS | YES — honored by `process-alerts/index.ts:243` and `process_lease/index.ts:2673` |
| Profile | SMS notifications toggle | `profiles.sms_notifications_enabled` (`:350`) | self | RLS | **NONE — dead.** Zero SMS code anywhere (`grep -ri twilio\|sms supabase/functions` → 0 files); profiles has no phone column (phone input removed for exactly this reason, comment `:695-698`) |
| Profile | "Abstraction complete" toggle | `profiles.notify_abstraction_complete` (`:351`) | self | RLS | YES — `process_lease/index.ts:2673` |
| Appearance | Theme Light/Dark/System | next-themes (`:1557-1588`) | anyone | n/a (client) | yes |
| Account | Change password | `supabase.auth.updateUser({password})` (`:317-319`) | self | Supabase Auth | yes — **but the "Current password" field is collected and never verified** (`:301-333` never reads `currentPassword`) |
| Account | Login activity | last 5 `login_events` rows (`:93-99`) | self | RLS (self) | yes (written by `record-login-event`, invoked at `AuthContext.tsx:56`) |
| Account | Log out other sessions | `signOut({scope:'others'})` (`:387`) | self | Auth | yes |
| Account | Delete account | `delete-account` edge fn (`:367`), AlertDialog confirm | self | edge fn | yes (no type-to-confirm, unlike workspace delete) |
| Privacy | AI processing consent toggle | `profiles.ai_processing_consent_at` (`:232-269`) | self | RLS + **server-gated**: `process_lease/index.ts:921`, `ai-assistant/index.ts:254` | YES — real kill-switch |
| Privacy | Data export / rights requests | `mailto:` links (`:1376,1403`) | anyone | n/a | manual process |
| Billing | Adjust plan (PlanPickerDialog) | `create-checkout` / downgrade→portal (`:588-595`) | admin/owner (UI `:1125-1131`) | edge fns verify owner/admin + firm-managed 403 | yes |
| Billing | Add/Update payment, portal | `customer-portal` (`:461-489`) | admin/owner | edge fn | yes |
| Billing | Card + Invoices | `get-billing-summary` (`:548-576`) | admin/owner (members get note `:1161,1188`) | edge fn 403s members | read-only |
| Billing | Cancel subscription | dialog → portal (`:1268-1286,1510-1547`) | admin/owner | Stripe portal | yes |
| Billing | Buy capacity / credits surfaces | `DocumentPackDialog` (mounted `:1440`), credits balance (`:1253-1261`) | admin/owner | `manage-document-pack` verifies + firm 403 (`manage-document-pack:207` per CLAUDE.md, verified fn exists) | yes |
| Billing | Trial/past-due/recovery banners, Vault reactivation | conditional (`:995-1098`) | admin CTA, member note | edge fns | yes |
| Usage | 4 usage meters + Add capacity | `UsageContent.tsx:194-291` | meters all; CTA admin (`UsageContent.tsx:239`) | n/a (reads) | yes |

### Surface B — Workspaces drill-down

**"My Workspaces" panel** (`WorkspaceManagementContent`, default landing):

| Control | What it does | Role required (UI) | Server-enforced? | Notes |
|---|---|---|---|---|
| Create workspace | `NewWorkspaceDialog` → `create-workspace` | any (dialog gates by plan) | edge fn (Business + cap + card) | ok |
| Rename inline | `workspaces.name` UPDATE | owner list only | RLS (owner+admin since #70) | ok; logs to `workspace_activity_log` |
| Manage members (sheet) | `MembersPanel` for any owned workspace | owner | mixed — see §3.2 | |
| Transfer ownership | `transfer-workspace-ownership` edge fn (`TransferOwnershipDialog.tsx:137`) | owner | edge fn + locked RPC | ok |
| Delete workspace | `delete-workspace` edge fn, type-name confirm (`DeleteWorkspaceDialog.tsx:64`) | owner | edge fn | ok |
| **Leave workspace** | **direct client `workspace_members` DELETE (`WorkspaceManagement.tsx:187-191`)** | member | **NO — DELETE RLS is owner-only** (`baseline_schema.sql:3787`) | **BROKEN — false success. See finding F1** |

**Per-workspace sections** (`WorkspaceSettings.tsx`, rail-gated in `WorkspacesSection.tsx:57-69`):

| Section | Control | What it does | Role (rail gate) | Server-enforced? | Effect? |
|---|---|---|---|---|---|
| Company Profile | Billing signpost card | link to Account→Billing (`WorkspaceSettings.tsx:514-524`) | admin+editor | n/a | good D4 pattern |
| Company Profile | Workspace name | `workspaces.name` (`:299-315`, with #70 `.select()` row check) | edit: admin | RLS owner+admin (`20260613060000`) | yes |
| Company Profile | Workspace timezone | `workspaces.timezone` (`:301`) | admin | RLS | **NONE — dead.** Copy says "Used for scheduling notifications and displaying dates" (`workspace.timezone_desc`) — no consumer exists anywhere (grep `workspace.timezone`/`timeZone` → only settings + Signup) |
| Members | MembersPanel (invite / role select / remove) | see §3.2 | admin (`WorkspacesSection.tsx:61`) | invite: YES (edge fn owner/admin); **role change + remove: owner-only RLS with false-success UI** | see F2 |
| Members | Approval Chain slots (Step 1 Manager / Step 2 Financial) | `workspace_roles` via atomic `set_workspace_roles` RPC (`:262-265`; migration `20260621120000`) | admin, needs >1 member (`:579`) | RPC mirrors owner/admin RLS | legacy-path routing + role-pool for policy role-steps; **misleading when policies exist — see F5** |
| Members | Other Roles: Submitter / Admin checkboxes | same `workspace_roles` RPC (`:715-724`) | admin | RPC | drives nav gating (`isSubmitterOnly`), executed-upload perms (`authorization.ts:41-46`) |
| Notifications | "Default Reminder (days before)" | `workspaces.default_notification_days` (`:336-339`) | admin+editor (editor read-only) | RLS | **NONE — dead. See F4** |
| Lease Configuration | Asset types + abbreviations | `workspaces.asset_type_config` + `asset_type_abbreviations` (`:445-461`) | admin | RLS + config guard | yes (AI classification prompt, Leases table) |
| Lease Configuration | Departments / Regions / Locations / Buildings option lists | `workspaces.*_options` (`:463-494`) | admin | RLS | yes (request form + policy matching suggestions `ApprovalPolicyEditPage.tsx:109`) |
| Risk Watchlist | CRUD custom `risk_templates` | `RiskWatchlistManager.tsx` | admin (rail `WorkspacesSection.tsx:64`) | RLS | yes (extraction prompt) |
| Approval Rules | link card → satellite pages | `:969-974` | admin | — | ok |
| Approval Rules | Approval Threshold ($) + Lease Liability Alert ($) | `workspaces.approval_threshold` / `covenant_threshold` (`:393-399`) | admin | RLS | **partial — legacy path only. See F6** |
| Approval Rules | Counter-signature window | `workspaces.counter_signature_default_due_days` (`:355-383`) | admin | RLS + DB CHECK 1..365 (`baseline:1908`) | yes (`act-on-chain-step`; reminder copy matches `send-counter-signature-reminder/index.ts:8-16`) |
| Onboarding | **Historical Portfolio Loader toggle** | `workspaces.backdoor_enabled` (`:410-427`) | admin | RLS | **NONE — orphaned. See F3** |

### Surface C — Approval Rules satellite (admin-only via `RequireRole`, `App.tsx:362-381`)

| Control | What it does | Server-enforced? |
|---|---|---|
| SoD workspace default toggle | `workspaces.separation_of_duties_default` (`ApprovalPoliciesListPage.tsx:102-114`) | RLS; consumed by validation + resolver |
| Rule CRUD, activate/duplicate/archive | `approval_policies` + `apply_policy_steps` RPC | RLS admin-write (`20260623160000:93-107`) |
| Chain steps incl. **"Anyone with role: Signatory"** | `ChainDiagram.tsx:56-66` | see **F7** — signator role is unassignable anywhere |
| Test dialog ("Try it on a sample request") | `ApprovalPolicyTestDialog` | read-only |

### Surface D — Reports page settings cards (`Reports.tsx:167-168`)

Report org name / fiscal year start / rounding / retention / discount method (`ReportSettingsCard.tsx`), and discount rate (`DiscountRateCard.tsx`) — workspace-level config living outside the settings IA; a signpost in Approval Rules points here (`WorkspaceSettings.tsx:1054-1060`).

### Surface E — Firm settings (`FirmSettings.tsx`)

Firm name / type / billing email; owner-only save (`:25`, "firms UPDATE RLS is owner-only"), non-owners get read-only note (`:88-92`). Self-consistent.

---

## 3. Findings

### F1 — CRITICAL/HIGH: "Leave workspace" is a silent no-op for every user it's offered to
- `WorkspaceManagement.tsx:183-208` deletes the caller's own `workspace_members` row client-side. The only DELETE policy on `workspace_members` is owner-only (`Owners can remove members`, `baseline_schema.sql:3787`); a member-only user is by definition not the owner, so the DELETE matches **0 rows and returns no error** (PostgREST 2xx). The code checks only `error`, so the user gets `toast.success('Left "X"')` (`:193`), the active-workspace fallback logic runs, `refreshProfile()` reloads — and the workspace is still there with access intact.
- The section copy explicitly promises "**Leave a workspace to lose access immediately**" (`WorkspaceManagement.tsx:395`). A departing employee who "leaves" retains full access while believing it was revoked — a security-expectation failure, not just polish.
- Not in KNOWN_ISSUES (item #39 covers role-change/remove only).
- **Fix:** add a self-leave DELETE policy (`user_id = auth.uid() AND user_id <> owner`) or route through an edge fn; either way `.select()` the delete and fail loudly on 0 rows.

### F2 — HIGH: Admin member management (role change, remove) silently no-ops with success toasts
- `workspace_members` UPDATE and DELETE RLS are **owner-only** (`baseline_schema.sql:3787,3791`; no later migration relaxes them — verified across all `ON public.workspace_members` policy statements). But MembersPanel is offered to **admins** (`canManageWorkspaceMembers` = admin-or-owner, `authorization.ts:15`; mounted at `WorkspaceSettings.tsx:566-575`).
- `MemberRoleSelect.handleRoleChange` (`MemberRoleSelect.tsx:43-52`) and `MembersPanel.handleRemoveMember` (`MembersPanel.tsx:114-127`) neither `.select()` nor check row counts → for a non-owner admin, 0 rows are affected, `error` is null, and the UI toasts "Role updated successfully" / "Member removed". The audit log write then records an event **for a change that never happened** (`MemberRoleSelect.tsx:59-72`) — an audit-integrity defect on top of the UX one.
- `InviteMemberDialog.tsx:28` tells the inviter that Admin = "Full access including billing & **member management**" — a promise the RLS contradicts.
- KNOWN_ISSUES #39 files this as **Low** with the wrong failure model ("the write is rejected by RLS" — implying a visible error). Code shows false success; and remove-member is an offboarding action, so a failed-but-reported-successful removal leaves a departed user with live access. Should be re-triaged High.
- The repo already knows the correct pattern: `handleSaveGeneral` uses `.select()` + row-count exactly to avoid "an RLS-blocked 0-row update surfac[ing] as … a false 'saved'" (`WorkspaceSettings.tsx:299-315`).
- **Fix (pick one model):** relax `workspace_members` UPDATE/DELETE RLS to owner+admin (matching `send-invite`, which already lets admins add members via service role, `send-invite/index.ts:149-155` — the current split is incoherent: admins can add but not manage), or hide the controls for non-owner admins. In all cases add row-count checks.

### F3 — HIGH: "Historical Portfolio Loader" toggle controls nothing (orphaned feature flag)
- `workspaces.backdoor_enabled` is written and read **only** by the settings page itself (`WorkspaceSettings.tsx:169,180,416,1139`; grep across `src/` and `supabase/functions` → zero other consumers).
- The UI copy asserts behavior: "When enabled, shows the historical portfolio intake form to workspace members" (`WorkspaceSettings.tsx:1134-1136`) — no such form exists (CLAUDE.md Active Priorities: loader "NOT YET BUILT"). An admin flips it, gets "Onboarding settings saved", and nothing anywhere changes. A whole rail section ("Onboarding") exists to host this one placebo.
- **Fix:** remove the section until the loader ships, or mark the toggle disabled "coming soon" with honest copy.

### F4 — HIGH: The workspace "Notifications" section is a placebo, and the real alert engine is unreachable
Two independent halves, both broken:
1. `default_notification_days` ("Default Reminder (days before)… How many days before an event to send the first notification", `WorkspaceSettings.tsx:764-776`) is consumed by **nothing** — the only reads are settings hydration (`AppContext.tsx:267` stores it; no notification code reads `defaultNotificationDays`; `grep default_notification_days supabase/functions` → 0).
2. The actual reminder engine, `process-alerts`, iterates **only `alert_rules` rows** (`process-alerts/index.ts:106-165`; expiry threshold comes from `rule.threshold_days`, `:120`). `alert_rules` has **no UI anywhere** (`grep alert_rules src/` → nothing outside generated types) and is never seeded by any migration or edge function (only `delete-workspace` references it for cleanup). Careful admin-write RLS was even built for it (`20260623160000:58-76`) — for a table no product surface can populate.
- Net: **customer-configured expiry/approval-pending/covenant/variance email alerts can never fire**, while the settings page implies they're configured. For a product whose pitch is lease *awareness*, this is a core-promise gap surfaced (and disguised) by Settings.
- **Fix:** either wire `default_notification_days` into an expiry sweep, or build a small "Alerts" settings card that CRUDs `alert_rules` (the RLS is already in place), and delete whichever knob loses.

### F5 — HIGH: Three role systems collide on one screen, with a misleading legacy "Approval Chain" card
The Members section stacks, without explanation:
1. **Structural roles** (`workspace_members.role`: Admin/Editor/Viewer) — MembersPanel role dropdown (`MemberRoleSelect.tsx:96-100`).
2. **Functional roles** (`workspace_roles`: submitter/manager_approver/financial_approver/admin) — "Approval Chain" slots + "Other Roles" checkboxes (`WorkspaceSettings.tsx:596-732`). Note a second, different "Admin" checkbox lives here, directly below the structural Admin dropdown — two unrelated "Admin"s on one screen.
3. **Approval-policy chains** (`approval_policies` + steps) — the Approval Rules surface.
The legacy card asserts unconditionally: "Lease requests flow through Manager Approval first, then Financial Approval before execution" (`WorkspaceSettings.tsx:583-585`) and warns "commitments will stall" without a financial approver (`:665-671`). But once any approval policy exists, `resolve-approval-chain` routes by policy and the manager/financial `workspace_roles` matter only as (a) the no-policies legacy fallback (`resolve-approval-chain/index.ts:1096-1122`) and (b) the membership pool for role-based policy steps (`act-on-chain-step/index.ts:322-330`). Nothing on the Members screen says so; an admin can configure "Step 1/Step 2" believing it IS the routing while a policy quietly overrides it (or vice versa).
- **Fix:** one roster table (per member: structural role + functional-role chips incl. Signatory), and either delete the Step-1/Step-2 card or retitle it "Fallback approvers (used when no Approval Rule matches)" with a live indicator of whether policies exist.

### F6 — MEDIUM: "Approval Threshold ($)" silently stops governing routing once policies exist
`workspaces.approval_threshold` feeds `getApprovalRequirements` only on the **no-policies legacy path** (`resolve-approval-chain/index.ts:1096-1122`) and `legacy-lease-action/index.ts:309-316`; policy matching uses per-rule `match_min/max_annual_cost` instead. Yet the field is presented under "Approval Rules" alongside the policy entry point with copy implying it always gates financial review (`WorkspaceSettings.tsx:1011-1013`). It still drives the request-form preview messaging (`LeaseRequestForm.tsx:118-125`), so the preview and actual routing can disagree in policy-mode workspaces.

### F7 — HIGH: "Signatory" is offered as a chain-step role but is unassignable anywhere in Settings
- The policy editor's approver picker offers "Anyone with role: **Signatory**" (`ChainDiagram.tsx:56-66`, value `'signator'`), and the DB CHECK on `workspace_roles.role` accepts `'signator'` (`baseline_schema.sql:2101`).
- But no UI writes it: the Members section's functional-role UI exposes only manager/financial slots + submitter/admin checkboxes (`WorkspaceSettings.tsx:596-732`), and the `FunctionalRole` TS type **omits signator entirely** (`types/lifecycle.ts:76`). The only write path to `workspace_roles` is `set_workspace_roles` called from that UI (verified: no other insert anywhere in `src/` or `supabase/functions`).
- Consequences: a role-based Signatory step can be **acted on only via the owner/admin override** (`act-on-chain-step/index.ts:322-351`) — the actual CFO/signatory (typically an editor) is never authorized; and `advance-to-final-review` notifies "the signator workspace_roles cohort" (`advance-to-final-review/index.ts:365-376`) — **an always-empty set**, so nobody is told a lease reached final review unless named per-user in the rule.
- Workaround exists (pick a specific person instead of the role), but the trap is invisible at configuration time.
- **Fix:** add Signatory to the roster's assignable functional roles (and to `FunctionalRole`), or remove the role option from `FUNCTIONAL_ROLE_OPTIONS` until assignable.

### F8 — MEDIUM: "Current password" field is decorative
`handleChangePassword` (`AccountSettings.tsx:301-333`) never reads `currentPassword`; `supabase.auth.updateUser({password})` doesn't require it. The field (`:824-843`) implies re-authentication that doesn't happen — a security-theater control. Either verify via `signInWithPassword` first or drop the field.

### F9 — MEDIUM: Two timezone settings, both dead
User timezone (`AccountSettings.tsx:707-721`) and workspace timezone (`WorkspaceSettings.tsx:540-555`) are both stored and never consumed (only Signup capture + context hydration; zero `timeZone` usage in formatting; zero reads in edge functions). Workspace copy overclaims: "Used for scheduling notifications and displaying dates" (`workspace.timezone_desc`). Duplication + no effect. Keep one (workspace), wire it into alert scheduling when F4 is fixed, delete the other.

### F10 — MEDIUM: SMS notifications toggle for a channel that doesn't exist
`AccountSettings.tsx:758-772` persists `sms_notifications_enabled`; no SMS-sending code exists in any edge function, and profiles has no phone column (the phone input was already removed as a dead control — comment `:695-698`; KNOWN_ISSUES #69/#80). Same defect class, one control over. Copy: "Receive critical alerts via SMS". Remove until built.

### F11 — MEDIUM: Member-management audit trail is written but displayed nowhere
`workspace_activity_log` receives `member_removed` (`MembersPanel.tsx:131-143`), `member_role_changed` (`MemberRoleSelect.tsx:59-72`), `functional_roles_changed` (`set_workspace_roles` migration `20260621120000:80-86`), renames — but no page reads it (grep `workspace_activity_log` in `src/` → only writers + tests; the Audit Log page reads `lease_activity_log` only, `AuditLog.tsx:136`). Governance events about *people and permissions* are invisible to the customer — weak spot for an "audit-defensible repository" product. Fix: add a "Workspace activity" card in Members or a filter on the Audit Log page.

### F12 — MEDIUM: Owner invisible in members list for `create-workspace` workspaces
`create-workspace` never inserts an owner `workspace_members` row (verified: 0 matches in `create-workspace/index.ts`; acknowledged at `WorkspaceManagement.tsx:82-84,144-154` for counts). But `MembersPanel` renders **only** member rows (`MembersPanel.tsx:65-100`) — in such workspaces the owner is absent from their own roster, the single-member branch crowns whoever the first invitee is with an "Admin" badge (`:186-209`, hardcoded regardless of actual role), and the Approval Chain assignment `Select` can't pick the owner (`WorkspaceSettings.tsx:635`, options = members only). Onboarding-path workspaces are fine (owner row inserted, `Onboarding.tsx:104-105`).

### F13 — LOW: Duplicate "Pending Invitations" heading
Card title "Pending Invitations" (`MembersPanel.tsx:278`) wraps `PendingInvitesList`, which renders its own "Pending Invitations" `<p>` heading (`PendingInvitesList.tsx:81`). Double heading in production.

### F14 — LOW: Dead code on the settings surfaces
- `getRoleLabel` defined, never called (`WorkspaceSettings.tsx:496-503`).
- `canAccessProfile` computed, never used (`WorkspaceSettings.tsx:129`).
- `canAccessWorkspaceIntegrations` / `canAccessIntegrationsPage` exported with no consumers (`authorization.ts:17,21`) — leftover of a never-built Integrations section.
- `MembersPanel`'s `canManage=false` contract comment claims controls become "no-ops" (`MembersPanel.tsx:44-49`), but `MemberRoleSelect` renders enabled regardless (`:248-254`, `disabled` not passed) — latent only (all current call sites pass true).

### F15 — LOW: Sections that render for roles that can do nothing there
- Editors can open Workspaces → Notifications (`WorkspacesSection.tsx:62`, `canAccessDefaults` includes editor) and find a single disabled input + disabled save (`canEdit` is admin-only, `WorkspaceSettings.tsx:126`). A whole rail section whose only content is one read-only number.
- Viewers/editors cannot see the member roster at all (Members is admin-only, `WorkspacesSection.tsx:61`); most benchmark products let members view (not manage) the roster.
- The Billing tab is visible to members and consists mostly of three repeated "Billing is managed by workspace admins" notes (`AccountSettings.tsx:1018,1161-1162,1188-1189`).

### F16 — LOW: `workspace_approvers` — write-orphaned allowlist
Read at `LeaseReview.tsx:1060` (+ `approverCandidates.ts`) as an "explicit allowlist" of approver candidates, but no UI or edge fn ever writes a row. As a settings-adjacent gap: a permission list that cannot be populated. (Also docs drift: CLAUDE.md says "no read/write path in the frontend" — a read path now exists.)

---

## 4. Docs drift

| Claim | Reality | Evidence |
|---|---|---|
| CLAUDE.md: "`workspace_approvers` … has no read/write path in the frontend" | Read path exists; write path still absent | `LeaseReview.tsx:1060`, `approverCandidates.ts:29` |
| KNOWN_ISSUES #39 (Low): non-owner admin's member write "is rejected by RLS" (implies visible failure) | Failure is a **false success** (0-row write, success toast, phantom audit row); remove-member is offboarding-relevant → severity understated | `MemberRoleSelect.tsx:43-72`, `MembersPanel.tsx:114-148`, `baseline_schema.sql:3787,3791` |
| CLAUDE.md: legacy fixed manager/financial model "replaced" by approval policies | The legacy model is still the primary UI on the Members screen with unconditional copy; it remains the live fallback path | `WorkspaceSettings.tsx:578-673`, `resolve-approval-chain/index.ts:1096-1140` |
| WorkspaceSettings comment: Users section "hidden for single-user workspaces" | Gated by role (`canManageMembers`), not user count | `WorkspaceSettings.tsx:565-566` |
| MembersPanel contract comment: `canManage=false` makes controls "no-ops" | Role select renders enabled regardless | `MembersPanel.tsx:44-49` vs `:248-254` |
| UI copy drift (settings promising nonexistent behavior) | timezone "used for scheduling notifications"; reminder-days "when to send the first notification"; SMS "receive critical alerts"; portfolio-loader "shows the intake form" | locales `workspace.timezone_desc`, `workspace.reminder_desc`, `account.sms_notifications_desc`; `WorkspaceSettings.tsx:1134-1136` |

Positive verifications (no drift): AI-consent toggle is genuinely server-enforced (`process_lease/index.ts:921`, `ai-assistant/index.ts:254`); counter-signature reminder copy matches the cron tiers (`send-counter-signature-reminder/index.ts:8-16`); firm-managed billing suppression matches server 403s; all 192 i18n keys used by the settings surfaces resolve in both `en` and `es` (plural forms included); legacy tab aliases and route redirects are complete (`AccountSettings.tsx:152-164`, `App.tsx:433-440`).

---

## 5. Proposed cleaned-up IA

Keep the two-surface Claude-style split (it's the right shape). Changes:

**Account** (`/app/settings/account`) — Profile · Notifications · Appearance · Security · Privacy · Billing · Usage
- Split notification prefs out of Profile into a small **Notifications** tab (email + abstraction-complete; **delete the SMS toggle** until SMS exists).
- Rename "Account" back to **Security** (it holds password/sessions/delete — the current name collides with the page title "Account settings").
- Password: drop or actually verify "Current password" (F8). Drop the dead user timezone (F9).

**Workspace** (`/app/settings/workspaces/...`) — My Workspaces · General · People · Approvals · Lease fields · AI Watchlist
- **General**: name (+ timezone only if wired to something).
- **People** (replaces Members): ONE roster table — per member: structural role dropdown, functional-role chips (Submitter / Manager approver / Financial approver / **Signatory** / Admin), remove. Kill the separate Step-1/Step-2 card or demote it to a clearly-labeled "fallback approvers" strip shown only when no rules exist (F5, F7). Add a "Workspace activity" feed (F11).
- **Approvals**: embed the rules list inside the settings shell (Surface C currently escapes it), plus SoD default, thresholds (with honest "applies when no rule matches" copy — F6), counter-signature window.
- **Lease fields**: asset types + option lists (current Lease Configuration).
- **Delete**: the Onboarding section (F3) until the loader ships; the Notifications section unless F4 wires it to a real engine (if fixed, fold "reminder days" into an Alerts card that manages `alert_rules`).
- Report settings/discount rate: fine to leave on Reports (settings-where-you-feel-them), but cross-link from Workspace → Approvals is already there; consider a mirror card under Workspace for findability.

**Blocking fixes before IA polish (order):** F1 (leave), F2 (admin member mgmt), F7 (signatory), F4 (alerts), F3/F10 (orphan removals). All are small, contained diffs; none require rearchitecting.

## 6. Rebuild vs fix

**Fix.** The 2026-06 Claude-alignment refactor left a sound skeleton: correct account/workspace split, working deep-link aliases, complete i18n, real server enforcement on billing/AI-consent/policy surfaces. The defects are orphaned controls, three specific UI-vs-RLS mismatches with false-success UX, and a role-model presentation problem — all repairable in place. Only the Members/People section warrants a focused redesign (one roster, one role story).
