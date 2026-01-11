import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, Workspace, WorkspaceRole, SubscriptionPlan } from '@/types';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';
import { PLANS, getPlanIndex } from '@/config/pricing';

interface AppContextType {
  user: User | null;
  setUser: (user: User | null) => void;
  workspace: Workspace | null;
  setWorkspace: (workspace: Workspace | null) => void;
  userRole: WorkspaceRole | 'owner' | null;
  setUserRole: (role: WorkspaceRole | 'owner' | null) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  refreshProfile: () => Promise<void>;

  // Helpers
  canAccessFeature: (requiredPlan: SubscriptionPlan) => boolean;
  hasPermission: (permission: 'billing' | 'integrations' | 'members' | 'leases' | 'export') => boolean;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

function errToString(e: any): string {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (typeof e?.message === 'string') return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return 'Unknown error';
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { user: authUser, isLoading: authLoading } = useAuth();

  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [userRole, setUserRole] = useState<WorkspaceRole | 'owner' | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!authUser;

  // Fetch profile + resolve current workspace from profiles.current_workspace_id
  const fetchProfile = async () => {
    // While auth is still loading, keep AppContext in loading state
    if (authLoading) return;

    if (!authUser) {
      setUser(null);
      setWorkspace(null);
      setUserRole(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      // 1) Load profile INCLUDING current_workspace_id (new column)
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select(
          `
          id,
          email,
          first_name,
          last_name,
          company_name,
          timezone,
          created_at,
          updated_at,
          plan,
          processed_count,
          subscription_period_end,
          current_workspace_id
        `
        )
        .eq('id', authUser.id)
        .single();

      if (profileError) {
        console.error('Error fetching profile:', profileError);
        setUser(null);
        setWorkspace(null);
        setUserRole(null);
        setIsLoading(false);
        return;
      }

      // 2) Set user from profile
      setUser({
        id: profile.id,
        email: profile.email || authUser.email || '',
        firstName: profile.first_name || '',
        lastName: profile.last_name || '',
        companyName: profile.company_name || '',
        timezone: profile.timezone || 'America/New_York',
        createdAt: profile.created_at,
        updatedAt: profile.updated_at || profile.created_at,
      });

      // 3) Determine plan from profile (plan remains profile-based for now)
      const plan: SubscriptionPlan = (profile.plan as SubscriptionPlan) || 'free';
      const planConfig = PLANS[plan];

      // 4) If no workspace pointer, do NOT fake a workspace
      const currentWorkspaceId: string | null = profile.current_workspace_id || null;
      if (!currentWorkspaceId) {
        setWorkspace(null);
        setUserRole(null);
        setIsLoading(false);
        return;
      }

      // 5) Load the real workspace row from workspaces table
      const { data: ws, error: wsError } = await supabase
        .from('workspaces')
        .select(
          `
          id,
          name,
          owner_id,
          timezone,
          default_notification_days,
          created_at,
          updated_at
        `
        )
        .eq('id', currentWorkspaceId)
        .single();

      if (wsError) {
        console.error('Error fetching workspace:', wsError);
        setWorkspace(null);
        setUserRole(null);
        setIsLoading(false);
        return;
      }

      // 6) Resolve role: owner if owner_id matches user; else lookup workspace_members.role
      let resolvedRole: WorkspaceRole | 'owner' | null = null;
      if (ws.owner_id === authUser.id) {
        resolvedRole = 'owner';
      } else {
        const { data: memberRow, error: memberError } = await supabase
          .from('workspace_members')
          .select('role')
          .eq('workspace_id', ws.id)
          .eq('user_id', authUser.id)
          .maybeSingle();

        if (memberError) {
          console.error('Error fetching membership role:', memberError);
        } else if (memberRow?.role) {
          resolvedRole = memberRow.role as WorkspaceRole;
        }
      }
      setUserRole(resolvedRole);

      // 7) Set workspace from real workspaces row (NO MORE profile-id workspace)
      setWorkspace({
        id: ws.id,
        name: ws.name || 'My Workspace',
        ownerId: ws.owner_id,
        plan,
        documentLimit: planConfig?.documentLimit || 1,
        documentsUsed: profile.processed_count || 0,
        timezone: ws.timezone || profile.timezone || 'America/New_York',
        defaultNotificationDays: ws.default_notification_days ?? 90,
        createdAt: ws.created_at || profile.created_at,
        updatedAt: ws.updated_at || ws.created_at || profile.updated_at || profile.created_at,
        renewalDate:
          profile.subscription_period_end ||
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch (err) {
      console.error('Error in fetchProfile:', errToString(err));
      setUser(null);
      setWorkspace(null);
      setUserRole(null);
    } finally {
      setIsLoading(false);
    }
  };

  const refreshProfile = async () => {
    await fetchProfile();
  };

  useEffect(() => {
    // When auth changes or finishes loading, refresh context
    if (!authLoading) {
      fetchProfile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, authLoading]);

  // Check if user can access a feature based on their plan level
  const canAccessFeature = (requiredPlan: SubscriptionPlan): boolean => {
    if (!workspace) return false;
    const currentPlanIndex = getPlanIndex(workspace.plan);
    const requiredPlanIndex = getPlanIndex(requiredPlan);
    return currentPlanIndex >= requiredPlanIndex;
  };

  const hasPermission = (
    permission: 'billing' | 'integrations' | 'members' | 'leases' | 'export'
  ): boolean => {
    if (!userRole) return false;

    const permissions: Record<WorkspaceRole | 'owner', string[]> = {
      owner: ['billing', 'integrations', 'members', 'leases', 'export'],
      admin: ['billing', 'integrations', 'members', 'leases', 'export'],
      editor: ['leases', 'export'],
      viewer: [],
    };

    return permissions[userRole].includes(permission);
  };

  return (
    <AppContext.Provider
      value={{
        user,
       
