import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { User, Workspace, WorkspaceRole, SubscriptionPlan } from "@/types";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./AuthContext";
import { PLANS, getPlanIndex, normalizePlanId } from "@/config/pricing";
import type { FunctionalRole } from "@/types/lifecycle";

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
}

type WorkspaceRow = {
  id: string;
  name: string | null;
  owner_id: string;
  plan: string | null;
  document_limit: number | null;
  documents_used: number | null;
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
        "id, name, owner_id, plan, document_limit, documents_used, timezone, default_notification_days, created_at, updated_at";

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

      const { count: activeLeasesCount } = await supabase
        .from("leases")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", resolvedWorkspace.id)
        .eq("lifecycle_status", "active");

      setUserRole(resolvedRole);
      setWorkspace({
        id: resolvedWorkspace.id,
        name: resolvedWorkspace.name || profile.company_name || "My Workspace",
        ownerId: resolvedWorkspace.owner_id,
        plan,
        maxActiveLeases: documentLimit,
        activeLeasesUsed: activeLeasesCount || 0,
        documentLimit,
        documentsUsed: resolvedWorkspace.documents_used ?? 0,
        timezone: resolvedWorkspace.timezone || profile.timezone || "America/New_York",
        defaultNotificationDays: resolvedWorkspace.default_notification_days ?? 90,
        createdAt: resolvedWorkspace.created_at || profile.created_at,
        renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt:
          resolvedWorkspace.updated_at || resolvedWorkspace.created_at || profile.created_at,
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
        refreshProfile,
        canAccessFeature,
        hasPermission,
        hasFunctionalRole,
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
