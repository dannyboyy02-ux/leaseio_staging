import { useState, useEffect, type Dispatch, type SetStateAction } from 'react';
import { Building2, Users, Bell, Save, Loader2, UserPlus, Trash2, Crown, TrendingUp, AlertTriangle, Package, Settings2, Plus, X } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { RiskWatchlistManager } from '@/components/workspace/RiskWatchlistManager';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { InviteMemberDialog } from '@/components/workspace/InviteMemberDialog';
import { MemberRoleSelect } from '@/components/workspace/MemberRoleSelect';
import { PendingInvitesList } from '@/components/workspace/PendingInvitesList';
import { WorkspaceRole } from '@/types';
import type { FunctionalRole } from '@/types/lifecycle';
import { Link } from 'react-router-dom';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { calculateLease } from '@/lib/leaseCalculations';
import {
  canAccessWorkspaceDefaults,
  canAccessWorkspaceProfile,
  canEditWorkspaceSettings,
  canManageWorkspaceMembers,
} from '@/lib/authorization';

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
];

async function recomputeWorkspaceLeaseFinancials(workspaceId: string, discountRate: number) {
  const { data: leases, error } = await supabase
    .from('leases')
    .select(
      'id, executed_monthly_payment, current_monthly_rent, monthly_payment, lease_start, term_months, escalation_rate'
    )
    .eq('workspace_id', workspaceId);

  if (error) throw error;

  const updates = (leases || []).map((lease) => {
    const monthlyPayment =
      Number((lease as any).executed_monthly_payment) ||
      Number((lease as any).current_monthly_rent) ||
      Number((lease as any).monthly_payment) ||
      0;

    const termMonths = Number((lease as any).term_months) || 0;
    const startDate = (lease as any).lease_start;
    const escalationRate = Number((lease as any).escalation_rate) || 0;

    if (!monthlyPayment || !termMonths || !startDate) {
      return supabase
        .from('leases')
        .update({
          calc_total_commitment: null,
          calc_pv_liability: null,
          calc_straight_line_exp: null,
          calc_cash_pl_delta: null,
        } as any)
        .eq('id', lease.id);
    }

    const calcs = calculateLease({
      monthlyPayment,
      termMonths,
      startDate,
      escalationRate,
      discountRate,
    });

    return supabase
      .from('leases')
      .update({
        calc_total_commitment: calcs.totalCashCommitment,
        calc_pv_liability: calcs.pvLiability,
        calc_straight_line_exp: calcs.straightLineExpense,
        calc_cash_pl_delta: calcs.cashPLDelta,
      } as any)
      .eq('id', lease.id);
  });

  await Promise.all(updates);
}

interface WorkspaceSettingsProps {
  /** When true, skip the outer AppLayout/AppHeader so this can render inside
   *  another page (e.g. as a TabsContent in /app/settings/account). */
  embedded?: boolean;
}

