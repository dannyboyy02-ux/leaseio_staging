# Phase 9 Build Spec — Firm Layer Foundation

**Prerequisite reading:** All prior phase build specs (1 through 8), `APPROVAL_ROUTING_ARCHITECTURE.md`, `docs/PRODUCT_STRATEGY.md` (especially the firm layer architecture sketch), `docs/CLAUDE.md`
**Phase scope:** Build the firm entity, firm membership, firm-aware RLS helper, firm-level Stripe billing with per-child usage visibility, and the data foundation for Business tier. No firm UX yet — that's Phase 10.
**Out of scope for Phase 9:** Cross-workspace inbox UI, firm dashboard, child workspace management UI (Phase 10), firm-level reports rolling up multiple child workspaces (Phase 11+), white-label branding, multi-firm membership for a single user, automatic firm-tier upgrades from Pro.

> **As-built (2026-06-15) — foundation landed on branch `claude/phase9-firm-foundation` (PR #49, CI green); not yet merged to main.** Shipped: migration `supabase/migrations/20260615172439_phase9_firm_layer_foundation.sql` (applied to staging + isolation-matrix-verified), the 4 service-role edge functions (deployed), Node⇄Deno firm-access helpers, the stripe-webhook firm branch (`applyFirmSubscription` — coded, **not yet deployed**; inert until firm subs exist), and the minimal frontend (firm-bound Billing banner + firm-grouped workspace selector). **Deviations / decisions taken during build:** (1) Goals 3 & 6 say firm_member maps in via RLS and plan locks to `business` — implemented, plus an **owner-only-mints-admins** split-RLS refinement (admins can only add `firm_member`; the firm owner adds `firm_admin`) hardened in security review. (2) The two views are `security_invoker=true` (the spec's raw `CREATE VIEW` would have been security-definer and leaked cross-tenant). (3) `firm_activity_log` FK is **ON DELETE RESTRICT** (not CASCADE) and firm-delete is blocked until all children are released — chosen in security review to never destroy the audit trail. (4) Goal 8 says a released workspace returns to "standalone Pro tier" — as-built it stays `business` (we build on the existing `business` tier; plan stays `business` on release, no Pro tier exists). (5) Firm-binding events write to `firm_activity_log` with `workspace_id` in `details` (the per-lease `lease_activity_log` requires a non-null `lease_id`, so it can't hold workspace-only firm events). **Deferred follow-ons:** deploy the webhook firm branch; `set-firm-access` + `delete-firm` edge fns; firm edge-fn raw-error-message leak (KNOWN_ISSUES #102). **Leo firm-portfolio mode is a sequenced follow-on, NOT in Phase 9** (owner-gated on `firms.owner_id`, metered, feature-flagged — see CLAUDE.md hard rule #8).

After Phase 8, the product is sellable for Plus and Pro tiers. Phase 9 builds the architectural foundation for Business tier — the parent/firm entity that owns multiple child workspaces, with strong data isolation between children but unified administration and billing for the parent.

This phase intentionally ships **no user-facing firm UX**. The firm layer becomes operationally functional — firms can be created via admin tools, firm memberships work, billing routes correctly, RLS picks up the firm relationship — but the customer doesn't yet have a "firm dashboard" or "cross-workspace inbox" to look at. Those land in Phase 10.

The reason to split: Phase 9's data and permissions changes affect every workspace-scoped query in the codebase. Shipping the schema and RLS changes first, in isolation, lets us verify nothing regressed before we layer UX on top. If Phase 9 has a subtle RLS bug, it will surface before Phase 10's UX makes the bug worse.

---

## Goals of this phase

1. A new `firms` entity exists with the columns from `docs/PRODUCT_STRATEGY.md`. Firm-level Stripe billing tracks subscription independently from workspace-level billing.
2. Workspace can optionally belong to a firm. The relationship is one-way: a workspace has at most one firm; a firm has many workspaces.
3. Firm members exist with two roles (`firm_admin`, `firm_member`) and gain access to all child workspaces of their firm via the existing RLS helpers (which Phase 9 extends to be firm-aware).
4. Per-workspace `restrict_firm_access` flag exists for cases where a child workspace doesn't want firm-level visibility (subsidiary protecting M&A leases from the parent, for example).
5. Per-child usage tracking is captured at the firm level — lease counts, document storage, report generation counts per child workspace, exposed via a `v_firm_child_usage` view that the future billing UI will consume.
6. Firm Stripe webhooks route correctly: a Stripe subscription on a firm propagates the `business` plan to all its child workspaces, and child workspaces cannot independently change plan while bound to a firm.
7. RLS migration is comprehensive — every table that uses `is_workspace_member` automatically picks up firm membership without that table's policies needing to change.
8. The lifecycle of a firm-bound workspace is preserved when the firm-workspace relationship is severed (workspace can be released back to standalone Pro tier without data loss).

---

## Database migrations

Create one migration file: `<timestamp>_phase9_firm_layer_foundation.sql`.

### `firms` table

```sql
CREATE TABLE public.firms (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                            text NOT NULL,
  firm_type                       text NOT NULL CHECK (firm_type IN ('cpa_firm', 'parent_company', 'other')),
  owner_id                        uuid NOT NULL REFERENCES auth.users(id),
  plan                            text NOT NULL DEFAULT 'business' CHECK (plan = 'business'),
  stripe_customer_id              text,
  stripe_subscription_id          text,
  child_workspace_limit           integer NOT NULL DEFAULT 50 CHECK (child_workspace_limit >= 1),
  child_workspaces_used           integer NOT NULL DEFAULT 0,
  billing_email                   text NOT NULL,
  billing_summary_mode            text NOT NULL DEFAULT 'detailed'
    CHECK (billing_summary_mode IN ('detailed', 'summarized')),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT firms_name_length CHECK (length(trim(name)) >= 2)
);

CREATE INDEX idx_firms_owner ON public.firms(owner_id);
CREATE INDEX idx_firms_stripe_customer ON public.firms(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE TRIGGER firms_updated_at
  BEFORE UPDATE ON public.firms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
```

Notes on schema:

- `firm_type` drives terminology in the UI (CPA firm sees "clients," parent company sees "subsidiaries"). Phase 10 owns the UI. Phase 9 just records the value.
- `plan` is hardcoded to `'business'`. Firms always have Business tier; there's no Plus or Pro firm. If you eventually want firm-tier sub-tiers (Business vs. Business Pro), this constraint relaxes.
- `child_workspace_limit` defaults to 50, configurable per firm. Enforced by trigger when adding a workspace to a firm (see below).
- `billing_summary_mode` is the per-firm preference for whether the Stripe invoice details usage per child or aggregates. This was your explicit decision — both modes supported, admin picks.
- `child_workspaces_used` is denormalized for efficient quota checks; maintained by triggers when workspaces join/leave firms.

### `firm_members` table

```sql
CREATE TABLE public.firm_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id             uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('firm_admin', 'firm_member')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES auth.users(id),
  UNIQUE (firm_id, user_id)
);

CREATE INDEX idx_firm_members_user ON public.firm_members(user_id);
CREATE INDEX idx_firm_members_firm ON public.firm_members(firm_id);
```

The owner of a firm is automatically considered a firm_admin via the `is_firm_member` helper (below) — no need to insert a duplicate row, same pattern as workspace ownership vs. workspace_members.

### Workspace table additions

```sql
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS firm_id                  uuid REFERENCES public.firms(id),
  ADD COLUMN IF NOT EXISTS firm_child_label         text,
  ADD COLUMN IF NOT EXISTS restrict_firm_access     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS firm_joined_at           timestamptz;

CREATE INDEX idx_workspaces_firm_id ON public.workspaces(firm_id) WHERE firm_id IS NOT NULL;
```

- `firm_id` nullable: a workspace either belongs to a firm or stands alone.
- `firm_child_label` is the display name within the firm context (e.g., "Acme Manufacturing — Plant 4" while the workspace itself is "Plant 4 Operations"). Optional; defaults to workspace name in Phase 10 UI.
- `restrict_firm_access` opt-in flag for the subsidiary-protecting-confidential-data case. When true, firm members do NOT get implicit access via firm membership; they must be explicitly added as workspace members.
- `firm_joined_at` audit column.

### Trigger to maintain `child_workspaces_used` counter and quota enforcement

```sql
CREATE OR REPLACE FUNCTION public.maintain_firm_child_workspace_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer;
  v_used integer;
BEGIN
  -- Workspace joining a firm
  IF (TG_OP = 'INSERT' AND NEW.firm_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.firm_id IS NOT NULL AND OLD.firm_id IS DISTINCT FROM NEW.firm_id) THEN
    SELECT child_workspace_limit, child_workspaces_used INTO v_limit, v_used
      FROM public.firms WHERE id = NEW.firm_id FOR UPDATE;

    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Firm has reached its child workspace limit of %. Increase the limit or remove an existing child first.', v_limit;
    END IF;

    UPDATE public.firms
       SET child_workspaces_used = v_used + 1,
           updated_at = now()
     WHERE id = NEW.firm_id;

    NEW.firm_joined_at = now();
  END IF;

  -- Workspace leaving a firm
  IF (TG_OP = 'UPDATE' AND OLD.firm_id IS NOT NULL AND NEW.firm_id IS NULL) THEN
    UPDATE public.firms
       SET child_workspaces_used = GREATEST(0, child_workspaces_used - 1),
           updated_at = now()
     WHERE id = OLD.firm_id;
  END IF;

  -- Workspace moving between firms (rare but possible)
  IF (TG_OP = 'UPDATE' AND OLD.firm_id IS NOT NULL AND NEW.firm_id IS NOT NULL AND OLD.firm_id <> NEW.firm_id) THEN
    UPDATE public.firms
       SET child_workspaces_used = GREATEST(0, child_workspaces_used - 1),
           updated_at = now()
     WHERE id = OLD.firm_id;

    SELECT child_workspace_limit, child_workspaces_used INTO v_limit, v_used
      FROM public.firms WHERE id = NEW.firm_id FOR UPDATE;

    IF v_used >= v_limit THEN
      RAISE EXCEPTION 'Destination firm has reached its child workspace limit.';
    END IF;

    UPDATE public.firms
       SET child_workspaces_used = v_used + 1,
           updated_at = now()
     WHERE id = NEW.firm_id;

    NEW.firm_joined_at = now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_firm_counter
  BEFORE INSERT OR UPDATE OF firm_id ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.maintain_firm_child_workspace_counter();
```

This trigger enforces the quota at the database level — no application-side bypass possible.

### Trigger to lock plan when bound to a firm

```sql
CREATE OR REPLACE FUNCTION public.prevent_independent_plan_change_for_firm_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.firm_id IS NOT NULL AND OLD.plan IS DISTINCT FROM NEW.plan AND NEW.plan <> 'business' THEN
    RAISE EXCEPTION 'Workspace plan cannot be changed independently while bound to a firm. The firm''s plan governs all child workspaces.';
  END IF;

  -- When a workspace joins a firm, force its plan to 'business'
  IF NEW.firm_id IS NOT NULL AND OLD.firm_id IS DISTINCT FROM NEW.firm_id THEN
    NEW.plan = 'business';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_plan_firm_lock
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.prevent_independent_plan_change_for_firm_workspace();
```

### `is_firm_member` helper

```sql
CREATE OR REPLACE FUNCTION public.is_firm_member(_firm_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.firm_members
    WHERE firm_id = _firm_id
      AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.firms
    WHERE id = _firm_id
      AND owner_id = _user_id
  )
$$;
```

### `is_firm_admin` helper

```sql
CREATE OR REPLACE FUNCTION public.is_firm_admin(_firm_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.firm_members
    WHERE firm_id = _firm_id
      AND user_id = _user_id
      AND role = 'firm_admin'
  ) OR EXISTS (
    SELECT 1
    FROM public.firms
    WHERE id = _firm_id
      AND owner_id = _user_id
  )
$$;
```

### Updated `is_workspace_member` helper — the most consequential change in the migration

```sql
CREATE OR REPLACE FUNCTION public.is_workspace_member(_workspace_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Direct workspace membership (Plus/Pro semantics — unchanged)
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = _workspace_id
      AND user_id = _user_id
  )
  -- Workspace owner (Plus/Pro semantics — unchanged)
  OR EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
  -- Firm membership grants implicit workspace membership UNLESS the workspace
  -- has restrict_firm_access = true (subsidiary opting out of firm visibility)
  OR EXISTS (
    SELECT 1
    FROM public.workspaces w
    WHERE w.id = _workspace_id
      AND w.firm_id IS NOT NULL
      AND w.restrict_firm_access = false
      AND public.is_firm_member(w.firm_id, _user_id)
  )
$$;
```

This is the change that makes every existing RLS policy automatically firm-aware. Every policy that uses `is_workspace_member(workspace_id, auth.uid())` now grants access to firm members of the workspace's parent firm, subject to the `restrict_firm_access` opt-out.

The `is_workspace_owner` helper does NOT change. Owner is owner; firm membership doesn't make someone the workspace owner. This preserves the structural meaning of ownership (billing, deletion, transfer) while letting firm membership grant operational access.

### Per-child usage view

```sql
CREATE OR REPLACE VIEW public.v_firm_child_usage AS
SELECT
  w.firm_id,
  w.id AS workspace_id,
  w.name AS workspace_name,
  w.firm_child_label,
  w.firm_joined_at,
  w.restrict_firm_access,
  -- Lease counts
  (SELECT count(*) FROM public.leases l WHERE l.workspace_id = w.id) AS total_leases,
  (SELECT count(*) FROM public.leases l WHERE l.workspace_id = w.id AND l.lifecycle_status = 'active') AS active_leases,
  (SELECT count(*) FROM public.leases l WHERE l.workspace_id = w.id AND l.model_locked = true) AS finalized_leases,
  -- Document storage
  (SELECT count(*) FROM public.lease_documents ld WHERE ld.workspace_id = w.id) AS total_documents,
  (SELECT COALESCE(SUM(file_size_bytes), 0) FROM public.lease_documents ld WHERE ld.workspace_id = w.id) AS total_document_bytes,
  -- Report generation
  (SELECT count(*) FROM public.lease_reports lr WHERE lr.workspace_id = w.id) AS reports_generated_total,
  (SELECT count(*) FROM public.lease_reports lr WHERE lr.workspace_id = w.id AND lr.generated_at >= now() - INTERVAL '30 days') AS reports_generated_last_30_days,
  -- Member counts
  (SELECT count(*) FROM public.workspace_members wm WHERE wm.workspace_id = w.id) AS direct_members,
  -- Updated tracking
  w.updated_at AS workspace_updated_at
FROM public.workspaces w
WHERE w.firm_id IS NOT NULL;
```

This view is the single source of truth for firm-level visibility into child usage. The future Phase 10 UI consumes it for the firm dashboard. The Phase 9 Stripe webhook consumes it for usage-based billing calculation.

### `firm_billing_period_summary` view

Aggregates per-billing-cycle for invoice generation:

```sql
CREATE OR REPLACE VIEW public.v_firm_billing_period_summary AS
SELECT
  f.id AS firm_id,
  f.name AS firm_name,
  f.billing_summary_mode,
  date_trunc('month', now()) AS period_start,
  (date_trunc('month', now()) + INTERVAL '1 month - 1 day')::date AS period_end,
  count(DISTINCT w.id) AS active_child_workspaces,
  COALESCE(SUM(child.active_leases), 0) AS aggregate_active_leases,
  COALESCE(SUM(child.total_document_bytes), 0) AS aggregate_document_bytes,
  COALESCE(SUM(child.reports_generated_last_30_days), 0) AS aggregate_reports_30d
FROM public.firms f
LEFT JOIN public.workspaces w ON w.firm_id = f.id
LEFT JOIN public.v_firm_child_usage child ON child.workspace_id = w.id
GROUP BY f.id, f.name, f.billing_summary_mode;
```

### RLS for `firms` and `firm_members`

```sql
ALTER TABLE public.firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_members ENABLE ROW LEVEL SECURITY;

-- Firm members and owners can read their firm
CREATE POLICY "firm members read firm"
  ON public.firms FOR SELECT
  USING (public.is_firm_member(id, auth.uid()));

-- Only firm owner can update firm metadata
CREATE POLICY "firm owner updates firm"
  ON public.firms FOR UPDATE
  USING (owner_id = auth.uid());

-- Only firm owner can delete firm (and even then, the operation cascades to child workspace unbinding)
CREATE POLICY "firm owner deletes firm"
  ON public.firms FOR DELETE
  USING (owner_id = auth.uid());

-- Firm members read membership rows
CREATE POLICY "firm members read membership"
  ON public.firm_members FOR SELECT
  USING (public.is_firm_member(firm_id, auth.uid()));

-- Firm admins manage membership
CREATE POLICY "firm admins manage membership"
  ON public.firm_members FOR ALL
  USING (public.is_firm_admin(firm_id, auth.uid()))
  WITH CHECK (public.is_firm_admin(firm_id, auth.uid()));
```

### Activity log additions

```sql
ALTER TABLE public.lease_activity_log
  DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check;

ALTER TABLE public.lease_activity_log
  ADD CONSTRAINT lease_activity_log_activity_type_check
  CHECK (activity_type IN (
    -- All prior values preserved (Legacy + Phases 2-8) ...
    -- Phase 9 additions
    'firm_created',
    'firm_member_added',
    'firm_member_removed',
    'firm_member_role_changed',
    'workspace_joined_firm',
    'workspace_left_firm',
    'workspace_firm_access_restricted',
    'workspace_firm_access_unrestricted',
    'firm_billing_subscription_started',
    'firm_billing_subscription_updated',
    'firm_billing_subscription_canceled'
  ));
```

These activity types are written either to `lease_activity_log` (when the action affects a lease, e.g., a workspace joining a firm changes the access pattern for its leases) or to a parallel `firm_activity_log` table.

For Phase 9 simplicity, reuse `lease_activity_log` for events that touch leases, and add a separate `firm_activity_log` for events that don't:

```sql
CREATE TABLE public.firm_activity_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id),
  activity_type   text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_firm_activity_log_firm_chronological
  ON public.firm_activity_log(firm_id, created_at DESC);

ALTER TABLE public.firm_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "firm members read firm activity"
  ON public.firm_activity_log FOR SELECT
  USING (public.is_firm_member(firm_id, auth.uid()));
```

---

## Code changes

### Pure helpers — `src/lib/firmAccess.ts` (new file)

```typescript
// Stay in sync with supabase/functions/_shared/firm_access.ts.

export type FirmRole = 'firm_admin' | 'firm_member';
export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export type EffectiveAccess = {
  hasAccess: boolean;
  source: 'direct_workspace_member' | 'workspace_owner' | 'firm_member' | 'none';
  effective_workspace_role: WorkspaceRole | 'owner' | null;
};

// Determines the effective access a user has to a workspace, accounting for
// direct membership, workspace ownership, and firm membership.
//
// The firm-derived role mapping is documented in PRODUCT_STRATEGY.md:
//   firm_admin → effective 'admin' in every child workspace
//   firm_member → effective 'editor' in every child workspace
// Direct workspace membership (when present) overrides firm-derived access —
// e.g., a firm_admin who is explicitly added to a child workspace as 'viewer'
// is 'viewer' in that workspace.
export function resolveEffectiveAccess(
  userId: string,
  workspace: {
    id: string;
    owner_id: string;
    firm_id: string | null;
    restrict_firm_access: boolean;
  },
  directMembership: { user_id: string; role: WorkspaceRole } | null,
  firmMembership: { user_id: string; role: FirmRole } | null,
): EffectiveAccess {
  // Direct workspace membership wins over everything except ownership
  if (workspace.owner_id === userId) {
    return { hasAccess: true, source: 'workspace_owner', effective_workspace_role: 'owner' };
  }

  if (directMembership && directMembership.user_id === userId) {
    return {
      hasAccess: true,
      source: 'direct_workspace_member',
      effective_workspace_role: directMembership.role,
    };
  }

  // Firm membership grants implicit access UNLESS workspace opted out
  if (workspace.firm_id && !workspace.restrict_firm_access && firmMembership && firmMembership.user_id === userId) {
    return {
      hasAccess: true,
      source: 'firm_member',
      effective_workspace_role: firmMembership.role === 'firm_admin' ? 'admin' : 'editor',
    };
  }

  return { hasAccess: false, source: 'none', effective_workspace_role: null };
}

// Returns true if the user has at least the given workspace role's authority,
// considering direct + firm-derived access. Used by tab gates, button guards,
// and route gates.
export function hasWorkspaceAuthority(
  effective: EffectiveAccess,
  required: WorkspaceRole | 'owner',
): boolean {
  if (!effective.hasAccess || !effective.effective_workspace_role) return false;

  const hierarchy: Record<string, number> = {
    viewer: 1,
    editor: 2,
    admin: 3,
    owner: 4,
  };

  return (hierarchy[effective.effective_workspace_role] ?? 0) >= (hierarchy[required] ?? 0);
}
```

The Deno mirror at `supabase/functions/_shared/firm_access.ts` carries identical pure logic.

### New edge function: `create-firm`

Allows the service-role-acting backend (or eventually a self-serve admin path) to create a firm.

1. Validates inputs (name, firm_type, billing_email).
2. Inserts the `firms` row.
3. Inserts `firm_activity_log` entry: `firm_created`.
4. Stripe customer creation handled separately by the existing Stripe webhook layer; Phase 9 just records the firm and waits for the Stripe customer ID via webhook.

For Phase 9, this edge function is callable by service role only. Self-serve firm creation (admins creating firms via UI) is Phase 10. Phase 9 supports manual firm provisioning for the first set of beta customers.

### New edge function: `add-firm-member`

1. Verifies the actor is a firm_admin of the target firm.
2. Validates the user being added (must exist in auth.users).
3. Inserts `firm_members` row.
4. Inserts `firm_activity_log` entry.
5. Notifies the new member (in-app notification + email) — they now have access to all child workspaces of the firm.

### New edge function: `bind-workspace-to-firm`

1. Verifies the actor owns both the workspace and the target firm (or is the firm_admin and the workspace owner has authorized the binding via a separate consent flow — Phase 9 ships with owner-of-both-required as the simpler version).
2. Verifies the workspace is not already in a firm.
3. Updates `workspaces.firm_id`. The trigger handles the counter and plan change.
4. Inserts `workspace_joined_firm` activity log entry on the lease activity log if the workspace has any leases (so workspace-scoped audit trails remain complete).
5. Inserts `firm_activity_log` entry.

### New edge function: `release-workspace-from-firm`

1. Verifies the actor is the firm owner OR the workspace owner.
2. Updates `workspaces.firm_id = NULL`. Trigger decrements counter.
3. Workspace's plan reverts to its prior value (Phase 9 records the prior plan in a temporary column or the firm_joined_at audit can be used to restore — see implementation note below).
4. Activity log entries.

**Implementation note:** the workspace's plan was forced to `'business'` on join. On release, what plan does it revert to? Phase 9 ships with the simpler answer: the workspace stays at `'business'` (paid by the workspace owner now via independent subscription) until the workspace owner explicitly downgrades. The release operation does NOT change the workspace plan; it just removes the firm binding. The workspace owner is then responsible for either continuing at `'business'` (independent Stripe subscription) or downgrading to Plus/Pro via the existing flow. This simplifies the logic and preserves data; the Stripe billing change happens via the existing self-service downgrade path.

### Stripe webhook updates

The existing `stripe-webhook` edge function gets a new branch: when the `customer` on the subscription event maps to a firm's `stripe_customer_id`, route to firm logic instead of workspace logic.

Firm-tier subscription events:
- `customer.subscription.created` → set firm.stripe_subscription_id, firm.plan = 'business' (already default), propagate plan to all child workspaces.
- `customer.subscription.updated` → update tier-related fields; if the subscription is paused/incomplete, the firm enters a grace state (Phase 9 records this; UI surfaces in Phase 10).
- `customer.subscription.deleted` → firm enters cancellation flow. Children remain `'business'` plan for a 30-day grace period; after grace expires, children must be released or upgraded individually. Phase 9 records the cancellation; the grace-period cleanup is Phase 11+.

The webhook also generates the per-period billing report based on `billing_summary_mode`:
- `'detailed'`: usage breakdown per child workspace included in invoice line items
- `'summarized'`: single aggregate line for the firm

Stripe invoice line item creation is handled via Stripe's API (existing pattern); the choice between detailed and summarized happens at line-item construction time.

### TypeScript type regeneration

After migration, regenerate `src/integrations/supabase/types.ts` so `firms`, `firm_members`, `firm_activity_log`, and the new workspace columns are typed.

### Frontend — minimal Phase 9 UI

Phase 9 ships with no firm UX. But two small UI changes are needed for the existing surfaces to handle firm-bound workspaces correctly:

1. **Workspace selector in the sidebar** — when a user is a firm member, the workspace selector now shows all child workspaces of all firms they're a member of, in addition to direct workspaces. Group them visually: "Your workspaces" section, then a section per firm with that firm's name as the header and child workspaces underneath. No firm dashboard yet — just navigation.

2. **Workspace settings** — when a workspace is bound to a firm, the workspace settings page shows a small banner: "This workspace is part of [Firm Name]. Plan and billing are managed at the firm level." The plan section is read-only; the upgrade/downgrade buttons are hidden for firm-bound workspaces. Other settings (members, defaults) remain editable.

That's it. No firm dashboard, no cross-workspace inbox, no firm member management UI. All of those are Phase 10.

---

## Tests to add in this phase

### Migration / DB

- Migration applies cleanly. Idempotent.
- Firm trigger blocks workspace from joining when limit is reached.
- Firm trigger increments and decrements counter correctly on join/leave/move.
- Plan-lock trigger prevents independent plan change on firm-bound workspace.
- Plan-lock trigger forces 'business' plan when joining a firm.
- `is_workspace_member` returns true for direct member of workspace not in firm.
- `is_workspace_member` returns true for firm member of workspace's parent firm (when restrict_firm_access = false).
- `is_workspace_member` returns false for firm member when restrict_firm_access = true.
- `is_firm_member` and `is_firm_admin` correct.
- Firm RLS prevents non-members from reading firm.

### Pure logic (vitest)

- `resolveEffectiveAccess` returns correct source and role for every combination of:
  - Owner/non-owner
  - Direct member with various roles
  - Firm member with various roles
  - restrict_firm_access on/off
- `hasWorkspaceAuthority` returns correct truth for hierarchy comparisons.
- Direct membership overrides firm-derived role (firm_admin who is explicitly viewer is viewer).
- Identical behavior between Node and Deno copies.

### Edge functions

`create-firm`:
- Service role can create firm.
- Validates required fields.
- Activity log captured.

`add-firm-member`:
- Firm admin can add member.
- Non-admin gets 403.
- Existing member returns idempotent success.

`bind-workspace-to-firm`:
- Owner of both can bind.
- Plan correctly forced to 'business'.
- Counter increments.
- Already-bound workspace rejected.
- Quota-exceeded firm rejected.

`release-workspace-from-firm`:
- Firm owner or workspace owner can release.
- Counter decrements.
- Plan stays at 'business' (per design decision).

### Frontend (vitest)

- Workspace selector groups firm workspaces under firm name.
- Firm-bound workspace settings page shows banner and hides plan controls.
- Direct membership properly overrides firm-derived role in UI gates.

### Integration / smoke

- Create a firm via service role.
- Add two workspaces to the firm.
- Add a user as firm_member.
- Verify the user can read both workspaces' leases via existing endpoints.
- Verify the user cannot read leases from a third workspace not in the firm.
- Set restrict_firm_access = true on one of the workspaces; verify the firm member loses access while the firm owner retains it.
- Stripe webhook smoke: simulate a firm subscription event, verify `firms.stripe_subscription_id` populated and child workspace plans set to 'business'.
- Test detailed vs. summarized billing mode by inspecting webhook-constructed line items.

---

## Out of scope for Phase 9 — explicit list

Do NOT build any of these in Phase 9.

- Firm dashboard UI (cross-workspace overview). Phase 10.
- Cross-workspace inbox aggregating pending approvals across child workspaces. Phase 10.
- Child workspace management UI (add/remove children, configure firm settings). Phase 10.
- Firm member management UI (invite, role change, remove). Phase 10.
- Self-serve firm creation flow for end users. Phase 10. Phase 9 is service-role-only.
- Firm-level reports rolling up data across multiple children (e.g., "all leases for all clients in Q4"). Phase 11+.
- White-label branding per firm. Phase 11+.
- Multi-firm membership for a single user. Defer indefinitely; complicates everything.
- Firm-level audit reporting (all firm member activity across all children). Phase 11+.
- Migration tools to bulk-import existing customers as a CPA's clients. Defer.
- Subsidiary self-onboarding (parent invites subsidiary, subsidiary accepts via email). Phase 10 has the basic invite; richer flow defers.
- Per-firm policy templates that propagate to children. Defer.
- Firm-level Stripe usage-based pricing tiers (e.g., volume discounts after N children). Defer; manual pricing for first 50 firms.

---

## Definition of done for Phase 9

1. Migration applied cleanly. All schema, trigger, RLS, helper-function tests pass. Mirror committed.
2. Pure helpers in `src/lib/firmAccess.ts` and Deno mirror with full unit tests passing.
3. Four new edge functions deployed (create-firm, add-firm-member, bind-workspace-to-firm, release-workspace-from-firm). Source verified.
4. Stripe webhook firm-tier branch tested with simulated events.
5. Frontend minimal changes:
   - Workspace selector groups by firm
   - Firm-bound workspace settings shows banner and read-only plan section
6. Smoke test:
   - Create a firm via service role, add child workspaces, add firm members
   - Verify firm members access child workspace leases via existing endpoints
   - Verify restrict_firm_access flag works
   - Verify quota enforcement blocks beyond limit
   - Verify webhook routes firm subscription correctly with both billing modes
7. Existing Plus/Pro tests still pass. Critical: every existing RLS test for `is_workspace_member` continues to behave correctly when the workspace has no firm. Phase 9 must not regress non-firm workspace behavior.
8. Performance check: query plans for the most common workspace-scoped queries do not regress meaningfully with the new RLS helper. The `is_workspace_member` helper now does up to 3 EXISTS checks; verify Postgres doesn't choose a worse plan.
9. As-built notes appendix on this spec captures any deltas discovered during implementation.
10. Phase closeout commit body lists every commit, migration, edge function deployment, and test added.
11. KNOWN_ISSUES.md updated.
12. CLAUDE.md updated to mark Phase 9 closed and Phase 10 (Firm UX) next.

---

## Notes for Claude Code

- The `is_workspace_member` helper change is the single most consequential line of code in this phase. It silently rewires every RLS policy in the codebase. Test extensively. Verify with EXPLAIN that query plans don't degrade. If any policy needs special handling for firm members (e.g., a sensitive table where firm members should NOT have implicit access even if the workspace doesn't restrict_firm_access), call it out explicitly — there are likely zero of these in current scope but Phase 11+ may add some.
- The `restrict_firm_access` opt-out is a per-workspace setting that defaults to false. Make this prominent in workspace settings UI for firm-bound workspaces — subsidiary owners should be able to find and toggle it.
- Plan locking when bound to a firm is a hard constraint at the database level. UI should surface this clearly (read-only plan badge, banner explaining "managed at firm level"). Do not allow client-side workarounds.
- The `firm_joined_at` timestamp matters for billing proration in Phase 11+. Capture it accurately.
- The detailed-vs-summarized billing mode is per-firm. The Stripe webhook reads it at invoice construction time. If a firm changes the mode mid-billing-cycle, the next invoice uses the new mode. Document this behavior clearly.
- Phase 9 introduces firm-level audit. The `firm_activity_log` table is the parallel to `lease_activity_log` for events that don't belong to a single lease. Use it consistently.
- Reuse the same checkpoint cadence as Phase 8:
  - Checkpoint 1: Migration + types regen + audit (most consumers should not need changes; audit confirms this)
  - Checkpoint 2: Pure helpers + Deno mirror + vitest
  - Checkpoint 3: Edge functions + Stripe webhook update + smoke
  - Checkpoint 4: Minimal frontend (selector grouping, settings banner)
  - Checkpoint 5: Tests + docs + closeout + integration smoke
- Apply the Permissions Gating Convention with care — `hasWorkspaceAuthority` is the new helper to use everywhere instead of raw role checks. Future audit work to migrate existing raw checks to this helper is filed as KNOWN_ISSUES (extending what's already there for `userRole === 'admin'`).
- Apply the Schema Change Rule, Lifecycle Transition Convention (no new transitions in this phase, but principle applies to firm activity log entries).
- Reference `docs/PRODUCT_STRATEGY.md` for any decision that touches tier boundaries. Phase 9 implements exactly the architecture sketched in the strategy doc; deviations should be documented in the As-built notes.
- Do not introduce new dependencies.
- Performance-watch for the firm-aware RLS helper. The triple-OR EXISTS structure should be fine for normal workloads, but Postgres can occasionally choose suboptimal plans. Add indexes if EXPLAIN shows seq scans on `workspaces.firm_id` or `firm_members(user_id, firm_id)` (the latter is already the unique index).
- The CPA validation work happens in parallel per Option C decision. If the validation surfaces any report format changes (Phase 8.1), they happen on a separate branch and merge after Phase 9 closes — no parallel-changing of the same files.
