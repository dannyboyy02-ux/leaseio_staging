import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from "react";
import { User, Workspace, WorkspaceRole, SubscriptionPlan } from "@/types";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./AuthContext";
import { PLANS, getPlanIndex, normalizePlanId } from "@/config/pricing";
import type { FunctionalRole } from "@/types/lifecycle";

export interface WorkspaceBasic {
  id: string;
  name: string;
  plan: SubscriptionPlan;
  /**
   * Live Stripe-derived status for the workspace (null when no sub).
   * Surfaced in the switcher so a pending-creation workspace can show a
   * "Resume setup" affordance. Owned-only — membership rows leave it null.
   */
  subscription_status: string | null;
  role: WorkspaceRole | "owner";
}

interface AppContextType {
  user: User | null;
  setUser: (user: User | null) => void;
  workspace: Workspace | null;
  setWorkspace: (workspace: Workspace | null) => void;
  userRole: WorkspaceRole | "owner" | null;
  setUserRole: (role: WorkspaceRole | "owner" | null) => void;
  userFunctionalRoles: FunctionalRole[];
  setUserFunctionalRoles: (roles: FunctionalRole[]) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  refreshProfile: () => Promise<void>;
  canAccessFeature: (requiredPlan: SubscriptionPlan) => boolean;
  hasPermission: (permission: "billing" | "integrations" | "members" | "leases" | "export") => boolean;
  hasFunctionalRole: (role: FunctionalRole | FunctionalRole[]) => boolean;
  availableWorkspaces: WorkspaceBasic[];
  switchWorkspace: (workspaceId: string) => Promise<void>;
}

