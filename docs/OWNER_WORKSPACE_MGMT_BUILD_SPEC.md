# Owner Workspace Management — Build Spec

**Status:** ACTIVE — opens after Phase 3 close (2026-05-05).
**Position in build plan:** Parallel to but **NOT part of** the chain-workflow track (Phases 1-8). This feature is account/workspace management, foundational for any tier per `docs/PRODUCT_STRATEGY.md`. Phase 4 (negotiation document tracking) opens after this feature closes.
**Prerequisite reading:** `docs/PRODUCT_STRATEGY.md`, this conversation log entry where the user requested the feature on 2026-05-04.

---

## Why this feature now

Two things forced this onto the queue ahead of Phase 4:

1. **No surface exists today for an owner to manage their workspaces.** A user who owns 4 workspaces (the user's actual state, surfaced during Phase 3 forensics) cannot see them all in one place, cannot manage members of inactive workspaces without switching context, cannot rename, cannot delete. The workspace switcher in the sidebar lets you change *active* context but provides no management.

2. **Phase 3 forensics surfaced data hygiene gaps that need a UI to clean up:** an orphan workspace (`440d279f-a781-450a-863a-73b51780becd` "My Workspace" — 0 members, 0 leases, created 13 seconds after a sibling workspace by the same user, indicating a duplicate-creation bug filed as `KNOWN_ISSUES.md` item #8). A workspace owner needs a UI to delete this kind of orphan rather than going to Studio.

Per `PRODUCT_STRATEGY.md`, the firm layer (Phase 9) builds on workspace as the unit of data isolation. **Owners must be able to manage their own workspaces before we layer firms on top.** This feature is foundational to both single-workspace tiers (Plus / Pro) and the firm tier.

---

## What's already in the repo (leverage, don't duplicate)

| Concern | Existing surface | Notes |
|---|---|---|
| Active-workspace context | `src/contexts/AppContext.tsx` | Already loads `availableWorkspaces` (every workspace owned + every workspace user is a member of). Powers the sidebar switcher. Switch via `switchWorkspace(id)`. |
| Per-workspace settings | `src/pages/settings/WorkspaceSettings.tsx` | Manages active workspace's members, invites, roles, financial settings, etc. ~1200 lines. |
| Invite by email | `InviteMemberDialog` + `send-invite` edge function + `accept-invite` edge function + `invite_tokens` table | Full email-based invite flow exists. |
| Member roles | `workspace_members.role` enum (`admin` / `editor` / `viewer`) | Schema supports per-member role per workspace. |
| RLS — workspace SELECT | `workspaces FOR SELECT USING (owner_id = auth.uid() OR is_workspace_member(id, auth.uid()))` | Migration `20260105034911`. Correct: a user only sees workspaces they own OR are members of. |
| RLS — workspace UPDATE | `workspaces FOR UPDATE USING (owner_id = auth.uid())` | Owner-only update. Cannot rename someone else's workspace. |
| RLS — workspace DELETE | `workspaces FOR DELETE USING (owner_id = auth.uid())` | Owner-only delete. Policy exists; no UI calls it. |
| FK on `leases.workspace_id` | `ON DELETE SET NULL` (migration `20260106053641` line 78) | **This is the cascade gap.** Deleting a workspace today would orphan leases with `workspace_id = NULL`, hidden from RLS but still present and consuming storage. We will NOT change this FK; we'll do explicit transactional cleanup in an edge function. |

**Gap:** No `/app/account/workspaces` page. No `delete-workspace` edge function. No way for an owner to manage members of a non-active workspace.

---

## What we're building

### A. New page: `/app/account/workspaces`

Lives under the user-account dropdown menu (top-right). Two sections:

**Section 1 — Workspaces I own.** Per row:
- Workspace name (rename inline by clicking)
- Plan label (`free` / `business` / etc. — informational only, no billing actions)
- Member count, lease count, created date
- "Active" pill if this is the currently active workspace
- Three actions per row:
  - **Manage members** → opens an inline panel/drawer (not a modal) with full member management
  - **Rename** → inline edit
  - **Delete** → opens type-name confirmation dialog

**Section 2 — Workspaces I'm a member of (not owner).** Per row:
- Workspace name (read-only)
- Plan label
- My role in that workspace
- Active pill if currently active
- Single action: **Leave workspace** (with one-click confirm: "you'll lose access immediately")

### B. Reusable component: `MembersPanel`

Extracted from `WorkspaceSettings.tsx`. Takes `workspaceId` as a prop (instead of pulling from active workspace). Exposes:
- Current members list (workspace_members joined to profiles for email/name)
- "Invite by email" form (uses the existing `send-invite` edge function with `workspace_id` and `email` and `role`)
- Pending invites list (from `invite_tokens` where `accepted_at IS NULL` and `expires_at > now()`)
- Per-member role select (admin / editor / viewer)
- Per-member remove button (DELETE from workspace_members; with confirmation)

**Owner self-protection rule:** the panel must NOT allow the owner to remove themselves from their own workspace. Greyed-out remove button + tooltip. Workspace deletion is the way to remove yourself; transferring ownership is out of scope (Phase 9 firm layer territory).

This component is also dropped into `WorkspaceSettings.tsx` to replace the existing inline member-management code. One-time refactor; no behavior change for the active-workspace settings page.

### C. New migration

`supabase/migrations/<ts>_owner_workspace_mgmt.sql`:

```sql
-- Audit trail for workspace deletion. Forensics + billing reconciliation.
-- Survives the deletion of the workspace itself.
CREATE TABLE IF NOT EXISTS public.deleted_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_workspace_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_name text,
  workspace_plan text,
  lease_count_at_deletion int,
  member_count_at_deletion int,
  storage_objects_purged int,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.deleted_workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners view own workspace deletions" ON public.deleted_workspaces;
CREATE POLICY "Owners view own workspace deletions" ON public.deleted_workspaces
  FOR SELECT USING (owner_id = auth.uid() OR deleted_by = auth.uid());

-- No INSERT policy for authenticated. Only the service role
-- (delete-workspace edge function via supabaseAdmin) inserts.

CREATE INDEX IF NOT EXISTS idx_deleted_workspaces_owner ON public.deleted_workspaces(owner_id, deleted_at DESC);
```

### D. New edge function: `delete-workspace`

Path: `supabase/functions/delete-workspace/index.ts`. Mirrors the `lease-governance-action` shape:
- CORS / auth / `enforceWorkspaceRateLimit` (e.g., 5 deletions per hour per workspace owner — rate limit is mostly for safety, not abuse)
- Verify `auth.uid() === workspaces.owner_id` for the target workspace
- Verify the request body includes `confirmName` and that it matches the workspace name exactly (defense in depth — UI also enforces but server enforces too)
- **Transactional cascade in this order:**
  1. Capture workspace metadata for audit row (name, plan, member count, lease count)
  2. List storage objects under buckets `leases` and `executed-leases` whose path begins with this workspace's id (or whose lease is in this workspace) and capture the count
  3. Delete child rows in dependency order (most-dependent first):
     - `lease_activity_log` (where lease_id IN workspace's leases)
     - `lease_approval_chain` (where workspace_id = X)
     - `lease_documents` (Phase 4 will add this; if exists today, include here)
     - `lease_change_set_items` (where change_set_id IN workspace's change sets)
     - `lease_change_sets` (where workspace_id = X)
     - `lease_governance_audit` (where workspace_id = X)
     - `lease_unlock_requests` (where workspace_id = X)
     - `lease_field_confidence` (where lease_id IN ...)
     - `field_corrections` (where lease_id IN ...)
     - `executed_term_edits` (where lease_id IN ...)
     - `risks` (where lease_id IN ...)
     - `lease_nudges` (where lease_id IN ...)
     - `lease_approval_actions` (where lease_id IN ...)
     - `leases` (where workspace_id = X)
     - `approval_chain_steps` (where policy_id IN workspace's policies)
     - `approval_policies` (where workspace_id = X)
     - `workspace_roles` (where workspace_id = X)
     - `invite_tokens` (where workspace_id = X)
     - `workspace_approvers` (where workspace_id = X)
     - `processing_rate_limits` (where workspace_id = X)
     - `workspace_members` (where workspace_id = X)
     - `workspaces` (id = X)
  4. Delete storage objects for the workspace
  5. Insert `deleted_workspaces` audit row
- Return `{ ok: true, workspaceId, leaseCount, memberCount, storageObjectsPurged }` on success
- On any failure: return error with reason; log to console with full stack; the partial deletion state is acceptable (next retry cleans up the rest, rows are owner-isolated by RLS so an orphan is invisible)

**Why edge function and not `ON DELETE CASCADE`:**
- Explicit transactional control + audit trail capture before delete
- Storage cleanup (PDFs in object storage don't cascade with table FK)
- Captures forensic counts (lease count, member count, storage object count) for `deleted_workspaces`
- Service-role auth bypasses RLS for the cascade reads/deletes; UI authorization is in the app

### E. Frontend components

**`src/pages/account/WorkspaceManagement.tsx`** — top-level page. Renders the two sections + drawer for member management + delete confirmation dialog. Fetches owned + member workspaces from `AppContext.availableWorkspaces` (already loaded). Uses TanStack Query for per-workspace lease/member counts (one query per visible workspace; capped at e.g. 50 visible).

**`src/components/workspace/MembersPanel.tsx`** — extracted from `WorkspaceSettings.tsx`. Takes `workspaceId` prop. Self-fetches members + invites for that workspace.

**`src/components/workspace/DeleteWorkspaceDialog.tsx`** — type-name confirmation dialog. Required user input must match workspace name exactly (case-sensitive). Disable confirm button until match. Long-form copy: "This will permanently delete the **{name}** workspace and all of its data — every lease, every uploaded document, every approval policy, every audit log entry, every member assignment. This action cannot be undone." Calls `delete-workspace` edge function on confirm.

**`src/components/workspace/RenameWorkspaceInline.tsx`** — small inline rename input. Click name → input. Enter to save → `UPDATE workspaces SET name = ... WHERE id = X` (RLS enforces owner). Optimistic UI; revert on error.

**`src/components/account/AccountMenu.tsx`** — adds a "Workspaces" item to the user account dropdown (might already exist; if not, add). Routes to `/app/account/workspaces`.

### F. Routing

Add to `App.tsx`:
```
<Route path="/app/account/workspaces" element={<WorkspaceManagement />} />
```

The `/app/account/*` namespace is reserved for user-level (not workspace-level) features. Distinct from `/app/settings/*` which is per-workspace.

### G. Tests

**SQL test file** `supabase/tests/owner_workspace_mgmt.test.sql`:
- `deleted_workspaces` RLS scoping (owner sees own; non-owner sees zero)
- `deleted_workspaces` insert policy: only service role can insert
- Cascade-equivalent SQL: simulate the edge function's delete sequence in a DO block; verify all child rows gone, FK constraints satisfied, storage path captured

**Vitest unit tests** for pure helpers if any extracted (e.g., a `validateDeleteConfirmation(typedName, actualName)` helper).

**Integration check:** manual smoke per the smoke checklist below; functional behavior of the edge function gets verified end-to-end in the deployed app.

---

## Decisions resolved before scoping (reference)

These were aligned in the conversation thread leading to this spec:

1. **"Internally or externally" = both via email invite.** Same `send-invite` edge function. No separate "internal user directory" feature. (Internal directory would expose a list of all users in the system, which is privacy-fraught and out of scope.)
2. **In-context member management.** No active-workspace switching required to invite/remove a member. `MembersPanel` is workspace-agnostic and takes `workspaceId` as a prop.
3. **Delete confirmation = type the workspace name.** Standard pattern from GitHub, Stripe, etc. Strikes the right balance for a single-tenant workspace.
4. **Tier-aware behavior: plan label only, no billing actions.** Billing stays on Account Settings. The workspaces page shows plan as informational metadata.
5. **Routing:** `/app/account/workspaces` (under account, distinct from per-workspace `/app/settings`).
6. **Sidebar visibility: shown to all authenticated users.** Members benefit from a "leave workspace" path; owners get the full management view.
7. **Owner self-protection:** owner cannot remove themselves from `workspace_members`; deletion is the way to fully exit. (Ownership transfer = Phase 9 firm-layer territory.)
8. **Cascade strategy = explicit edge function, not FK CASCADE change.** Explicit gives us audit capture + storage cleanup + transactional control; changing the FK on `leases.workspace_id` would affect every future delete path and increase blast radius.

---

## Out of scope for this feature

- **Ownership transfer.** A → B owner reassignment. Phase 9 firm-layer territory; firm-tier-only feature.
- **Workspace cloning / duplication.** Not requested.
- **Soft-delete / undo window.** All deletions are immediate and permanent. Type-name confirmation is the only safety net.
- **Audit log of member changes** beyond what `workspace_members.created_at` already captures. (Adding a `workspace_membership_log` is filed for later if/when it becomes needed.)
- **Bulk operations** (delete multiple workspaces at once, bulk invite, etc.). One-by-one is fine for v1.
- **Workspace metadata beyond name.** Description, logo, color, etc. all out of scope.
- **Plan upgrade / downgrade UI.** Stays on Account Settings.
- **Firm-layer scaffolding.** Per `PRODUCT_STRATEGY.md`, no `firm_id` columns, no firm-aware queries. Phase 9 owns that.
- **Fixing the duplicate-workspace-creation bug** (KNOWN_ISSUES item #8). Separate ticket. This feature gives the user a tool to clean up duplicates that exist today; preventing future duplicates is a different surface (Signup / Onboarding).
- **Fixing the creator-membership timestamp gap** (KNOWN_ISSUES item #9). Separate ticket.
- **The cross-workspace inbox.** That's Phase 10 firm-layer territory.

---

## Definition of done

1. Migration applied cleanly to staging. Mirror committed to `supabase/migrations/`.
2. `delete-workspace` edge function deployed. Manual smoke confirms transactional cascade.
3. `/app/account/workspaces` page lives. Both sections render. Owned workspaces show all metadata. Member workspaces show role.
4. `MembersPanel` extracted and used in BOTH the new page and `WorkspaceSettings.tsx`. Behavior on the active workspace settings page is unchanged.
5. Rename inline works. Optimistic UI reverts on RLS error.
6. Delete with type-name confirmation works. Confirm button disabled until match. After successful delete: workspace removed from sidebar switcher (AppContext refetches), `deleted_workspaces` audit row exists, all child rows gone, storage objects purged.
7. Owner cannot remove self via `MembersPanel` (button disabled with tooltip).
8. SQL test file committed in `supabase/tests/`. README updated.
9. `npx tsc --noEmit` clean. `npx vitest run` passes (no regression; +N tests if any pure helpers extracted).
10. Smoke checklist (drafted at Checkpoint 5) green: create-workspace + invite member + rename + delete walks cleanly.
11. CLAUDE.md updated to mark Owner Workspace Management closed and Phase 4 next active.
12. KNOWN_ISSUES item #8 (duplicate workspace creation) updated with a note: the orphan `440d279f` workspace was deleted via this feature in workshop testing.

---

## Checkpoints (gated, like Phase 3)

Each checkpoint passes typecheck + vitest before the next starts. User reviews and green-lights between checkpoints.

### Checkpoint 1 — Migration + edge function

- Write `supabase/migrations/<ts>_owner_workspace_mgmt.sql` with `deleted_workspaces` table + RLS
- Apply migration via `mcp__claude_ai_Supabase__apply_migration`
- Verify schema (table exists, RLS enabled, policy exists)
- Regenerate `src/integrations/supabase/types.ts`
- Write `supabase/functions/delete-workspace/index.ts`
- Deploy via `mcp__claude_ai_Supabase__deploy_edge_function` with `verify_jwt: true`
- Verify deployed source matches committed source via `get_edge_function`
- Smoke: 401 on unauth POST, 200 on OPTIONS preflight
- **STOP.** User confirms before Checkpoint 2.

### Checkpoint 2 — `MembersPanel` extraction

- Refactor `WorkspaceSettings.tsx` member-management code into `src/components/workspace/MembersPanel.tsx`
- New component takes `workspaceId` prop and self-fetches everything it needs
- Re-import in `WorkspaceSettings.tsx` to replace the inline code
- Behavior on `/app/settings/workspace` must be byte-identical (smoke verifies)
- Add typecheck + vitest gates
- **STOP.** User confirms behavior on the existing settings page is unchanged.

### Checkpoint 3 — Page + rename + delete UI

- `src/pages/account/WorkspaceManagement.tsx` (page) with both sections
- `src/components/workspace/RenameWorkspaceInline.tsx`
- `src/components/workspace/DeleteWorkspaceDialog.tsx`
- Account dropdown menu entry pointing to `/app/account/workspaces`
- Route registered in `App.tsx`
- Wires `MembersPanel` (from Checkpoint 2) into a drawer/panel triggered by "Manage members"
- Wires delete dialog to the `delete-workspace` edge function
- AppContext invalidation on delete success (refresh `availableWorkspaces`)
- Member-workspace section's "Leave workspace" action: simple `DELETE FROM workspace_members WHERE workspace_id = X AND user_id = me`
- typecheck + vitest gates
- **STOP.** User smoke-tests on the deployed Vercel build:
  - Sees both sections
  - Can rename a workspace
  - Can manage members of a non-active workspace without switching
  - Can delete a workspace via type-name confirmation
  - Can leave a workspace they're a member of (not owner)
  - All four actions update the sidebar switcher correctly
  - Deleted workspace's data is gone (verify via SQL — leases/members/storage all cleared)
  - `deleted_workspaces` audit row exists
- **STOP.** User confirms.

### Checkpoint 4 — Tests + docs + closeout

- SQL test file `supabase/tests/owner_workspace_mgmt.test.sql`
- Vitest tests for any pure helpers extracted
- Update `supabase/tests/README.md`
- Update `CLAUDE.md`: Owner Workspace Management → CLOSED. Phase 4 → ACTIVE.
- Update `KNOWN_ISSUES.md`:
  - Item #8 (duplicate workspace creation): note the orphan `440d279f` was deleted via this feature in testing
  - Add any new items that surfaced during smoke
- Closeout commit citing this spec by SHA per the audit-doc inheritance rule
- Final tests/typecheck reported
- **STOP.** Sealed.

---

## Risk register

**Risk: Edge function partial-delete leaves a workspace in an inconsistent state.**
Mitigation: catch all exceptions, log them, and structure the cascade so a retry is idempotent (each DELETE is `WHERE workspace_id = X` — re-running deletes any remaining rows; the final `DELETE FROM workspaces WHERE id = X` only succeeds when child rows are gone, so a partial delete leaves the workspace as the canary that retry can finish). Worst case: orphan rows in `lease_activity_log` etc. — invisible to RLS once the parent lease row is deleted.

**Risk: Race condition on simultaneous delete + active workspace switch.**
Mitigation: edge function checks `owner_id = auth.uid()` at delete time. If the user has somehow lost ownership between page load and click, the function rejects. Frontend should also call `switchWorkspace(null)` or to a different workspace first if the user is deleting their currently-active workspace.

**Risk: Storage cleanup misses some objects.**
Mitigation: list-and-delete all objects under the workspace's path prefix in both buckets (`leases/` and `executed-leases/`). If lease IDs in those bucket paths use the workspace's UUID prefix, the listing is straightforward. If not (per-user paths), iterate by lease IDs first.

**Risk: User accidentally deletes their last workspace and is locked out.**
Mitigation: post-delete, if the user has zero remaining workspaces, redirect to `/app/onboarding/create-workspace` (which already exists; if not, the user lands at `/` and existing onboarding flow takes over). Don't block the deletion.

**Risk: Plan-tier behavior depends on workspace count.**
Mitigation: per `PRODUCT_STRATEGY.md`, Plus/Pro is per-workspace billing. Stripe knows about each workspace independently. Deleting a workspace doesn't automatically cancel its Stripe subscription — that's a separate concern (do owners need to cancel subscription before delete? does delete also cancel? — answer: delete should also cancel, BUT this is post-MVP polish; for now, deletion does not touch Stripe and the user is responsible for canceling separately).

---

## Rollback

- **Migration:** drop `deleted_workspaces` table.
- **Edge function:** delete `supabase/functions/delete-workspace/`. Owner-delete path simply doesn't exist anymore.
- **Frontend:** `git revert` of the UI commits. The `/app/account/workspaces` route 404s; sidebar item disappears. `MembersPanel` revert is the trickier piece — better to revert as a whole instead of leaving the component extracted but unused. Or extract-then-keep (post-revert), accepting the slight code reuse without the new feature.

---

## As-built notes (placeholder, populated at close)

Spec ↔ implementation deltas to be captured here at Checkpoint 4 close, citing this spec doc by SHA per the audit-doc inheritance rule.

---

## Tracking

Surfaced and scoped 2026-05-04 → 2026-05-05 in conversation with the user. Phase 3 closed before this spec opened. Phase 4 opens after this spec closes.
