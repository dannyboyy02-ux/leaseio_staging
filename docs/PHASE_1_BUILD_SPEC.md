# Phase 1 Build Spec — Approval Policy Editor

**Prerequisite reading:** `APPROVAL_ROUTING_ARCHITECTURE.md`
**Phase scope:** Schema + admin UI for managing approval policies.
**Out of scope for Phase 1:** Runtime resolution, chain table, lifecycle changes, notifications. Those are Phase 2+.

This phase builds the data model and the admin tooling to populate it. After Phase 1, admins can configure policies and verify they look right via the preview tool, but no lease workflow has changed yet. Phase 2 wires those policies into actual lease submissions.

---

## Goals of this phase

1. Admins can create, edit, archive, and delete approval policies for their workspace.
2. Admins can define matching criteria, chain steps, and per-policy separation-of-duties overrides.
3. Admins can preview which policy would resolve for a hypothetical request before saving anything.
4. The data model is forward-compatible with all later phases (resolution, rerouting, delegation).

---

## Database migrations

Create one migration file: `<timestamp>_phase1_approval_policies.sql`.

### Workspace-level addition

```sql
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS separation_of_duties_default boolean NOT NULL DEFAULT true;
```

### `approval_policies` table

```sql
CREATE TABLE public.approval_policies (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name                            text NOT NULL,
  description                     text,
  priority                        integer NOT NULL DEFAULT 100,
  match_asset_types               text[] NOT NULL DEFAULT '{}',
  match_departments               text[] NOT NULL DEFAULT '{}',
  match_min_annual_cost           numeric,
  match_max_annual_cost           numeric,
  match_regions                   text[] NOT NULL DEFAULT '{}',
  match_lease_types               text[] NOT NULL DEFAULT '{}',
  separation_of_duties_override   boolean,
  is_default_fallback             boolean NOT NULL DEFAULT false,
  version                         integer NOT NULL DEFAULT 1,
  is_active                       boolean NOT NULL DEFAULT true,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  created_by                      uuid NOT NULL REFERENCES auth.users(id),
  updated_by                      uuid NOT NULL REFERENCES auth.users(id),
  CONSTRAINT cost_range_valid CHECK (
    match_min_annual_cost IS NULL OR
    match_max_annual_cost IS NULL OR
    match_min_annual_cost <= match_max_annual_cost
  )
);

CREATE INDEX idx_approval_policies_workspace_active
  ON public.approval_policies(workspace_id, is_active);

CREATE UNIQUE INDEX idx_approval_policies_one_default_per_workspace
  ON public.approval_policies(workspace_id)
  WHERE is_default_fallback = true AND is_active = true;
```

### `approval_chain_steps` table

```sql
CREATE TABLE public.approval_chain_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id           uuid NOT NULL REFERENCES public.approval_policies(id) ON DELETE CASCADE,
  stage               text NOT NULL CHECK (stage IN ('concept', 'signator')),
  step_order          integer NOT NULL,
  parallel_group      integer NOT NULL DEFAULT 1,
  approver_user_id    uuid REFERENCES auth.users(id),
  approver_role       text CHECK (approver_role IN ('submitter', 'manager_approver', 'financial_approver', 'signator', 'admin')),
  delegate_user_id    uuid REFERENCES auth.users(id),
  delegate_after_days integer CHECK (delegate_after_days IS NULL OR delegate_after_days > 0),
  is_required         boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_assignee_method CHECK (
    (approver_user_id IS NOT NULL AND approver_role IS NULL) OR
    (approver_user_id IS NULL AND approver_role IS NOT NULL)
  )
);

CREATE INDEX idx_approval_chain_steps_policy
  ON public.approval_chain_steps(policy_id, stage, step_order);
```

### `updated_at` trigger

Use the existing `set_updated_at()` function from prior migrations. Add the trigger:

```sql
CREATE TRIGGER approval_policies_updated_at
  BEFORE UPDATE ON public.approval_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
```

### Version increment trigger