type WorkspaceRow = {
  id: string;
  name: string | null;
  owner_id: string;
  plan: string | null;
  document_limit: number | null;
  timezone: string | null;
  default_notification_days: number | null;
  created_at: string;
  updated_at: string | null;
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const { user: authUser, isLoading: authLoading } = useAuth();
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [userRole, setUserRole] = useState<WorkspaceRole | "owner" | null>(null);
  const [userFunctionalRoles, setUserFunctionalRoles] = useState<FunctionalRole[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<WorkspaceBasic[]>([]);

  const isAuthenticated = !!authUser;

  const fetchProfile = async () => {
    if (!authUser) {
      setUser(null);
      setWorkspace(null);
      setUserRole(null);
      setUserFunctionalRoles([]);
      setIsLoading(false);
      return;
    }

    try {
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", authUser.id)
        .single();

      if (error || !profile) {
        console.error("Error fetching profile:", error);
        setUser(null);
        setWorkspace(null);
        setUserRole(null);
        setUserFunctionalRoles([]);
        return;
      }

      setUser({
        id: profile.id,
        email: profile.email || authUser.email || "",
        firstName: profile.first_name || "",
        lastName: profile.last_name || "",
        companyName: profile.company_name || "",
        timezone: profile.timezone || "America/New_York",
        createdAt: profile.created_at,
        updatedAt: profile.created_at,
      });

      const workspaceSelect =
        "id, name, owner_id, plan, document_limit, addon_document_capacity, timezone, default_notification_days, created_at, updated_at, billing_interval, subscription_status, subscription_period_end";

      let resolvedWorkspace: WorkspaceRow | null = null;
      let resolvedRole: WorkspaceRole | "owner" | null = null;
      const currentWorkspaceId = (profile as any).current_workspace_id as string | null | undefined;

      if (currentWorkspaceId) {
        const { data: ws, error: wsError } = await (supabase as any)
          .from("workspaces")
          .select(workspaceSelect)
          .eq("id", currentWorkspaceId)
          .maybeSingle();

        if (!wsError && ws) {
          resolvedWorkspace = ws as WorkspaceRow;
        } else if (wsError) {
          console.warn("Could not load current workspace:", wsError);
        }
      }

      if (!resolvedWorkspace) {
        const { data: ownedWorkspace } = await (supabase as any)
          .from("workspaces")
          .select(workspaceSelect)
          .eq("owner_id", authUser.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (ownedWorkspace) resolvedWorkspace = ownedWorkspace as WorkspaceRow;
      }

      if (!resolvedWorkspace) {
        const { data: membership } = await (supabase as any)
          .from("workspace_members")
          .select("workspace_id, role")
          .eq("user_id", authUser.id)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (membership?.workspace_id) {
          const { data: memberWorkspace } = await (supabase as any)
            .from("workspaces")
            .select(workspaceSelect)
            .eq("id", membership.workspace_id)
            .maybeSingle();

          if (memberWorkspace) {
            resolvedWorkspace = memberWorkspace as WorkspaceRow;
            resolvedRole = membership.role as WorkspaceRole;
          }
        }
      }

      if (!resolvedWorkspace) {
        setWorkspace(null);
        setUserRole(null);
        setUserFunctionalRoles([]);
        return;
      }

      if (resolvedWorkspace.owner_id === authUser.id) {
        resolvedRole = "owner";
      } else if (!resolvedRole) {
        const { data: memberRow } = await (supabase as any)
          .from("workspace_members")
          .select("role")
          .eq("workspace_id", resolvedWorkspace.id)
          .eq("user_id", authUser.id)
          .maybeSingle();
        resolvedRole = (memberRow?.role as WorkspaceRole) || null;
      }

      if (currentWorkspaceId !== resolvedWorkspace.id) {
        await (supabase as any)
          .from("profiles")
          .update({ current_workspace_id: resolvedWorkspace.id })
          .eq("id", authUser.id);
      }

      const plan = normalizePlanId(resolvedWorkspace.plan);
      const planConfig = PLANS[plan];
      const documentLimit =
        resolvedWorkspace.document_limit ?? planConfig?.maxActiveLeases ?? 15;
      const archiveLimit =
        (resolvedWorkspace as any).max_archived_leases
        ?? planConfig?.maxArchivedLeases
        ?? 50;

      // Active leases now exclude archived rows so an admin archive frees a
      // slot even if lifecycle_status is still 'active'.
      // Monthly extractions mirror process_lease's assertProcessingQuota
      // (uploaded in the trailing 30 days with a completed extraction) —
      // the workspaces.documents_used column is dead and always 0
      // (KNOWN_ISSUES #31), so the usage meter must count live rows.
      const since30dIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [activeRes, archivedRes, monthlyRes] = await Promise.all([
        (supabase as any)
          .from("leases")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", resolvedWorkspace.id)
          .eq("lifecycle_status", "active")
          .eq("archived", false),
        (supabase as any)
          .from("leases")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", resolvedWorkspace.id)
          .eq("archived", true),
        (supabase as any)
          .from("leases")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", resolvedWorkspace.id)
          .gte("uploaded_at", since30dIso)
          .not("extracted_json", "is", null),
      ]);

      setUserRole(resolvedRole);
      setWorkspace({
        id: resolvedWorkspace.id,
        name: resolvedWorkspace.name || profile.company_name || "My Workspace",
        ownerId: resolvedWorkspace.owner_id,
        plan,
        maxActiveLeases: documentLimit,
        activeLeasesUsed: activeRes.count || 0,
        maxArchivedLeases: archiveLimit,
        archivedLeasesUsed: archivedRes.count || 0,
        documentLimit,
        addonDocumentCapacity: Math.max(
          0,
          Number((resolvedWorkspace as any).addon_document_capacity ?? 0),
        ),
        documentsUsed: monthlyRes.count || 0,
        timezone: resolvedWorkspace.timezone || profile.timezone || "America/New_York",
        defaultNotificationDays: resolvedWorkspace.default_notification_days ?? 90,
        createdAt: resolvedWorkspace.created_at || profile.created_at,
        updatedAt:
          resolvedWorkspace.updated_at || resolvedWorkspace.created_at || profile.created_at,
        subscriptionStatus:
          (resolvedWorkspace as any).subscription_status ?? null,
        billingInterval:
          (resolvedWorkspace as any).billing_interval ?? null,
        subscriptionPeriodEnd:
          (resolvedWorkspace as any).subscription_period_end ?? null,
        intendedPlan:
          (resolvedWorkspace as any).intended_plan ?? null,
      });

      try {
        const { data: functionalRoleRows } = await (supabase as any)
          .from("workspace_roles")
          .select("role")
          .eq("workspace_id", resolvedWorkspace.id)
          .eq("user_id", authUser.id);
        setUserFunctionalRoles((functionalRoleRows || []).map((r: any) => r.role as FunctionalRole));
      } catch {
        setUserFunctionalRoles([]);
      }

      // Fetch all workspaces the user can access
      try {
        const { data: ownedWs } = await (supabase as any)
          .from("workspaces")
          .select("id, name, plan, subscription_status")
          .eq("owner_id", authUser.id);

        const { data: membershipWs } = await (supabase as any)
          .from("workspace_members")
          .select("role, workspace_id, workspaces(id, name, plan)")
          .eq("user_id", authUser.id);

        const ownedIds = new Set((ownedWs ?? []).map((w: any) => w.id));
        const all: WorkspaceBasic[] = [
          ...(ownedWs ?? []).map((w: any) => ({
            id: w.id,
            name: w.name || "Unnamed",
            plan: normalizePlanId(w.plan),
            subscription_status: (w.subscription_status as string | null) ?? null,
            role: "owner" as const,
          })),
          ...(membershipWs ?? [])
            .filter((m: any) => !ownedIds.has(m.workspace_id))
            .map((m: any) => ({
              id: m.workspace_id,
              name: m.workspaces?.name || "Unnamed",
              plan: normalizePlanId(m.workspaces?.plan),
              subscription_status: null,
              role: m.role as WorkspaceRole,
            })),
        ];
        setAvailableWorkspaces(all);
      } catch {
        setAvailableWorkspaces([]);
      }
    } catch (err) {
      console.error("Error in fetchProfile:", err);
      setWorkspace(null);
      setUserRole(null);
      setUserFunctionalRoles([]);
    } finally {
      setIsLoading(false);
    }
  };

  const refreshProfile = async () => {
    await fetchProfile();
  };

  // Stable identity for refreshProfile — fetchProfile is recreated on every
  // render, so exposing it directly would change the context value's identity
  // each render and refire any consumer effect that depends on it (caused the
  // ?checkout=success toast/fetch loop, 2026-06-11). A ref keeps the latest
  // closure while the callback identity stays constant.
  const fetchProfileRef = useRef(fetchProfile);
  fetchProfileRef.current = fetchProfile;
  const stableRefreshProfile = useCallback(() => fetchProfileRef.current(), []);

  const switchWorkspace = async (workspaceId: string) => {
    if (!authUser) return;
    await (supabase as any)
      .from("profiles")
      .update({ current_workspace_id: workspaceId })
      .eq("id", authUser.id);
    await fetchProfile();
  };

  useEffect(() => {
    if (!authLoading) {
      fetchProfile();
    }
  }, [authUser, authLoading]);

  const hasFunctionalRole = (role: FunctionalRole | FunctionalRole[]): boolean => {
    const roles = Array.isArray(role) ? role : [role];
    return roles.some((r) => userFunctionalRoles.includes(r));
  };

  const canAccessFeature = (requiredPlan: SubscriptionPlan): boolean => {
    if (!workspace) return false;
    const currentPlanIndex = getPlanIndex(workspace.plan);
    const requiredPlanIndex = getPlanIndex(requiredPlan);
    return currentPlanIndex >= requiredPlanIndex;
  };

  const hasPermission = (permission: "billing" | "integrations" | "members" | "leases" | "export"): boolean => {
    if (!userRole) return false;

    const permissions: Record<WorkspaceRole | "owner", string[]> = {
      owner: ["billing", "integrations", "members", "leases", "export"],
      admin: ["billing", "integrations", "members", "leases", "export"],
      editor: ["leases", "export"],
      viewer: [],
    };

    return permissions[userRole].includes(permission);
  };

  return (
    <AppContext.Provider
      value={{
        user,
        setUser,
        workspace,
        setWorkspace,
        userRole,
        setUserRole,
        userFunctionalRoles,
        setUserFunctionalRoles,
        isAuthenticated,
        isLoading,
        setIsLoading,
        refreshProfile: stableRefreshProfile,
        canAccessFeature,
        hasPermission,
        hasFunctionalRole,
        availableWorkspaces,
        switchWorkspace,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
}
