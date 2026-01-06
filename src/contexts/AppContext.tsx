import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { User, Workspace, WorkspaceRole, SubscriptionPlan } from '@/types';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './AuthContext';

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

export function AppProvider({ children }: { children: ReactNode }) {
  const { user: authUser, isLoading: authLoading } = useAuth();
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [userRole, setUserRole] = useState<WorkspaceRole | 'owner' | null>('owner');
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!authUser;

  // Fetch profile from Supabase when auth user changes
  const fetchProfile = async () => {
    if (!authUser) {
      setUser(null);
      setWorkspace(null);
      setIsLoading(false);
      return;
    }

    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', authUser.id)
        .single();

      if (error) {
        console.error('Error fetching profile:', error);
        setIsLoading(false);
        return;
      }

      if (profile) {
        setUser({
          id: profile.id,
          email: profile.email || authUser.email || '',
          firstName: profile.first_name || '',
          lastName: profile.last_name || '',
          companyName: profile.company_name || '',
          timezone: profile.timezone || 'America/New_York',
          createdAt: profile.created_at,
          updatedAt: profile.created_at,
        });

        // Create a workspace from profile data for now
        setWorkspace({
          id: profile.id,
          name: profile.company_name || 'My Workspace',
          ownerId: profile.id,
          plan: profile.plan as SubscriptionPlan || 'pro',
          documentLimit: profile.plan === 'business' ? 50 : profile.plan === 'pro' ? 20 : 3,
          documentsUsed: profile.processed_count || 0,
          timezone: profile.timezone || 'America/New_York',
          defaultNotificationDays: 90,
          createdAt: profile.created_at,
          renewalDate: profile.subscription_period_end || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: profile.created_at,
        });
      }
    } catch (err) {
      console.error('Error in fetchProfile:', err);
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

  const canAccessFeature = (requiredPlan: SubscriptionPlan): boolean => {
    if (!workspace) return false;
    if (requiredPlan === 'pro') return true;
    return workspace.plan === 'business';
  };

  const hasPermission = (permission: 'billing' | 'integrations' | 'members' | 'leases' | 'export'): boolean => {
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
        setUser,
        workspace,
        setWorkspace,
        userRole,
        setUserRole,
        isAuthenticated,
        isLoading,
        setIsLoading,
        refreshProfile,
        canAccessFeature,
        hasPermission,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
