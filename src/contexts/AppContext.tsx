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
  /** Phase 2 functional roles from workspace_roles table */
  userFunctionalRoles: FunctionalRole[];
  setUserFunctionalRoles: (roles: FunctionalRole[]) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  refreshProfile: () => Promise<void>;
  canAccessFeature: (requiredPlan: SubscriptionPlan) => boolean;
  hasPermission: (permission: "billing" | "integrations" | "members" | "leases" | "export") => boolean;
  /** Returns true if user holds any of the specified functional roles */
  hasFunctionalRole: (role: FunctionalRole | FunctionalRole[]) => boolean;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const { user: authUser, isLoading: authLoading } = useAuth();
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [userRole, setUserRole] = useState<WorkspaceRole | "owner" | null>("owner");
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
      // IMPORTANT: select current_workspace_id if it exists; if it doesn't, this still works
      const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", authUser.id).single();

      if (error) {
        console.error("Error fetching profile:", error);
        setIsLoading(false);
        return;
      }

      if (!profile) {
        setIsLoading(false);
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

      const plan = normalizePlanId(profile.plan);
      const planConfig = PLANS[plan];


      const { count: activeLeasesCount } = await supabase
        .from('leases')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', (profile as any).current_workspace_id || profile.id)
        .eq('lifecycle_status', 'active');

      // ---- NEW: try to load real workspace if profile.current_workspace_id exists ----
      const currentWorkspaceId = (profile as any).current_workspace_id as string | null | undefined;

      if (currentWorkspaceId) {
        const { data: ws, error: wsError } = await supabase
          .from("workspaces")
          .select("id, name, owner_id, timezone, default_notification_days, created_at, updated_at")
          .eq("id", currentWorkspaceId)
          .single();

        if (!wsError && ws) {
          // Resolve role
          if (ws.owner_id === authUser.id) {
            setUserRole("owner");
          } else {
            const { data: memberRow } = await supabase
              .from("workspace_members")
              .select("role")
              .eq("workspace_id", ws.id)
              .eq("user_id", authUser.id)
              .maybeSingle();

            setUserRole((memberRow?.role as WorkspaceRole) || null);
          }

          setWorkspace({
            id: ws.id,
            name: ws.name || profile.company_name || "My Workspace",
            ownerId: ws.owner_id,
            plan,
            maxActiveLeases: planConfig?.maxActiveLeases ?? 5,
            activeLeasesUsed: activeLeasesCount || 0,
            timezone: ws.timezone || profile.timezone || "America/New_York",
            defaultNotificationDays: ws.default_notification_days ?? 90,
            createdAt: ws.created_at || profile.created_at,
            renewalDate:
              profile.subscription_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            updatedAt: ws.updated_at || ws.created_at || profile.created_at,
          });

          // Load functional roles (Phase 2) — gracefully handle missing table
          try {
            const { data: functionalRoleRows } = await (supabase as any)
              .from('workspace_roles')
              .select('role')
              .eq('workspace_id', ws.id)
              .eq('user_id', authUser.id);
            setUserFunctionalRoles((functionalRoleRows || []).map((r: any) => r.role as FunctionalRole));
          } catch {
            setUserFunctionalRoles([]);
          }

          setIsLoading(false);
          return;
        } else {
          console.warn("Could not load workspaces row for current_workspace_id, falling back:", wsError);
        }
      }

      // ---- FALLBACK: original behavior (prevents downtime) ----
      setUserRole("owner");
      setWorkspace({
        id: profile.id,
        name: profile.company_name || "My Workspace",
        ownerId: profile.id,
        plan,
        maxActiveLeases: planConfig?.maxActiveLeases ?? 5,
        activeLeasesUsed: activeLeasesCount || 0,
        timezone: profile.timezone || "America/New_York",
        defaultNotificationDays: 90,
        createdAt: profile.created_at,
        renewalDate: profile.subscription_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: profile.created_at,
      });
    } catch (err) {
      console.error("Error in fetchProfile:", err);
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