```sql
CREATE OR REPLACE FUNCTION public.increment_policy_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER approval_policies_version_increment
  BEFORE UPDATE ON public.approval_policies
  FOR EACH ROW
  WHEN (
    OLD.name IS DISTINCT FROM NEW.name OR
    OLD.match_asset_types IS DISTINCT FROM NEW.match_asset_types OR
    OLD.match_departments IS DISTINCT FROM NEW.match_departments OR
    OLD.match_min_annual_cost IS DISTINCT FROM NEW.match_min_annual_cost OR
    OLD.match_max_annual_cost IS DISTINCT FROM NEW.match_max_annual_cost OR
    OLD.match_regions IS DISTINCT FROM NEW.match_regions OR
    OLD.match_lease_types IS DISTINCT FROM NEW.match_lease_types OR
    OLD.priority IS DISTINCT FROM NEW.priority OR
    OLD.separation_of_duties_override IS DISTINCT FROM NEW.separation_of_duties_override
  )
  EXECUTE FUNCTION public.increment_policy_version();
```

### Row Level Security

```sql
ALTER TABLE public.approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_chain_steps ENABLE ROW LEVEL SECURITY;

-- Policies: workspace members can read; only admins/owners can write
CREATE POLICY "workspace members read policies"
  ON public.approval_policies FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
      UNION
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY "workspace admins write policies"
  ON public.approval_policies FOR ALL
  USING (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      UNION
      SELECT workspace_id FROM public.workspace_members
        WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Chain steps inherit visibility/write through the parent policy
CREATE POLICY "members read steps via policy"
  ON public.approval_chain_steps FOR SELECT
  USING (
    policy_id IN (
      SELECT id FROM public.approval_policies WHERE workspace_id IN (
        SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()
        UNION
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
      )
    )
  );

CREATE POLICY "admins write steps via policy"
  ON public.approval_chain_steps FOR ALL
  USING (
    policy_id IN (
      SELECT id FROM public.approval_policies WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
      )
    )
  )
  WITH CHECK (
    policy_id IN (
      SELECT id FROM public.approval_policies WHERE workspace_id IN (
        SELECT id FROM public.workspaces WHERE owner_id = auth.uid()
        UNION
        SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
      )
    )
  );
```

### Add `signator` to existing functional roles

The current `workspace_roles.role` check constraint allows `submitter`, `manager_approver`, `financial_approver`, `admin`. Extend:

```sql
ALTER TABLE public.workspace_roles
  DROP CONSTRAINT IF EXISTS workspace_roles_role_check;

ALTER TABLE public.workspace_roles
  ADD CONSTRAINT workspace_roles_role_check
  CHECK (role IN ('submitter', 'manager_approver', 'financial_approver', 'signator', 'admin'));
```

---

## Frontend — Policy Editor UI

### Routing

Add a new route: `/app/settings/approval-policies` (admin-only — gate via existing admin role check).

### Pages

**`ApprovalPoliciesListPage.tsx`**

Lists all policies for the current workspace. Columns:
- Name
- Priority
- Matching summary (chips: asset types, departments, cost range, regions)
- Default fallback indicator
- Active/inactive toggle
- Last updated
- Actions (Edit, Duplicate, Archive)

Top-right buttons: "New Policy" and "Test Resolution" (the preview tool).

The list is sorted by priority descending so admins see resolution order at a glance.

A banner at the top: "Workspace separation of duties: ON — admins must use distinct users in each chain. [Change setting]" with a small toggle drawer for the workspace default.

**`ApprovalPolicyEditPage.tsx`**

Form for creating or editing a single policy. Sections:

*Identity*
- Name (required, text)
- Description (text area, optional)
- Priority (integer, default 100, with helper text: "Higher number wins when multiple policies match.")
- Active toggle
- "Use as default fallback" toggle (with validation: only one allowed per workspace)

*Matching criteria*

Each criterion is optional. Empty = matches anything.
- Asset types (multi-select chips: Real Estate, Equipment, Vehicle, Other)
- Departments (multi-select; pulled from a workspace department list — may need a small `workspace_departments` table later, but for Phase 1 use a free-text array of strings)
- Annual cost range (two numeric fields: min and max, either or both optional)
- Regions (multi-select chips, free-text for now)
- Lease types (multi-select; same source as `lease_type` enum)

Helper text: "A policy matches a request when ALL filled-in criteria are satisfied. Empty criteria match any value."

*Separation of duties*
- Radio: "Inherit workspace default (currently: ON)" / "Allow same user in multiple roles" / "Require distinct users"

