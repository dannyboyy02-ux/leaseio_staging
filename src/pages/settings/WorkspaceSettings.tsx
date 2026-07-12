import { useState, useEffect, useCallback, type Dispatch, type SetStateAction } from 'react';
import { Save, Loader2, Crown, TrendingUp, AlertTriangle, Package, Settings2, Plus, X, GitBranch, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent } from '@/components/ui/tabs';
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
import { assetAbbreviation } from '@/lib/assetTypes';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { MembersPanel, useWorkspaceMembers } from '@/components/workspace/MembersPanel';
import { WorkspaceRole } from '@/types';
import type { FunctionalRole } from '@/types/lifecycle';
import { Link } from 'react-router-dom';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
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

interface WorkspaceSettingsProps {
  /** The visible section id — controlled by the parent. The sole consumer
   *  is the /app/settings/workspaces drill-down (WorkspacesSection), whose
   *  rail owns navigation; this component renders only the section panels.
   *  (The old standalone page mode + internal tab strip were removed when
   *  the route became a redirect — 2026-06 Claude-alignment pass.) */
  activeSection: string;
}

export default function WorkspaceSettings({ activeSection }: WorkspaceSettingsProps) {
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
  // Phase 5 — counter-signature window default. Workspace-level setting
  // that drives the due date computed when a lease enters
  // pending_counter_signature.
  const [counterSignatureDueDays, setCounterSignatureDueDays] = useState('21');
  const [isSavingCounterSignature, setIsSavingCounterSignature] = useState(false);

  // Phase 2 — functional roles state: map of user_id → Set<FunctionalRole>
  const [memberRoles, setMemberRoles] = useState<Record<string, Set<FunctionalRole>>>({});
  const [rolesLoaded, setRolesLoaded] = useState(false);

  // Review-threshold state (housed under Approval Rules since the
  // Financial tab was dissolved; discount rate lives on /app/reports).
  const [covenantThreshold, setCovenantThreshold] = useState('');
  const [approvalThreshold, setApprovalThreshold] = useState('0');

  // Lease configuration state
  const [assetTypeConfig, setAssetTypeConfig] = useState<string[]>(['Real Estate', 'Equipment', 'Vehicle', 'Other']);
  // Label -> abbreviation map (e.g. { "Real Estate": "RE" }). Loaded tolerantly
  // below so a pre-migration deploy (column absent) degrades to built-in defaults.
  const [assetTypeAbbr, setAssetTypeAbbr] = useState<Record<string, string>>({});
  const [newAssetType, setNewAssetType] = useState('');
  const [isSavingAssetTypes, setIsSavingAssetTypes] = useState(false);

  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await (supabase as any)
        .from('workspaces')
        .select('asset_type_abbreviations')
        .eq('id', workspace.id)
        .single();
      if (cancelled || error || !data) return; // column may not exist yet → keep {}
      const abbr = data.asset_type_abbreviations;
      if (abbr && typeof abbr === 'object' && !Array.isArray(abbr)) {
        setAssetTypeAbbr(abbr as Record<string, string>);
      }
    })();
    return () => { cancelled = true; };
  }, [workspace?.id]);

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
  // KNOWN_ISSUES #5 fix: workspace owners (userRole === 'owner') were
  // excluded from the three admin-gated tabs because of a literal
  // string check here. canEditWorkspaceSettings normalizes 'owner' to
  // 'admin', so use it for the gate.
  const isAdmin = canEditWorkspaceSettings(userRole);

  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.name || '');
      setTimezone(workspace.timezone || 'America/New_York');
      setNotificationDays(String(workspace.defaultNotificationDays || 90));
    }
  }, [workspace]);

  // Phase 5 — load counter_signature_default_due_days for this workspace.
  // Not on the WorkspaceBasic context shape (yet), so fetched directly.
  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('workspaces')
        .select('counter_signature_default_due_days')
        .eq('id', workspace.id)
        .maybeSingle();
      if (cancelled) return;
      const v = (data as any)?.counter_signature_default_due_days;
      if (typeof v === 'number') setCounterSignatureDueDays(String(v));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  // Load financial settings from workspaces table
  useEffect(() => {
    if (!workspace?.id) return;
    supabase
      .from('workspaces')
      .select('covenant_threshold, approval_threshold, backdoor_enabled, asset_type_config, department_options, region_options, location_options, building_options')
      .eq('id', workspace.id)
      .single()
      .then(({ data }) => {
        if (data) {
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

  // Load functional roles from workspace_roles table. Extracted so the save
  // handler can re-sync the UI to the true persisted state after a failure.
  const loadRoles = useCallback(async () => {
    if (!workspace?.id) return;
    const { data } = await (supabase as any)
      .from('workspace_roles')
      .select('user_id, role')
      .eq('workspace_id', workspace.id);
    const map: Record<string, Set<FunctionalRole>> = {};
    for (const row of (data as Array<{ user_id: string; role: string }> | null) || []) {
      if (!map[row.user_id]) map[row.user_id] = new Set();
      map[row.user_id].add(row.role as FunctionalRole);
    }
    setMemberRoles(map);
    setRolesLoaded(true);
  }, [workspace?.id]);

  useEffect(() => { void loadRoles(); }, [loadRoles]);

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
      // Atomic replace via RPC — the delete + re-insert happen in one
      // transaction server-side, so a failed insert can no longer leave the
      // workspace with all functional roles wiped (audit D3).
      const assignments: Array<{ user_id: string; role: FunctionalRole }> = [];
      for (const [userId, roles] of Object.entries(memberRoles)) {
        for (const role of roles) {
          assignments.push({ user_id: userId, role });
        }
      }

      const { error } = await (supabase as any).rpc('set_workspace_roles', {
        p_workspace_id: workspace.id,
        p_assignments: assignments,
      });
      if (error) throw error;

      toast.success('Team roles saved');
    } catch (error) {
      console.error('Error saving roles:', error);
      toast.error("Couldn't save team roles — no changes were applied. Please try again.");
      // The atomic RPC left the stored roles untouched on failure; re-sync the
      // UI to that true state instead of leaving the optimistic edits showing.
      await loadRoles();
    } finally {
      setIsSavingRoles(false);
    }
  };

  // OWM Checkpoint 2: members query lives in MembersPanel; the
  // re-exported hook here keeps the roster available for the Approval
  // Roles section below. TanStack dedupes by query key.
  const {
    data: members,
    isLoading: membersLoading,
  } = useWorkspaceMembers(workspace?.id);

  const handleSaveGeneral = async () => {
    if (!canEdit) { toast.error(t('workspace.read_only')); return; }
    if (!workspace?.id) { toast.error('No workspace found'); return; }
    setIsSaving(true);
    try {
      // #70 defense-in-depth: .select() so an RLS-blocked 0-row update surfaces
      // as an error rather than a false "saved". #87: timezone is a config
      // column frozen by the read-only guard on a non-live (grace/Vault)
      // workspace; if the bundled update is rejected, retry the rename alone so
      // it isn't blocked as collateral (name stays editable — owner-rename
      // carve-out).
      const { data, error } = await supabase
        .from('workspaces')
        .update({ name: workspaceName.trim(), timezone })
        .eq('id', workspace.id)
        .select('id');
      if (error) {
        const retry = await supabase
          .from('workspaces')
          .update({ name: workspaceName.trim() })
          .eq('id', workspace.id)
          .select('id');
        if (retry.error || !retry.data?.length) throw error;
        if (refreshProfile) await refreshProfile();
        toast.warning('Name saved — other settings are read-only on this workspace.');
        return;
      }
      if (!data?.length) throw new Error('no_rows');
      if (refreshProfile) await refreshProfile();
      toast.success('Workspace settings saved!');
    } catch (error) {
      console.error('Error saving workspace:', error);
      toast.error(
        error instanceof Error && error.message === 'no_rows'
          ? 'You do not have permission to change these settings.'
          : 'Failed to save workspace settings',
      );
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

  // Phase 5 — save counter-signature window. Persists
  // workspaces.counter_signature_default_due_days; act-on-chain-step
  // reads this when computing counter_signature_due_date at signator
  // approve. CHECK constraint enforces 1..365 server-side.
  const handleSaveCounterSignature = async () => {
    if (!canEdit) {
      toast.error(t('workspace.read_only'));
      return;
    }
    if (!workspace?.id) {
      toast.error('No workspace found');
      return;
    }
    const days = parseInt(counterSignatureDueDays, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      toast.error('Counter-signature window must be between 1 and 365 days.');
      return;
    }
    setIsSavingCounterSignature(true);
    try {
      const { error } = await (supabase as any)
        .from('workspaces')
        .update({ counter_signature_default_due_days: days })
        .eq('id', workspace.id);
      if (error) throw error;
      toast.success('Counter-signature window saved.');
    } catch (error) {
      console.error('Error saving counter-signature window:', error);
      toast.error('Failed to save counter-signature window');
    } finally {
      setIsSavingCounterSignature(false);
    }
  };

  // Saves the two review thresholds (now housed under Approval Rules).
  // The discount rate is saved separately by DiscountRateCard on
  // /app/reports, which also owns the lease-financials recompute.
  const handleSaveThresholds = async () => {
    if (!canEdit) { toast.error(t('workspace.read_only')); return; }
    if (!workspace?.id) { toast.error('No workspace found'); return; }
    setIsSavingFinancial(true);
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({
          covenant_threshold: covenantThreshold ? parseFloat(covenantThreshold) : null,
          approval_threshold: parseFloat(approvalThreshold) || 0,
        } as any)
        .eq('id', workspace.id);
      if (error) throw error;
      toast.success('Review thresholds saved!');
    } catch (error) {
      console.error('Error saving review thresholds:', error);
      toast.error('Failed to save review thresholds');
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
    setAssetTypeAbbr(prev => {
      const next = { ...prev };
      delete next[type];
      return next;
    });
  };

  const handleSaveAssetTypes = async () => {
    if (!workspace?.id) return;
    setIsSavingAssetTypes(true);
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({ asset_type_config: assetTypeConfig, asset_type_abbreviations: assetTypeAbbr } as any)
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

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'admin': return t('workspace.admin');
      case 'editor': return t('workspace.editor');
      case 'viewer': return t('workspace.viewer');
      default: return role;
    }
  };

  return (
    <div>
      <Tabs value={activeSection}>

          {/* General Settings */}
          <TabsContent value="profile" className="space-y-6">
            {/* D4: plan + billing are workspace-scoped but edited from Account →
                Billing; signpost it here so admins don't hunt for plan controls
                in Workspace settings. */}
            <Card>
              <CardContent className="py-3 px-4 flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm text-muted-foreground">{t('workspace.plan_billing_signpost')}</p>
                <Button variant="outline" size="sm" asChild>
                  <Link to="/app/settings/account?tab=billing">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    {t('workspace.go_to_billing')}
                  </Link>
                </Button>
              </CardContent>
            </Card>
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
          {canManageMembers && workspace?.id && (
            <TabsContent value="users" className="space-y-6">
              {/* Member management extracted to MembersPanel during OWM
                  Checkpoint 2 — same component is reused on
                  the My Workspaces panel for non-active workspaces. */}
              <MembersPanel
                workspaceId={workspace.id}
                ownerId={workspace.ownerId}
                canManage={canManageMembers}
              />


              {/* Approval Roles — only shown when multiple members exist */}
              {members && members.length > 1 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Default approvers</CardTitle>
                    <CardDescription>
                      The fallback chain: Manager Approval, then Financial Approval. It routes a
                      lease request only when no Approval Rule matches it.
                    </CardDescription>
                    {/* Live walkthrough 2026-07-12: this legacy editor read as THE
                        approval setup while the real routing engine (Approval
                        Rules) hid behind a bounce link — admins configured this
                        and thought they were done. Name the relationship and put
                        a door to the rules right here. */}
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      <span>
                        Want different approvers by asset type, department, or deal size? That's an
                        Approval Rule — rules always run before this default chain.
                      </span>
                      <Link
                        to="/app/settings/workspaces/approval_policies"
                        className="font-medium text-primary hover:underline"
                      >
                        Set up Approval Rules →
                      </Link>
                    </div>
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
                      <p className="text-sm font-medium mb-1">Workflow roles</p>
                      <p className="text-xs text-muted-foreground mb-3">
                        Submitter: can create and submit lease requests. Admin: full workspace
                        administration — the same Admin as the access level in Team Members above.
                      </p>
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
                                          onCheckedChange={() => { if (canEdit && !isSavingRoles) toggleFunctionalRole(member.user_id, role); }}
                                          disabled={!canEdit || isSavingRoles}
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
                        Set a short abbreviation (e.g. RE, EQP) to keep the Leases table tight —
                        leave it blank to use the built-in default.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    {assetTypeConfig.map((type) => (
                      <div key={type} className="flex items-center gap-2 rounded-md border px-3 py-2">
                        <span className="flex-1 truncate text-sm">{type}</span>
                        <Input
                          value={assetTypeAbbr[type] ?? ''}
                          onChange={(e) =>
                            setAssetTypeAbbr((prev) => ({
                              ...prev,
                              [type]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5),
                            }))
                          }
                          placeholder={assetAbbreviation(type)}
                          aria-label={`${type} abbreviation`}
                          maxLength={5}
                          className="h-7 w-20 text-center text-xs"
                        />
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

          {/* Approval Rules — admin only. Settings sub-routes aren't
              exposed by the main sidebar; this tab is the admin's entry
              point to /app/settings/approval-policies. */}
          {isAdmin && (
            <TabsContent value="approval_policies" className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <CardTitle>Approval Rules</CardTitle>
                      <CardDescription>
                        Rules decide who approves each lease request — by asset type, department,
                        dollar size, or region. The first matching rule runs its approver chain;
                        when nothing matches, the Default approvers on the Members page take over.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Button asChild>
                    <Link to="/app/settings/approval-policies">
                      <ExternalLink className="h-4 w-4 mr-1.5" />
                      Manage rules
                    </Link>
                  </Button>
                  {/* Live walkthrough 2026-07-12: this section opened on a bounce
                      button with no hint of what exists — say what you'll find. */}
                  <p className="text-xs text-muted-foreground">
                    View, reorder, and edit your rules — including the plain-language rule builder
                    with a sample-request tester.
                  </p>
                </CardContent>
              </Card>

              {/* Review thresholds — moved here from the dissolved Financial
                  tab. Both values decide WHEN a lease request requires
                  financial review, so they belong with the approval rules.
                  (The discount rate moved to Report Settings on /app/reports.) */}
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <CardTitle>Review Thresholds</CardTitle>
                      <CardDescription>
                        Dollar limits that trigger financial review for new lease requests.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
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

                  <Button
                    variant="accent"
                    onClick={handleSaveThresholds}
                    disabled={!canEdit || isSavingFinancial}
                  >
                    {isSavingFinancial ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    {isSavingFinancial ? t('workspace.saving') : 'Save Thresholds'}
                  </Button>
                  {!canEdit && <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>}

                  {/* Signpost for the dissolved Financial tab's third field —
                      "where did the discount rate go?" is the predictable
                      first question after this IA change. */}
                  <p className="text-xs text-muted-foreground border-t border-border pt-3">
                    Looking for the discount rate? It now lives in{' '}
                    <Link to="/app/reports" className="text-primary hover:underline">
                      Report settings
                    </Link>{' '}
                    on the Reports page.
                  </p>
                </CardContent>
              </Card>

              {/* Phase 5 — counter-signature window default. Lives with the
                  approval rules (it's chain configuration, not a personal
                  notification preference). */}
              <Card>
                <CardHeader>
                  <CardTitle>Counter-Signature Window</CardTitle>
                  <CardDescription>
                    Default number of days from signator approval until the
                    counter-signed document is expected. Reminders fire 7 days
                    before, on the due date, and at 7 / 14 / 28 days overdue.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="counter-signature-days">
                      Default counter-signature window (days)
                    </Label>
                    <Input
                      id="counter-signature-days"
                      type="number"
                      value={counterSignatureDueDays}
                      onChange={(e) => setCounterSignatureDueDays(e.target.value)}
                      min={1}
                      max={365}
                      disabled={!canEdit}
                    />
                    <p className="text-xs text-muted-foreground">
                      Must be between 1 and 365 days. Default: 21.
                    </p>
                  </div>
                  <Button
                    variant="accent"
                    onClick={handleSaveCounterSignature}
                    disabled={!canEdit || isSavingCounterSignature}
                  >
                    {isSavingCounterSignature ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    {isSavingCounterSignature ? t('workspace.saving') : t('workspace.save_changes')}
                  </Button>
                  {!canEdit && (
                    <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>
                  )}
                </CardContent>
              </Card>
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
}