export default function WorkspaceSettings({ embedded = false }: WorkspaceSettingsProps = {}) {
  const { workspace, refreshProfile, userRole } = useApp();
  const { t } = useLanguage();
  const [workspaceName, setWorkspaceName] = useState(workspace?.name || '');
  const [timezone, setTimezone] = useState(workspace?.timezone || 'America/New_York');
  const [notificationDays, setNotificationDays] = useState(
    String(workspace?.defaultNotificationDays || 90)
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);
  const [isSavingFinancial, setIsSavingFinancial] = useState(false);
  const [isSavingRoles, setIsSavingRoles] = useState(false);
  const [backdoorEnabled, setBackdoorEnabled] = useState(false);
  const [isSavingBackdoor, setIsSavingBackdoor] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  // Phase 2 — functional roles state: map of user_id → Set<FunctionalRole>
  const [memberRoles, setMemberRoles] = useState<Record<string, Set<FunctionalRole>>>({});
  const [rolesLoaded, setRolesLoaded] = useState(false);

  // Financial configuration state
  const [discountRate, setDiscountRate] = useState('5.5');
  const [covenantThreshold, setCovenantThreshold] = useState('');
  const [approvalThreshold, setApprovalThreshold] = useState('0');

  // Lease configuration state
  const [assetTypeConfig, setAssetTypeConfig] = useState<string[]>(['Real Estate', 'Equipment', 'Vehicle', 'Other']);
  const [newAssetType, setNewAssetType] = useState('');
  const [isSavingAssetTypes, setIsSavingAssetTypes] = useState(false);

  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);
  const [newDepartmentOption, setNewDepartmentOption] = useState('');
  const [isSavingDepartments, setIsSavingDepartments] = useState(false);

  const [regionOptions, setRegionOptions] = useState<string[]>([]);
  const [newRegionOption, setNewRegionOption] = useState('');
  const [isSavingRegions, setIsSavingRegions] = useState(false);

  const [locationOptions, setLocationOptions] = useState<string[]>([]);
  const [newLocationOption, setNewLocationOption] = useState('');
  const [isSavingLocations, setIsSavingLocations] = useState(false);

  const [buildingOptions, setBuildingOptions] = useState<string[]>([]);
  const [newBuildingOption, setNewBuildingOption] = useState('');
  const [isSavingBuildings, setIsSavingBuildings] = useState(false);

  const canEdit = canEditWorkspaceSettings(userRole);
  const canManageMembers = canManageWorkspaceMembers(userRole);
  const canAccessDefaults = canAccessWorkspaceDefaults(userRole);
  const canAccessProfile = canAccessWorkspaceProfile(userRole);
  const isAdmin = userRole === 'admin';

  const tabs = [
    { id: 'profile',       label: 'Company Profile', icon: Building2,  visible: canAccessProfile },
    { id: 'users',         label: 'Users',            icon: Users,      visible: canManageMembers },
    { id: 'notifications', label: 'Notifications',    icon: Bell,       visible: canAccessDefaults },
    { id: 'financial',     label: 'Financial',        icon: TrendingUp, visible: canAccessDefaults },
    { id: 'lease_config',  label: 'Lease Configuration', icon: Settings2, visible: isAdmin },
    { id: 'risk_watchlist',label: 'Risk Watchlist',   icon: AlertTriangle, visible: canEdit },
    { id: 'onboarding',    label: 'Onboarding',       icon: Package,    visible: isAdmin },
  ].filter((tab) => tab.visible);

  const defaultTab = tabs[0]?.id ?? 'profile';

  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.name || '');
      setTimezone(workspace.timezone || 'America/New_York');
      setNotificationDays(String(workspace.defaultNotificationDays || 90));
    }
  }, [workspace]);

  // Load financial settings from workspaces table
  useEffect(() => {
    if (!workspace?.id) return;
    supabase
      .from('workspaces')
      .select('discount_rate, covenant_threshold, approval_threshold, backdoor_enabled, asset_type_config, department_options, region_options, location_options, building_options')
      .eq('id', workspace.id)
      .single()
      .then(({ data }) => {
        if (data) {
          setDiscountRate(String((data as any).discount_rate ?? 5.5));
          setCovenantThreshold(
            (data as any).covenant_threshold != null
              ? String((data as any).covenant_threshold)
              : ''
          );
          setApprovalThreshold(String((data as any).approval_threshold ?? 0));
          setBackdoorEnabled((data as any).backdoor_enabled ?? false);
          if (Array.isArray((data as any).asset_type_config) && (data as any).asset_type_config.length > 0) {
            setAssetTypeConfig((data as any).asset_type_config as string[]);
          }
          if (Array.isArray((data as any).department_options)) setDepartmentOptions((data as any).department_options as string[]);
          if (Array.isArray((data as any).region_options)) setRegionOptions((data as any).region_options as string[]);
          if (Array.isArray((data as any).location_options)) setLocationOptions((data as any).location_options as string[]);
          if (Array.isArray((data as any).building_options)) setBuildingOptions((data as any).building_options as string[]);
        }
      });
  }, [workspace?.id]);

  // Load functional roles from workspace_roles table
  useEffect(() => {
    if (!workspace?.id) return;
    (supabase as any)
      .from('workspace_roles')
      .select('user_id, role')
      .eq('workspace_id', workspace.id)
      .then(({ data }: { data: Array<{ user_id: string; role: string }> | null }) => {
        const map: Record<string, Set<FunctionalRole>> = {};
        for (const row of data || []) {
          if (!map[row.user_id]) map[row.user_id] = new Set();
          map[row.user_id].add(row.role as FunctionalRole);
        }
        setMemberRoles(map);
        setRolesLoaded(true);
      });
  }, [workspace?.id]);

  const toggleFunctionalRole = (userId: string, role: FunctionalRole) => {
    setMemberRoles((prev) => {
      const next = { ...prev };
      const current = new Set(next[userId] || []);
      if (current.has(role)) {
        current.delete(role);
      } else {
        current.add(role);
      }
      next[userId] = current;
      return next;
    });
  };

  // Assign a single approver role (clears existing holder first — one person per step)
  const assignApproverRole = (role: 'manager_approver' | 'financial_approver', userId: string | null) => {
    setMemberRoles((prev) => {
      const next: Record<string, Set<FunctionalRole>> = {};
      for (const [uid, roles] of Object.entries(prev)) {
        const updated = new Set(roles);
        updated.delete(role);
        next[uid] = updated;
      }
      if (userId) {
        if (!next[userId]) next[userId] = new Set();
        next[userId].add(role);
      }
      return next;
    });
  };

  const managerApproverId = Object.entries(memberRoles).find(([, r]) => r.has('manager_approver'))?.[0] ?? null;
  const financialApproverId = Object.entries(memberRoles).find(([, r]) => r.has('financial_approver'))?.[0] ?? null;

  const hasFinancialApprover = financialApproverId !== null;

  const handleSaveRoles = async () => {
    if (!canEdit) { toast.error(t('workspace.read_only')); return; }
    if (!workspace?.id) { toast.error('No workspace found'); return; }
    setIsSavingRoles(true);
    try {
      // Delete all existing roles for this workspace, then re-insert
      const { error: deleteError } = await (supabase as any)
        .from('workspace_roles')
        .delete()
        .eq('workspace_id', workspace.id);
      if (deleteError) throw deleteError;

      const rows: Array<{ workspace_id: string; user_id: string; role: FunctionalRole }> = [];
      for (const [userId, roles] of Object.entries(memberRoles)) {
        for (const role of roles) {
          rows.push({ workspace_id: workspace.id, user_id: userId, role });
        }
      }

      if (rows.length > 0) {
        const { error: insertError } = await (supabase as any)
          .from('workspace_roles')
          .insert(rows);
        if (insertError) throw insertError;
      }

      toast.success('Team roles saved');
    } catch (error) {
      console.error('Error saving roles:', error);
      toast.error('Failed to save team roles');
    } finally {
      setIsSavingRoles(false);
    }
  };

  const { data: members, isLoading: membersLoading, refetch: refetchMembers } = useQuery({
    queryKey: ['workspace-members', workspace?.id],
    queryFn: async () => {
      if (!workspace?.id) return [];

      const { data, error } = await supabase
        .from('workspace_members')
        .select(`id, role, user_id, created_at`)
        .eq('workspace_id', workspace.id);

      if (error) throw error;

      const memberIds = data?.map(m => m.user_id) || [];
      if (memberIds.length === 0) return [];

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', memberIds);

      if (profilesError) throw profilesError;

      return data?.map(member => {
        const profile = profiles?.find(p => p.id === member.user_id);
        return {
          ...member,
          email: profile?.email || 'Unknown',
          name: profile?.first_name && profile?.last_name
            ? `${profile.first_name} ${profile.last_name}`
            : profile?.email || 'Unknown User',
        };
      }) || [];
    },
    enabled: !!workspace?.id,
  });

  const { data: pendingInvites = [], refetch: refetchPending } = useQuery({
    queryKey: ['pending-invites', workspace?.id],
    queryFn: async () => {
      if (!workspace?.id) return [];
      const { data, error } = await supabase.functions.invoke('list-pending-invites', {
        body: { workspaceId: workspace.id },
      });
      if (error || !data?.ok) return [];
      return data.data?.invites || [];
    },
    enabled: !!workspace?.id && canManageMembers,
  });

  const handleSaveGeneral = async () => {
    if (!canEdit) { toast.error(t('workspace.read_only')); return; }
    if (!workspace?.id) { toast.error('No workspace found'); return; }
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({ name: workspaceName.trim(), timezone })
        .eq('id', workspace.id);
      if (error) throw error;
      if (refreshProfile) await refreshProfile();
      toast.success('Workspace settings saved!');
    } catch (error) {
      console.error('Error saving workspace:', error);
      toast.error('Failed to save workspace settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNotifications = async () => {
    if (!canEdit) { toast.error(t('workspace.read_only')); return; }
    if (!workspace?.id) { toast.error('No workspace found'); return; }
    setIsSavingNotifications(true);
    try {
      const days = parseInt(notificationDays) || 90;
      const { error } = await supabase
        .from('workspaces')
        .update({ default_notification_days: days })
        .eq('id', workspace.id);
      if (error) throw error;
      if (refreshProfile) await refreshProfile();
      toast.success('Notification settings saved!');
    } catch (error) {
      console.error('Error saving notifications:', error);
      toast.error('Failed to save notification settings');
    } finally {
      setIsSavingNotifications(false);
    }
  };

  const handleSaveFinancial = async () => {
    if (!canEdit) { toast.error(t('workspace.read_only')); return; }
    if (!workspace?.id) { toast.error('No workspace found'); return; }
    setIsSavingFinancial(true);
    try {
      const parsedDiscountRate = parseFloat(discountRate);
      if (!(parsedDiscountRate > 0 && parsedDiscountRate <= 50)) {
        toast.error('Discount rate must be greater than 0 and no more than 50.');
        return;
      }

      const { error } = await supabase
        .from('workspaces')
        .update({
          discount_rate: parsedDiscountRate,
          covenant_threshold: covenantThreshold ? parseFloat(covenantThreshold) : null,
          approval_threshold: parseFloat(approvalThreshold) || 0,
        } as any)
        .eq('id', workspace.id);
      if (error) throw error;
      await recomputeWorkspaceLeaseFinancials(workspace.id, parsedDiscountRate);
      toast.success('Financial configuration saved!');
    } catch (error) {
      console.error('Error saving financial config:', error);
      toast.error('Failed to save financial configuration');
    } finally {
      setIsSavingFinancial(false);
    }
  };

  const handleSaveBackdoor = async (value: boolean) => {
    if (!workspace?.id) return;
    setIsSavingBackdoor(true);
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({ backdoor_enabled: value } as any)
        .eq('id', workspace.id);
      if (error) throw error;
      setBackdoorEnabled(value);
      toast.success('Onboarding settings saved');
    } catch (error) {
      console.error('Error saving backdoor toggle:', error);
      toast.error('Failed to save onboarding settings');
    } finally {
      setIsSavingBackdoor(false);
    }
  };

  const handleAddAssetType = () => {
    const trimmed = newAssetType.trim();
    if (!trimmed || assetTypeConfig.includes(trimmed)) return;
    setAssetTypeConfig(prev => [...prev, trimmed]);
    setNewAssetType('');
  };

  const handleRemoveAssetType = (type: string) => {
    setAssetTypeConfig(prev => prev.filter(t => t !== type));
  };

  const handleSaveAssetTypes = async () => {
    if (!workspace?.id) return;
    setIsSavingAssetTypes(true);
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({ asset_type_config: assetTypeConfig } as any)
        .eq('id', workspace.id);
      if (error) throw error;
      toast.success('Asset types saved');
    } catch (error) {
      console.error('Error saving asset types:', error);
      toast.error('Failed to save asset types');
    } finally {
      setIsSavingAssetTypes(false);
    }
  };

  const makeOptionListHandlers = (
    options: string[],
    setOptions: Dispatch<SetStateAction<string[]>>,
    setNew: Dispatch<SetStateAction<string>>,
    setIsSaving: Dispatch<SetStateAction<boolean>>,
    dbColumn: string,
  ) => ({
    handleAdd: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || options.includes(trimmed)) return;
      setOptions(prev => [...prev, trimmed]);
      setNew('');
    },
    handleRemove: (item: string) => setOptions(prev => prev.filter(o => o !== item)),
    handleSave: async (latest: string[]) => {
      if (!workspace?.id) return;
      setIsSaving(true);
      try {
        const { error } = await supabase
          .from('workspaces')
          .update({ [dbColumn]: latest } as any)
          .eq('id', workspace.id);
        if (error) throw error;
        toast.success('Options saved');
      } catch (err) {
        console.error(err);
        toast.error('Failed to save options');
      } finally {
        setIsSaving(false);
      }
    },
  });

  const handleRemoveMember = async (memberId: string) => {
    try {
      const { error } = await supabase.from('workspace_members').delete().eq('id', memberId);
      if (error) throw error;
      toast.success('Member removed');
      refetchMembers();
    } catch (error) {
      console.error('Error removing member:', error);
      toast.error('Failed to remove member');
    }
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'admin': return t('workspace.admin');
      case 'editor': return t('workspace.editor');
      case 'viewer': return t('workspace.viewer');
      default: return role;
    }
  };

  const body = (
    <div className={embedded ? '' : 'p-6'}>
      <Tabs defaultValue={defaultTab}>
          <TabsList className="mb-6">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="gap-2">
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* General Settings */}
          <TabsContent value="profile" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('workspace.details')}</CardTitle>
                <CardDescription>{t('workspace.basic_info')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="workspace-name">{t('workspace.name')}</Label>
                  <Input
                    id="workspace-name"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    disabled={!canEdit}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">{t('workspace.default_timezone')}</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger id="timezone" disabled={!canEdit}>
                      <SelectValue placeholder="Select timezone" />
                    </SelectTrigger>
                    <SelectContent>
                      {timezones.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>
                          {tz.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('workspace.timezone_desc')}</p>
                </div>
                <Button variant="accent" onClick={handleSaveGeneral} disabled={!canEdit || isSaving}>
                  {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                  {isSaving ? t('workspace.saving') : t('workspace.save_changes')}
                </Button>
                {!canEdit && <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Users — member list + approval roles (hidden for single-user workspaces) */}
          {canManageMembers && (
            <TabsContent value="users" className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>{t('workspace.team_members')}</CardTitle>
                      <CardDescription>{t('workspace.manage_access')}</CardDescription>
                    </div>
                    <Button variant="accent" onClick={() => setInviteDialogOpen(true)}>
                      <UserPlus className="h-4 w-4 mr-2" />
                      {t('workspace.invite_member')}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {membersLoading ? (
                    <div className="space-y-4">
                      {[...Array(3)].map((_, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <Skeleton className="h-10 w-10 rounded-full" />
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-3 w-48" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : !members || members.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
                      <p>{t('workspace.no_members')}</p>
                      <p className="text-sm">{t('workspace.only_one')}</p>
                    </div>
                  ) : members.length === 1 ? (
                    // Single-user simplification: show Admin role only, hide role configuration
                    <div>
                      <div className="flex items-center justify-between py-4">
                        <div className="flex items-center gap-3">
                          <Avatar>
                            <AvatarFallback>
                              {members[0].name.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium">{members[0].name}</p>
                            <p className="text-sm text-muted-foreground">{members[0].email}</p>
                          </div>
                        </div>
                        <Badge variant="default" className="flex items-center gap-1">
                          <Crown className="h-3 w-3" />
                          Admin
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Add team members to configure roles and approval workflows.
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {members.map((member, index) => (
                        <div
                          key={member.id}
                          className={cn(
                            'flex items-center justify-between py-4 animate-fade-up',
                            index === 0 && 'pt-0'
                          )}
                          style={{ animationDelay: `${index * 50}ms` }}
                        >
                          <div className="flex items-center gap-3">
                            <Avatar>
                              <AvatarFallback>
                                {member.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium">{member.name}</p>
                              <p className="text-sm text-muted-foreground">{member.email}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {member.user_id === workspace?.ownerId ? (
                              <Badge variant="default" className="flex items-center gap-1">
                                <Crown className="h-3 w-3" />
                                {t('workspace.owner')}
                              </Badge>
                            ) : (
                              <>
                                <MemberRoleSelect
                                  memberId={member.id}
                                  currentRole={member.role as WorkspaceRole}
                                  onRoleChanged={() => refetchMembers()}
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleRemoveMember(member.id)}
                                  className="text-destructive hover:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {pendingInvites.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Pending Invitations</CardTitle>
                    <CardDescription>Invitations that have not yet been accepted.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <PendingInvitesList invites={pendingInvites} onRefresh={refetchPending} />
                  </CardContent>
                </Card>
              )}

              {/* Approval Roles — only shown when multiple members exist */}
              {members && members.length > 1 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Approval Chain</CardTitle>
                    <CardDescription>
                      Assign one approver to each step. Lease requests flow through Manager Approval first, then Financial Approval before execution.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    {/* Approval chain slots */}
                    {membersLoading || !rolesLoaded ? (
                      <div className="space-y-3">
                        <Skeleton className="h-16 w-full rounded-lg" />
                        <Skeleton className="h-16 w-full rounded-lg" />
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {(
                          [
                            { role: 'manager_approver' as const, step: 'Step 1', label: 'Manager Approval', assignedId: managerApproverId },
                            { role: 'financial_approver' as const, step: 'Step 2', label: 'Financial Approval', assignedId: financialApproverId },
                          ]
                        ).map(({ role, step, label, assignedId }) => {
                          const assignedMember = members.find((m) => m.user_id === assignedId);
                          const assignedInitials = assignedMember?.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2) ?? '';
                          return (
                            <div key={role} className="flex items-center justify-between gap-4 rounded-lg border p-4">
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="flex-shrink-0">
                                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{step}</p>
                                  <p className="text-sm font-medium">{label}</p>
                                </div>
                                {assignedMember ? (
                                  <div className="flex items-center gap-2 ml-2">
                                    <Avatar className="h-7 w-7">
                                      <AvatarFallback className="text-xs">{assignedInitials}</AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium truncate">{assignedMember.name}</p>
                                      <p className="text-xs text-muted-foreground truncate">{assignedMember.email}</p>
                                    </div>
                                  </div>
                                ) : (
                                  <p className="text-sm text-muted-foreground ml-2 italic">No approver assigned</p>
                                )}
                              </div>
                              {canEdit && (
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  <Select
                                    value={assignedId ?? ''}
                                    onValueChange={(val) => assignApproverRole(role, val || null)}
                                  >
                                    <SelectTrigger className="h-8 text-xs w-[160px]">
                                      <SelectValue placeholder={assignedMember ? 'Change' : 'Assign'} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {members.map((m) => {
                                        const initials = m.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2);
                                        return (
                                          <SelectItem key={m.user_id} value={m.user_id}>
                                            <div className="flex items-center gap-2">
                                              <Avatar className="h-5 w-5">
                                                <AvatarFallback className="text-xs leading-none">{initials}</AvatarFallback>
                                              </Avatar>
                                              <span>{m.name}</span>
                                            </div>
                                          </SelectItem>
                                        );
                                      })}
                                    </SelectContent>
                                  </Select>
                                  {assignedId && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                      onClick={() => assignApproverRole(role, null)}
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {!hasFinancialApprover && rolesLoaded && (
                          <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/20 dark:border-amber-700">
                            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                            <p className="text-xs text-amber-700 dark:text-amber-400">
                              No Financial Approver assigned — commitments will stall after manager approval.
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Member roles: submitter + admin */}
                    <div>
                      <p className="text-sm font-medium mb-1">Other Roles</p>
                      <p className="text-xs text-muted-foreground mb-3">Control who can submit lease requests and who has admin access.</p>
                      {membersLoading || !rolesLoaded ? (
                        <div className="space-y-3">
                          {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
                        </div>
                      ) : (
                        <div className="divide-y divide-border rounded-lg border">
                          <div className="hidden sm:grid grid-cols-[1fr_100px_100px] gap-4 px-3 pb-2 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            <span>Member</span>
                            <span className="text-center">Submitter</span>
                            <span className="text-center">Admin</span>
                          </div>
                          {members.map((member) => {
                            const roles = memberRoles[member.user_id] || new Set<FunctionalRole>();
                            const isOwner = member.user_id === workspace?.ownerId;
                            const initials = member.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2);
                            return (
                              <div key={member.id} className="grid grid-cols-1 sm:grid-cols-[1fr_100px_100px] gap-3 sm:gap-4 items-center px-3 py-3">
                                <div className="flex items-center gap-3">
                                  <Avatar className="h-7 w-7">
                                    <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                                  </Avatar>
                                  <div>
                                    <p className="text-sm font-medium">{member.name}</p>
                                    <p className="text-xs text-muted-foreground">{member.email}</p>
                                  </div>
                                </div>
                                {isOwner ? (
                                  <div className="sm:col-span-2 flex items-center">
                                    <Badge variant="default" className="flex items-center gap-1 text-xs">
                                      <Crown className="h-3 w-3" />
                                      Owner — all roles
                                    </Badge>
                                  </div>
                                ) : (
                                  <div className="flex gap-6 sm:contents">
                                    {(['submitter', 'admin'] as const).map((role) => (
                                      <div key={role} className="flex sm:justify-center items-center gap-2">
                                        <span className="text-xs text-muted-foreground sm:hidden capitalize">{role}:</span>
                                        <Checkbox
                                          checked={roles.has(role)}
                                          onCheckedChange={() => { if (canEdit) toggleFunctionalRole(member.user_id, role); }}
                                          disabled={!canEdit}
                                        />
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      <Button
                        variant="accent"
                        onClick={handleSaveRoles}
                        disabled={!canEdit || isSavingRoles}
                      >
                        {isSavingRoles ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4 mr-2" />
                        )}
                        {isSavingRoles ? 'Saving…' : 'Save Roles'}
                      </Button>
                      {!canEdit && <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          )}

          {/* Notifications */}
          {canAccessDefaults && (
            <TabsContent value="notifications" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t('workspace.notification_settings')}</CardTitle>
                  <CardDescription>{t('workspace.notification_timing')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="notification-days">{t('workspace.reminder_days')}</Label>
                    <Input
                      id="notification-days"
                      type="number"
                      value={notificationDays}
                      onChange={(e) => setNotificationDays(e.target.value)}
                      min="1"
                      max="365"
                      disabled={!canEdit}
                    />
                    <p className="text-xs text-muted-foreground">{t('workspace.reminder_desc')}</p>
                  </div>
                  <Button
                    variant="accent"
                    onClick={handleSaveNotifications}
                    disabled={!canEdit || isSavingNotifications}
                  >
                    {isSavingNotifications ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    {isSavingNotifications ? t('workspace.saving') : t('workspace.save_changes')}
                  </Button>
                  {!canEdit && <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* Financial */}
          {canAccessDefaults && (
            <TabsContent value="financial" className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <CardTitle>Financial Configuration</CardTitle>
                      <CardDescription>
                        These values feed into lease liability calculations and approval routing.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="discount-rate">Incremental Borrowing Rate (%)</Label>
                    <div className="relative">
                      <Input
                        id="discount-rate"
                        type="number"
                        min={0}
                        step="0.1"
                        value={discountRate}
                        onChange={(e) => setDiscountRate(e.target.value)}
                        disabled={!canEdit}
                        className="pr-8"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Incremental borrowing rate used for lease liability calculations. Default: 5.5%.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="covenant-threshold">Lease Liability Alert ($)</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                      <Input
                        id="covenant-threshold"
                        type="number"
                        min={0}
                        step="1000"
                        value={covenantThreshold}
                        onChange={(e) => setCovenantThreshold(e.target.value)}
                        disabled={!canEdit}
                        placeholder="Optional"
                        className="pl-7"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Total portfolio lease liability limit. Commitments that exceed this threshold trigger a portfolio risk alert.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="approval-threshold">Approval Threshold ($)</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                      <Input
                        id="approval-threshold"
                        type="number"
                        min={0}
                        step="1000"
                        value={approvalThreshold}
                        onChange={(e) => setApprovalThreshold(e.target.value)}
                        disabled={!canEdit}
                        placeholder="0"
                        className="pl-7"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Commitments with total cash commitment above this amount require Financial Approver review. Set to 0 to require review for all.
                    </p>
                  </div>

                  <Button
                    variant="accent"
                    onClick={handleSaveFinancial}
                    disabled={!canEdit || isSavingFinancial}
                  >
                    {isSavingFinancial ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    {isSavingFinancial ? t('workspace.saving') : 'Save Financial Config'}
                  </Button>
                  {!canEdit && <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>}
                </CardContent>
              </Card>
            </TabsContent>
          )}
          {/* Lease Configuration — admin only */}
          {isAdmin && (
            <TabsContent value="lease_config" className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Settings2 className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <CardTitle>Asset Types</CardTitle>
                      <CardDescription>
                        Configure the list of asset types available when classifying leases.
                        These are used by the AI during extraction to classify the asset.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    {assetTypeConfig.map((type) => (
                      <div key={type} className="flex items-center justify-between rounded-md border px-3 py-2">
                        <span className="text-sm">{type}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveAssetType(type)}
                        >
                          <X size={12} />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Add new asset type..."
                      value={newAssetType}
                      onChange={(e) => setNewAssetType(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddAssetType(); } }}
                      className="text-sm"
                    />
                    <Button variant="outline" size="sm" onClick={handleAddAssetType} disabled={!newAssetType.trim()}>
                      <Plus size={14} className="mr-1" />
                      Add
                    </Button>
                  </div>
                  <Button
                    variant="accent"
                    onClick={handleSaveAssetTypes}
                    disabled={isSavingAssetTypes}
                  >
                    {isSavingAssetTypes ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    {isSavingAssetTypes ? 'Saving…' : 'Save Asset Types'}
                  </Button>
                </CardContent>
              </Card>

              {/* Departments */}
              {(['Departments', 'Regions', 'Locations', 'Buildings'] as const).map((label) => {
                const configs: Record<string, { options: string[]; newVal: string; setOptions: Dispatch<SetStateAction<string[]>>; setNew: Dispatch<SetStateAction<string>>; isSaving: boolean; setIsSaving: Dispatch<SetStateAction<boolean>>; dbColumn: string }> = {
                  Departments: { options: departmentOptions, newVal: newDepartmentOption, setOptions: setDepartmentOptions, setNew: setNewDepartmentOption, isSaving: isSavingDepartments, setIsSaving: setIsSavingDepartments, dbColumn: 'department_options' },
                  Regions:     { options: regionOptions,     newVal: newRegionOption,     setOptions: setRegionOptions,     setNew: setNewRegionOption,     isSaving: isSavingRegions,     setIsSaving: setIsSavingRegions,     dbColumn: 'region_options' },
                  Locations:   { options: locationOptions,   newVal: newLocationOption,   setOptions: setLocationOptions,   setNew: setNewLocationOption,   isSaving: isSavingLocations,   setIsSaving: setIsSavingLocations,   dbColumn: 'location_options' },
                  Buildings:   { options: buildingOptions,   newVal: newBuildingOption,   setOptions: setBuildingOptions,   setNew: setNewBuildingOption,   isSaving: isSavingBuildings,   setIsSaving: setIsSavingBuildings,   dbColumn: 'building_options' },
                };
                const cfg = configs[label];
                const handlers = makeOptionListHandlers(cfg.options, cfg.setOptions, cfg.setNew, cfg.setIsSaving, cfg.dbColumn);
                return (
                  <Card key={label}>
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <Settings2 className="h-5 w-5 text-muted-foreground" />
                        <div>
                          <CardTitle>{label}</CardTitle>
                          <CardDescription>
                            Configure the available options for the {label.toLowerCase().slice(0, -1)} field on leases. Users can also type a custom value.
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        {cfg.options.map((item) => (
                          <div key={item} className="flex items-center justify-between rounded-md border px-3 py-2">
                            <span className="text-sm">{item}</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-destructive"
                              onClick={() => handlers.handleRemove(item)}
                            >
                              <X size={12} />
                            </Button>
                          </div>
                        ))}
                        {cfg.options.length === 0 && (
                          <p className="text-xs text-muted-foreground">No options configured — the field will accept free text.</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder={`Add new ${label.toLowerCase().slice(0, -1)}…`}
                          value={cfg.newVal}
                          onChange={(e) => cfg.setNew(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlers.handleAdd(cfg.newVal); } }}
                          className="text-sm"
                        />
                        <Button variant="outline" size="sm" onClick={() => handlers.handleAdd(cfg.newVal)} disabled={!cfg.newVal.trim()}>
                          <Plus size={14} className="mr-1" />
                          Add
                        </Button>
                      </div>
                      <Button
                        variant="accent"
                        onClick={() => handlers.handleSave(cfg.options)}
                        disabled={cfg.isSaving}
                      >
                        {cfg.isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                        {cfg.isSaving ? 'Saving…' : `Save ${label}`}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </TabsContent>
          )}

          {/* Risk Watchlist — workspace-scoped templates the AI uses on every
              future abstraction. Visible to anyone with edit permission. */}
          {canEdit && workspace?.id && (
            <TabsContent value="risk_watchlist" className="space-y-6">
              <RiskWatchlistManager workspaceId={workspace.id} />
            </TabsContent>
          )}

          {/* Onboarding — admin only */}
          {isAdmin && (
            <TabsContent value="onboarding" className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Package className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <CardTitle>Historical Portfolio Loader</CardTitle>
                      <CardDescription>
                        Enable a simplified form for loading existing leases during onboarding.
                        Turn off when your portfolio is loaded.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label>Portfolio Loader</Label>
                      <p className="text-xs text-muted-foreground">
                        When enabled, shows the historical portfolio intake form to workspace members.
                      </p>
                    </div>
                    <Switch
                      checked={backdoorEnabled}
                      onCheckedChange={(value) => handleSaveBackdoor(value)}
                      disabled={isSavingBackdoor}
                      aria-label="Enable historical portfolio loader"
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </div>
  );

  return (
    <>
      {embedded ? (
        body
      ) : (
        <AppLayout>
          <AppHeader title={t('workspace.title')} subtitle={t('workspace.subtitle')} />
          {body}
        </AppLayout>
      )}
      {workspace && canManageMembers && (
        <InviteMemberDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          workspaceId={workspace.id}
          onInviteSent={() => { refetchMembers(); refetchPending(); }}
        />
      )}
    </>
  );
}