*Concept approval chain*
- A list editor (drag-to-reorder).
- Each row is a step. Step has: Step number (auto), Parallel group (default 1), Approver type (specific user OR functional role), Approver assignment (user picker or role picker), Delegate (optional user picker), Delegate after N days (optional integer), Required (boolean).
- "Add concept step" button.
- Helper text: "Steps with the same parallel group number act in parallel. Different group numbers act sequentially."

*Signator approval chain*
- Same editor, separate section.
- Typically one step but the schema supports multiples for organizations with multi-signator requirements.

*Save / Cancel*

On save:
- Validate: at least one concept step. At least one signator step. No duplicate step numbers within a parallel group. Cost range valid (min <= max).
- Validate against effective separation of duties: if "require distinct users" is in effect, no user appears in more than one step.
- POST to Supabase via supabase-js client. Insert/update the policy and replace its chain steps (delete-and-reinsert pattern in a transaction via RPC, or use the new `apply_policy_steps` RPC defined below).

**`ApprovalPolicyTestDialog.tsx`**

Modal opened from the list page's "Test Resolution" button. Form:
- Asset type (single select)
- Department (text)
- Estimated annual cost (numeric)
- Region (text)
- Lease type (single select)

Below the form, a results panel:
- Matching policy name (or "No policy matched" with explanation)
- Why this policy won (priority + matched criteria)
- Resolved chain visualization: each step rendered as a card showing stage, step order, parallel group, approver name (resolved from user_id or role lookup)
- Separation-of-duties status: pass/fail with explanation
- Warnings: any deactivated assignees, ambiguous matches, missing fallback

