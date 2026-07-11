# J6 — Settings IA Sweep: Workspace-Owner Journey Audit

**Reviewer scope:** trace a workspace owner through five settings tasks — (1) rename workspace, (2) invite a teammate as approver, (3) set who signs leases, (4) check bill/plan, (5) turn notifications on/off — across `AccountSettings.tsx`, `WorkspaceSettings.tsx`, `WorkspacesSection.tsx`, `WorkspaceManagement.tsx`, sidebar entries, and every function they invoke. All claims verified against code; docs cross-checked for drift.

---

## 0. The settings architecture as built

Entry points to Settings (verified — there is no settings gear in the header; `AppHeader.tsx:26-31` documents the header was stripped to title+actions):

- Bottom-left **user menu → "Settings"** → `/app/settings/account` (`AppSidebar.tsx:803-808`).
- Workspace switcher dropdown → **"Manage workspaces"** → `/app/settings/workspaces` (`AppSidebar.tsx:661-663`).
- Deep links: trial pill and "Upgrade plan" menu item → `?tab=billing` (`AppSidebar.tsx:744-760, 834-844`).

Two-surface, Claude-style split:

**Surface A — Account settings** (`/app/settings/account`, `AccountSettings.tsx`): vertical rail with 6 tabs — Profile, Appearance, Account, Privacy, Billing, Usage (`AccountSettings.tsx:611-635`), plus a separated "Workspaces →" nav link (`:641-652`). Old tab URLs alias cleanly (`subscription→billing`, `notifications→profile`, `other→privacy`, unknown→profile; `:146-164`) — no stranding.

**Surface B — Workspaces drill-down** (`/app/settings/workspaces[/:section]`, `WorkspacesSection.tsx`): back-arrow rail; default landing = **My Workspaces** inventory (`WorkspaceManagement.tsx`); role-gated sections for the *current* workspace: Company Profile, Members, Notifications, Lease Configuration, Risk Watchlist, Approval Rules, Onboarding (`WorkspacesSection.tsx:57-69`). Unknown/denied section falls back to My Workspaces with an explicit amber notice (`:76-77, 139-143`) — good pattern.

Verdict on the skeleton: the two-surface split itself is clean and benchmark-competitive (small rail, account-vs-workspace boundary marked with a separator, aliased legacy URLs, honest role-denial messaging). The problems are all in **where individual tasks landed** inside that skeleton, and in **two parallel approval-config models** living side by side.

---

## 1. Task-by-task trace

### Task 1 — Rename the workspace ✅ (works, mild duplication)

