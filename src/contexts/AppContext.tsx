import React, { createContext, useContext, useState, ReactNode } from 'react';
import { User, Workspace, WorkspaceMember, SubscriptionPlan } from '@/types';

interface AppContextType {
  user: User | null;
  setUser: (user: User | null) => void;
  workspace: Workspace | null;
  setWorkspace: (workspace: Workspace | null) => void;
  userRole: WorkspaceMember['role'] | null;
  setUserRole: (role: WorkspaceMember['role'] | null) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  
  // Helpers
  canAccessFeature: (requiredPlan: SubscriptionPlan) => boolean;
  hasPermission: (permission: 'billing' | 'integrations' | 'members' | 'leases' | 'export') => boolean;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Mock data for development
const mockUser: User = {
  id: '1',
  email: 'demo@leaseos.com',
  firstName: 'Alex',
  lastName: 'Morgan',
  companyName: 'Acme Properties',
  timezone: 'America/New_York',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockWorkspace: Workspace = {
  id: '1',
  name: 'Acme Properties',
  ownerId: '1',
  plan: 'business',
  documentLimit: 20,
  documentsUsed: 7,
  timezone: 'America/New_York',
  defaultNotificationDays: 90,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(mockUser);
  const [workspace, setWorkspace] = useState<Workspace | null>(mockWorkspace);
  const [userRole, setUserRole] = useState<WorkspaceMember['role'] | null>('owner');
  const [isLoading, setIsLoading] = useState(false);

  const isAuthenticated = !!user;

  const canAccessFeature = (requiredPlan: SubscriptionPlan): boolean => {
    if (!workspace) return false;
    if (requiredPlan === 'pro') return true;
    return workspace.plan === 'business';
  };

  const hasPermission = (permission: 'billing' | 'integrations' | 'members' | 'leases' | 'export'): boolean => {
    if (!userRole) return false;
    
    const permissions: Record<WorkspaceMember['role'], string[]> = {
      owner: ['billing', 'integrations', 'members', 'leases', 'export'],
      admin: ['billing', 'integrations', 'members', 'leases', 'export'],
      manager: ['leases', 'export'],
      reviewer: ['leases'],
      readonly: [],
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