The dialog calls a Supabase RPC `preview_policy_resolution` (defined below) — this RPC is read-only and does NOT write to `lease_approval_chain` (which doesn't exist yet anyway).

### Supporting RPC functions

In the same migration file:

```sql
-- Read-only resolution preview. Returns the matching policy and resolved chain
-- as a JSON structure for the test dialog. Does NOT write any state.
CREATE OR REPLACE FUNCTION public.preview_policy_resolution(
  p_workspace_id uuid,
  p_asset_type text,
  p_department text,
  p_annual_cost numeric,
  p_region text,
  p_lease_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy public.approval_policies;
  v_chain jsonb;
  v_warnings text[] := ARRAY[]::text[];
BEGIN
  -- Find matching policies, sorted by priority descending
  SELECT * INTO v_policy
  FROM public.approval_policies p
  WHERE p.workspace_id = p_workspace_id
    AND p.is_active = true
    AND (cardinality(p.match_asset_types) = 0 OR p_asset_type = ANY(p.match_asset_types))
    AND (cardinality(p.match_departments) = 0 OR p_department = ANY(p.match_departments))
    AND (p.match_min_annual_cost IS NULL OR p_annual_cost >= p.match_min_annual_cost)
    AND (p.match_max_annual_cost IS NULL OR p_annual_cost <= p.match_max_annual_cost)
    AND (cardinality(p.match_regions) = 0 OR p_region = ANY(p.match_regions))
    AND (cardinality(p.match_lease_types) = 0 OR p_lease_type = ANY(p.match_lease_types))
  ORDER BY p.priority DESC, p.created_at ASC
  LIMIT 1;

  -- Fall back to default policy if none matched
  IF v_policy.id IS NULL THEN
    SELECT * INTO v_policy
    FROM public.approval_policies p
    WHERE p.workspace_id = p_workspace_id
      AND p.is_active = true
      AND p.is_default_fallback = true
    LIMIT 1;

    IF v_policy.id IS NULL THEN
      RETURN jsonb_build_object(
        'matched', false,
        'error', 'No matching policy and no default fallback configured.'
      );
    END IF;

    v_warnings := array_append(v_warnings, 'No specific match; using default fallback policy.');
  END IF;

  -- Build resolved chain
  SELECT jsonb_agg(
    jsonb_build_object(
      'stage', s.stage,
      'step_order', s.step_order,
      'parallel_group', s.parallel_group,
      'approver_user_id', s.approver_user_id,
      'approver_role', s.approver_role,
      'delegate_user_id', s.delegate_user_id,
      'is_required', s.is_required
    )
    ORDER BY s.stage, s.step_order, s.parallel_group
  ) INTO v_chain
  FROM public.approval_chain_steps s
  WHERE s.policy_id = v_policy.id;

  RETURN jsonb_build_object(
    'matched', true,
    'policy_id', v_policy.id,
    'policy_name', v_policy.name,
    'policy_priority', v_policy.priority,
    'policy_version', v_policy.version,
    'separation_override', v_policy.separation_of_duties_override,
    'chain', COALESCE(v_chain, '[]'::jsonb),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_policy_resolution TO authenticated;
```

```sql
-- Atomic upsert of a policy's chain steps. Replaces all existing steps for a policy.
-- Caller is the admin UI editor on save.
CREATE OR REPLACE FUNCTION public.apply_policy_steps(
  p_policy_id uuid,
  p_steps jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Auth check: caller must be admin/owner of the policy's workspace
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.id = p_policy_id
      AND (
        p.workspace_id IN (SELECT id FROM public.workspaces WHERE owner_id = auth.uid())
        OR p.workspace_id IN (
          SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  DELETE FROM public.approval_chain_steps WHERE policy_id = p_policy_id;

  INSERT INTO public.approval_chain_steps (
    policy_id, stage, step_order, parallel_group,
    approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required
  )
  SELECT
    p_policy_id,
    (s->>'stage')::text,
    (s->>'step_order')::integer,
    COALESCE((s->>'parallel_group')::integer, 1),
    NULLIF(s->>'approver_user_id', '')::uuid,
    NULLIF(s->>'approver_role', ''),
    NULLIF(s->>'delegate_user_id', '')::uuid,
    NULLIF(s->>'delegate_after_days', '')::integer,
    COALESCE((s->>'is_required')::boolean, true)
  FROM jsonb_array_elements(p_steps) AS s;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_policy_steps TO authenticated;
```

---

## Validation rules to enforce in the UI

These are client-side validations before the save call:

1. Name is required and non-empty.
2. Priority is a positive integer.
3. If both min and max annual cost are set, min ≤ max.
4. At least one chain step in the `concept` stage.
5. At least one chain step in the `signator` stage.
6. Within each stage, step orders are positive integers and unique within their parallel group.
7. Each step has exactly one of `approver_user_id` or `approver_role` set.
8. If delegate_user_id is set, delegate_after_days must also be set.
9. Effective separation of duties (workspace default with policy override applied):
   - If "require distinct users," no `approver_user_id` appears more than once across all steps in the policy.
10. If `is_default_fallback` is being set to true, no other active policy in the workspace currently has it true (the unique index will catch this server-side, but check client-side for friendlier UX).

Server-side, these are reinforced by the constraints and indexes in the migration.

---

## Tests to add in this phase

Unit / integration tests in the existing test framework:

- Migration applies cleanly on a fresh database.
- Migration is idempotent (applies twice without error).
- Inserting two `is_default_fallback = true` policies in the same workspace fails.
- Deactivating one default and activating another succeeds.
- Constraint: cost min > max rejects.
- Constraint: step with both user_id and role rejects.
- Constraint: step with neither user_id nor role rejects.
- RPC `preview_policy_resolution`:
  - Returns no-match when no policies exist
  - Returns default fallback when no specific match
  - Returns highest-priority match when multiple match
  - Returns resolved chain in correct order
- RPC `apply_policy_steps`:
  - Replaces all steps atomically
  - Rejects unauthorized callers
- RLS: non-admin workspace member can read but not write policies.
- RLS: admin can write policies.
- RLS: user from different workspace cannot read or write.

Frontend tests for the editor:

- Save with no concept step → blocked.
- Save with no signator step → blocked.
- Save with same user in two steps when separation enforced → blocked.
- Save with same user in two steps when separation allowed → succeeds.
- Test dialog with no matching criteria → returns default fallback.
- Test dialog with criteria that match → returns correct chain.

---

## Out of scope for Phase 1 — explicit list

Do NOT build any of these in Phase 1. They are owned by later phases:

- The `lease_approval_chain` table.
- Any change to `lease_request` submission flow.
- Any change to existing approval notifications (the legacy parallel manager_approver / financial_approver flow stays intact).
- Lifecycle status changes.
- The `lease_documents` table.
- Rerouting logic.
- Delegation activation (the columns exist, but nothing acts on them yet).
- Override flow.

Phase 1 ends when an admin can fully configure policies and verify them via the test dialog, but no actual lease submission has been changed.

---

## Definition of done for Phase 1

1. Migration applied cleanly to staging database.
2. All tests above pass.
3. Admin user can navigate to `/app/settings/approval-policies`, see a list, create a new policy with full chain configuration, save it, and reopen it without data loss.
4. Test dialog returns correct results for at least three sample scenarios documented in the test plan (low-dollar match, high-dollar match, no match → fallback).
5. Non-admin user cannot access the page (route guard works).
6. Workspace separation-of-duties default toggle works and persists.
7. The CLAUDE.md at the repo root has been updated to reference this architecture document and Phase 1 spec.

---

## Notes for Claude Code

- Reuse existing patterns: the `lease_change_governance` and `phase2_approval_roles` migrations are good references for RLS and structure.
- Reuse `set_updated_at()` — don't redefine it.
- Match the existing UI conventions: shadcn/ui components, `@/components/ui/*` imports, Tailwind utility classes only, lucide-react icons.
- The list and edit pages should mirror the structure of existing settings pages (look at how workspace settings or members are managed for consistent UX).
- Do not invent new dependency packages. Stick to what is already in `package.json`.
- All Supabase types should be regenerated after the migration so `src/integrations/supabase/types.ts` is current.
- Do not modify any existing edge function or `LeaseReview.tsx` workflow logic — Phase 1 is additive only.

---

## Repo-specific deltas (resolved before coding)

This section captures substitutions where the spec doesn't quite match the live codebase. They were verified during planning. Spec wins where it matches; substitutions below apply elsewhere.

| Spec assumption | Repo reality | Resolution |
|---|---|---|
| `set_updated_at()` exists | ✓ defined in `supabase/migrations/20260426000000_lease_change_governance.sql` | Use it. Don't redefine. |
| `workspace_roles` is a separate table from `workspace_members` | ✓ confirmed; created in `supabase/migrations/20260221130000_phase2_approval_roles.sql` | Extend its CHECK constraint as written above. Do not touch `workspace_members.role` — that's the membership tier (admin/editor/viewer), a different concept. |
| Asset type values "Real Estate, Equipment, Vehicle, Other" | `leases.asset_type` check is `('equipment','vehicle','property','other')` — lowercase, no "real estate" | Multi-select stores raw DB enum values. Display labels are friendly text. The matcher RPC compares `p_asset_type = ANY(p.match_asset_types)`, so case must match — caller passes the raw DB enum value, not the display label. |
| Lease type values | `leases.lease_type` check is `('Real Estate','Equipment')` — mixed case | Multi-select stores raw mixed-case DB values. |
| Annual-cost matching field | Repo has `monthly_payment` (NUMERIC) and `calc_total_commitment` (NUMERIC, total over term) | Compute annual cost in the **caller** as `monthly_payment * 12` and pass that as `p_annual_cost` to the preview RPC. Don't infer it server-side from `calc_total_commitment` (that's term-total, not annual). |
| RPC GRANT pattern | Spec only does `GRANT EXECUTE … TO authenticated` | Add `REVOKE EXECUTE … FROM PUBLIC;` first on both RPCs to harden against accidental exposure. |
| Drag-to-reorder for chain steps | No drag-reorder library in deps; no precedent in repo | Use up/down arrow buttons + numeric `step_order` field. Do not add `@dnd-kit/sortable` or similar dep in Phase 1. Schema is unaffected; only the UX changes. |
| Multi-select chip control | No chip-multiselect component exists | Reuse the manual add/remove pattern from `src/pages/settings/WorkspaceSettings.tsx:1031-1069` (Input + Button + render-as-boxes with X). Departments and regions: free-text input. Asset types and lease types: a small grid of toggleable checkboxes (since the value space is fixed and tiny). |
| Sidebar exposure of new page | Settings sub-routes are not auto-discovered by `AppSidebar` | Add an "Approval Policies" tab inside `WorkspaceSettings.tsx` that links to `/app/settings/approval-policies`. Tab is rendered only when `isAdmin`. Don't add a top-level sidebar link. |
| RLS scoping | Inline EXISTS subqueries in spec | Spec subqueries are fine and explicit — keep them as written. (Helper fns `is_workspace_member` / `is_workspace_owner` exist for future reuse.) |