- **Path:** user menu → Settings → "Workspaces" → landing panel "My Workspaces" → inline rename on the owned-workspace card (`WorkspaceManagement.tsx:275-284`, `RenameWorkspaceInline`). **3 clicks** to the control.
- **Second surface:** Workspaces → Company Profile → "Workspace Name" input + Save (`WorkspaceSettings.tsx:531-538, 556-559`). 4 clicks.
- Both write `workspaces.name`; the Company Profile save has good resilience: `.select()` so RLS-blocked 0-row updates surface as errors, and a rename-only retry when the bundled timezone write is frozen on read-only workspaces (`WorkspaceSettings.tsx:299-314`, #70/#87 carve-out).
- **Findable ≤2 clicks?** No — 3, but on the default landing panel of an obviously-named rail item. Mental grouping correct.
- **Friction (low):** the same operation exists in two sibling panels with different interaction styles (inline pencil vs form+Save). Harmless but slightly diluting.

### Task 2 — Invite a teammate *as approver* ⚠️ (two-phase, hidden second phase, and possibly routing-inert)

- **Invite:** Settings → Workspaces → Members → "Invite Team Member" (`MembersPanel.tsx:160-163`). The dialog offers only workspace **access** roles: Admin / Editor / Viewer (`InviteMemberDialog.tsx:171-175`). There is **no way to express "approver" at invite time** — the word doesn't appear in the dialog.
- **Approver assignment** lives in the same Members section as the "Approval Chain" card (Step 1 Manager Approval / Step 2 Financial Approval, `WorkspaceSettings.tsx:579-673`) writing `workspace_roles` via the atomic `set_workspace_roles` RPC (`:262`). But the card renders **only when `members.length > 1`** (`:579`) and `members` counts *accepted* `workspace_members` rows (`MembersPanel.tsx:65-100`) — so at the moment the owner sends the invite, the assignment UI does not exist yet, and nothing tells them to come back after acceptance. The task silently becomes two visits.
- **The bigger trap — the card can be routing-inert:** routing uses `workspace_roles` manager/financial assignments **only when the workspace has zero active approval policies** (`resolve-approval-chain/index.ts:1095` legacy branch fires only on `kind === "no_policies"`; `matchPolicy` at `:326-337` loads `is_active=true` policies). Once any active policy exists, chains come from `approval_chain_steps`, and the Approval Chain card's Step 1/Step 2 picks stop deciding anything about routing — yet the card renders identically, fully editable, with the description "Lease requests flow through Manager Approval first, then Financial Approval before execution" (`WorkspaceSettings.tsx:583-585`) and an amber warning "No Financial Approver assigned — commitments will stall after manager approval" (`:665-671`) that is **factually wrong** for a policy-routed workspace. An admin can "fix" an approver here and change nothing. (The roles do still matter for Approvals-nav visibility, badge counts, and legacy notification targets — `authorization.ts:29-30`, `AppSidebar.tsx:216-257`, `retryRequestRouting.ts:52-53` — which makes the半-live surface even more confusing: edits *partially* do something.)
- **Vocabulary overload:** one Members screen exposes three role systems (access roles admin/editor/viewer; functional roles submitter/admin checkboxes + two approver slots; policy chain roles in the editor one section over), and a fourth exists invisibly (`workspace_approvers` allowlist — see §3).
- **Findable ≤2 clicks?** Invite yes (4 clicks but obvious); "as approver" — not expressible in one sitting, and possibly a no-op for routing. **Severity: high** (badly misleading core-flow configuration).

### Task 3 — Set who signs leases ❌ (effectively hidden; one config path is a hard trap)

- The **only** place a signer is configured is the approval-policy editor's signator stage ("Then, sign the deal") — `ApprovalPolicyEditPage.tsx:93, 193-209, 287, 436`. Path: Settings → Workspaces → **Approval Rules** → the section is a *signpost card* whose sole action is an "Open Approval Rules" button (`WorkspaceSettings.tsx:952-976`) → `/app/settings/approval-policies` list → create/edit a policy → scroll to the signator chain. **5–6 clicks**, crossing a pass-through hop, with "sign" never appearing in any rail label. Nothing in Members (where a user hunting for "who signs" will look, next to approvers) mentions signing.
- **If the workspace has no policies (the default state), no signature step exists at all.** The legacy path flips `draft → submitted/under_review/approved` with no signator stage (`resolve-approval-chain/index.ts:1095-1155`, `getInitialStatusAfterSubmission`). So for a fresh workspace the task is *impossible* — the concept "signer" only comes into existence by creating an approval policy, and no settings surface says so.
- **The Signatory-role trap (dead-end state):** the policy editor's step-role picker offers `{ value: 'signator', label: 'Signatory' }` (`ChainDiagram.tsx:64`). Role-based steps are matched to users via `workspace_roles` (`ApprovalQueue.tsx:700-705` — `approver_role.in.(myRoleNames)`; `SignatorReview.tsx:200-201` — `userFunctionalRoles.includes(approver_role)`). But **no UI anywhere grants the `signator` functional role**: the only `workspace_roles` writer is WorkspaceSettings' Save Roles (`WorkspaceSettings.tsx:262`), whose UI offers exactly `submitter`/`admin` checkboxes (`:715`) plus the manager/financial slots; the `FunctionalRole` TS type omits `signator` entirely (`src/types/lifecycle.ts:76`), even though the DB CHECK allows it (`20260516120000_baseline_schema.sql:2101`). Policy validation accepts role-only steps without checking for holders (`approvalPolicyValidation.ts:80-83`). Net: an admin who picks "Signatory" as a by-role signer builds a chain step **no human can ever see or act on** — the lease reaches the signature stage and stalls indefinitely with no assignee and no warning at config time. (Work-around exists — assign a specific user — but nothing steers you away from the trap.)
- **Findable ≤2 clicks?** No. **Task partially impossible** (no-policy workspaces) and **trap-prone** (role-based signer). **Severity: high.**

### Task 4 — Check bill/plan ✅ (best-executed task)

- Settings → **Billing** tab: plan header with benefit line + renewal date (`AccountSettings.tsx:1099-1134`), "Adjust plan" picker (`:1126`, `PlanPickerDialog`), saved card + Update via Stripe portal (`:1146-1182`), invoice table with hosted-invoice links (`:1186-1239`), credits balance (`:1253-1261`), cancel flow with honest CTA copy (`:1263-1286, 1508-1547`). Trial/past-due/abandoned-checkout banners all guarded (`:995-1065`). **3 clicks**, correct grouping, error/retry/loading/no-workspace states all handled (`:959-978`).
- **Role behavior:** members see the plan but get "billing_admin_only" notes instead of empty sections (`:1018, 1130, 1161-1162, 1188-1189`) — honest. Firm-bound workspaces get the firm-managed banner and hidden payment/cancel controls (`:982-989, 1141, 1268`) — matches the server 403s.
- **Mental-model quirk (low):** workspace-scoped billing lives under *Account* settings; deliberately signposted from Company Profile ("Plan and billing for this workspace are managed in your Account settings" + Go to Billing button, `WorkspaceSettings.tsx:514-524`). Acceptable.
- Minor: pack purchasing lives on the **Usage** tab (`:1292-1294`), splitting spend controls across two tabs — intentional per comment (`:1243-1247`), mild.

### Task 5 — Turn notifications on/off ⚠️ (scattered across three surfaces, one orphaned, one channel dead)

- **No "Notifications" tab exists** in the account rail (`VALID_TABS` = profile/appearance/account/privacy/billing/usage, `AccountSettings.tsx:158`). The per-user toggles (email, SMS, abstraction-complete) are the **second card inside Profile** (`:737-789`), autosaving on flip. Findable in 2 clicks *if* the user guesses "Profile"; a rail scan shows nothing notification-named. The `?tab=notifications` alias (`:154`) proves the tab used to exist — the concept was folded away, not relocated visibly.
- **The SMS toggle is a dead control.** It persists `profiles.sms_notifications_enabled` (`AccountSettings.tsx:350`) — and **nothing in the codebase reads it**: repo-wide, the column appears only in the settings page, the schema, and generated types; no edge function queries it and no SMS provider exists (grep `sms|twilio` across `supabase/functions` → zero hits; email senders check only `email_notifications_enabled` / `notify_abstraction_complete` — `process_lease/index.ts:2669-2673`, `process-alerts/index.ts:220-243`). Compounding: the phone-number field was deliberately removed from Profile (`AccountSettings.tsx:695-698`, #69/#80), so there is no number to text even if a sender existed. A user enabling "SMS notifications" is opting into a channel that can never fire, with a success toast.
- **Workspace "Notifications" section** (Workspaces → Notifications) contains exactly one input: default reminder days before expiration (`WorkspaceSettings.tsx:757-793`). The section name promises workspace notification management; it holds a single default.
- **Per-lease notification management is orphaned.** The real notification center — in-app alerts + the per-lease email event scheduler with confirm/toggle controls — is `/app/notifications` (`Notifications.tsx`, routed at `App.tsx:320-334`). The header bell that used to reach it was removed *because* "the bell duplicated /app/notifications" (`AppHeader.tsx:28-30`), but the sidebar nav has no notifications entry (`AppSidebar.tsx:296-303`). Remaining inbound links: the dismissible OnboardingChecklist step (`OnboardingChecklist.tsx:49-54` — disappears once dismissed or all steps complete) and NotificationDetail's own back button (`NotificationDetail.tsx:206,230` — requires already being there). No edge-function email deep-links either (grep `app/notifications` in `supabase/functions` → zero). **Post-onboarding, a user cannot navigate to the notifications center at all.**

---

## 2. IA benchmark comparison (Claude-desktop-style settings)

What matches the benchmark (genuinely good):
- Single settings doorway from the user menu; small vertical rail; account-vs-workspace boundary explicit (separator + back-arrow sub-rail).
- Legacy-URL aliasing so nothing strands (`AccountSettings.tsx:140-164`; `WorkspacesSection.tsx:71-77`).
- Autosave toggles with debounced toast (`:338-362`); role-denial explained rather than silently substituted (`WorkspacesSection.tsx:139-143`).

Where it deviates:
1. **Approval configuration violates "one concept, one place."** Two competing models (legacy chain card in Members; policy chains behind a signpost in Approval Rules) with an undisclosed precedence rule between them. Claude-style IA never shows two editable controls for the same decision where one silently wins.
2. **Notifications violate "findable by scanning."** Three surfaces (Profile card / workspace section / orphaned page), none named where a user would look first, one unreachable.
3. **Pass-through sections.** "Approval Rules" in the drill-down rail is mostly a launcher card to another full page — an extra hop the benchmark avoids (either embed or link directly from the rail).
4. Minor: duplicated rename; two 4-option US-only timezone pickers (user `AccountSettings.tsx:48-53`, workspace `WorkspaceSettings.tsx:39-44`) — non-US customers can't represent their timezone at all.

## 3. Additional code-verified findings in the swept surfaces

- **"Current password" field is decorative.** The change-password form collects it (`AccountSettings.tsx:72, 824-843`) but `handleChangePassword` never validates or transmits it — it calls `supabase.auth.updateUser({ password: newPassword })` only (`:301-333`). Typing a *wrong* current password still succeeds. Misleading security affordance (and a minor session-hijack hardening gap vs. reauthentication).
- **`workspace_approvers` is consumed but unconfigurable — and CLAUDE.md is wrong about it.** CLAUDE.md ("Known Schema Realities") claims the table "has no read/write path in the frontend." It **has a read path**: the direct-add Request Approval flow merges it into approver candidates (`LeaseReview.tsx:1033-1063`, `approverCandidates.ts:24-57`). It has no write path — so an "explicit approver allowlist" that actively shapes who can be asked to approve a locked change-set can never be populated from the UI. docsDrift + missing config surface.
- **`NudgeChannel` includes `'sms'`** (`types/lifecycle.ts:80`) with no SMS capability anywhere — same dead-channel class as the toggle.
- Role-gating is otherwise correct and consistent: owner normalizes to admin everywhere (`authorization.ts:6-19`; #5 fix noted at `WorkspaceSettings.tsx:130-134`); editors get Company Profile/Notifications read-only with explicit notes; viewers see only My Workspaces; the rail and the panels share the same gates so no empty panes (`WorkspacesSection.tsx:55-69` mirrors `WorkspaceSettings.tsx:566, 756, 797, 943, 952, 1115`).

## 4. Recommendations (concrete, ordered)

1. **Reconcile the two approver surfaces.** When ≥1 active policy exists, replace the Approval Chain card's editable slots with a read-only "Routing is governed by your Approval Rules" state (link to the policies list), and suppress the "commitments will stall" warning. Alternatively, auto-migrate the legacy card into a default fallback policy and retire it.
2. **Kill the Signatory-role trap.** Either (a) add a signatory assignment to the Members roles grid (write `signator` to `workspace_roles` — DB already allows it) so the role option resolves, or (b) drop `signator` from `ChainDiagram`'s role options and force user-assignment; and add a `validatePolicy` check: role-based step whose role has zero holders → block or warn at save.
3. **Restore a navigation path to `/app/notifications`** (sidebar item or header bell) or fold the page's per-lease scheduler into settings. Right now it is a built, routed, orphaned surface.
4. **Remove or ship the SMS toggle.** As-is it records consent for a channel that cannot fire; removing it is one deletion (mirror of the removed phone field per #69/#80).
5. **Name notifications where users look:** either a "Notifications" rail tab in Account settings (moving the Profile card) or a rail-visible subsection label.
6. **Make "who signs" reachable:** at minimum a signpost in the Members section ("Signers are configured per Approval Rule → open"), and a first-run empty state on Approval Rules explaining that without a policy there is no signature stage.
7. **Invite flow:** after a successful invite, if the invitee is intended as an approver, surface a "assign roles once they accept" hint (or allow pre-assignment on the pending row).
8. Fix or remove the current-password field (Supabase supports reauthentication via `signInWithPassword` before `updateUser`).
9. Update CLAUDE.md's `workspace_approvers` claim (read path exists) and file the missing-write-UI gap in KNOWN_ISSUES.

## 5. Severity summary

| # | Finding | Severity |
|---|---|---|
| 1 | Role-based "Signatory" step unresolvable → signature stage stalls, no warning | High |
| 2 | Approval Chain card editable-but-inert when policies exist; wrong stall warning | High |
| 3 | `/app/notifications` orphaned from all navigation post-onboarding | High |
| 4 | "Set who signs" impossible on no-policy workspaces; nothing says so | High |
| 5 | SMS toggle persists a preference nothing reads; no phone number exists | Medium |
| 6 | Invite-as-approver is a hidden two-phase task (chain card gated on accepted member #2) | Medium |
| 7 | Current-password field collected, never verified | Medium |
| 8 | `workspace_approvers` read-only-consumed, unconfigurable; CLAUDE.md misstates it | Medium (docsDrift) |
| 9 | Notifications concept split across 3 surfaces, none rail-named | Medium |
| 10 | Three-to-four role vocabularies coexisting in Members area | Medium |
| 11 | Pass-through "Approval Rules" section; rename duplication; 4-option US-only timezones ×2 | Low |
