import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction, type ComponentType, type ReactNode } from 'react';
import { Loader2, Crown, TrendingUp, AlertTriangle, Package, Settings2, Plus, X, GitBranch, ExternalLink, Check, Building2, Bell, PenLine, Users, Eye } from 'lucide-react';
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
  { value: 'America/Phoenix', label: 'Arizona (no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HST)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central European (CET)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AET)' },
  { value: 'America/Sao_Paulo', label: 'São Paulo (BRT)' },
];

// ── Autosave status ─────────────────────────────────────────────────────
// This surface saves every change automatically (selects/checkboxes persist
// on change, text inputs on blur) — one persistence model for the whole page,
// replacing the old mix of per-card Save buttons and instant-saving controls.
// The chip is the per-card confirmation; failures toast AND revert the field.

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

function SaveStatusChip({ status }: { status: SaveStatus | undefined }) {
  if (!status || status === 'idle') return null;
  if (status === 'saving') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" role="status">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    );
  }
  if (status === 'saved') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" role="status">
        <Check className="h-3 w-3" /> Saved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-destructive" role="status">
      <AlertTriangle className="h-3 w-3" /> Not saved
    </span>
  );
}

/** Card header with an icon + right-aligned autosave chip — the single
 *  treatment for every section card on this surface (design-system
 *  consistency: no more icon-vs-plain header drift). */
function SectionCardHeader({
  icon: Icon,
  title,
  description,
  status,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  status?: SaveStatus;
  children?: ReactNode;
}) {
  return (
    <CardHeader>
      <div className="flex items-start gap-2">
        <Icon className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <div className="shrink-0 pt-1">
          <SaveStatusChip status={status} />
        </div>
      </div>
      {children}
    </CardHeader>
  );
}

/** Load-failure callout: the on-screen values are NOT the stored config, so
 *  editing is blocked until a reload succeeds (loader-honesty gate). */
function ConfigLoadErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
      <p className="text-sm text-destructive font-medium">Couldn't load this workspace's configuration.</p>
      <p className="text-xs text-muted-foreground">
        Editing is paused so nothing gets overwritten — your stored settings are safe.
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** Compact view-only callout for members who can see a section but not edit
 *  it — replaces disabled Save buttons (a dead affordance) with an honest
 *  statement of why the fields are locked. */
function ReadOnlyNotice() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Eye className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span>View-only — only workspace admins can change these settings.</span>
    </div>
  );
}

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
  const [backdoorEnabled, setBackdoorEnabled] = useState(false);
  // Phase 5 — counter-signature window default. Workspace-level setting
  // that drives the due date computed when a lease enters
  // pending_counter_signature.
  const [counterSignatureDueDays, setCounterSignatureDueDays] = useState('21');

  // ── Unified autosave plumbing ──────────────────────────────────────────
  // One status entry per card (keys: general/notifications/roles/asset_types/
  // <option column>/thresholds/countersig). `persistedRef` holds the last
  // KNOWN-SAVED value of each field so blur handlers skip no-op writes and
  // failure paths can revert the field instead of showing unsaved state as
  // saved (the old model's silent-data-loss failure).
  const [saveStatus, setSaveStatusMap] = useState<Record<string, SaveStatus>>({});
  const statusTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const setStatus = useCallback((key: string, s: SaveStatus, clearAfterMs?: number) => {
    if (statusTimers.current[key]) clearTimeout(statusTimers.current[key]);
    setSaveStatusMap((prev) => ({ ...prev, [key]: s }));
    if (clearAfterMs) {
      statusTimers.current[key] = setTimeout(
        () => setSaveStatusMap((prev) => ({ ...prev, [key]: 'idle' })),
        clearAfterMs,
      );
    }
  }, []);
  useEffect(() => () => { Object.values(statusTimers.current).forEach(clearTimeout); }, []);

  const persistedRef = useRef<{
    name: string;
    timezone: string;
    notificationDays: string;
    covenantThreshold: string;
    approvalThreshold: string;
    counterSignatureDueDays: string;
    assetTypeConfig: string[];
    assetTypeAbbr: Record<string, string>;
    lists: Record<string, string[]>;
  }>({
    name: workspace?.name || '',
    timezone: workspace?.timezone || 'America/New_York',
    notificationDays: String(workspace?.defaultNotificationDays || 90),
    covenantThreshold: '',
    approvalThreshold: '0',
    counterSignatureDueDays: '21',
    // MUST mirror the assetTypeConfig state default — a [] baseline made a
    // failed persist revert a never-customized workspace to an EMPTY list,
    // and the next successful add would persist that near-empty config
    // (code audit of 05356d4).
    assetTypeConfig: ['Real Estate', 'Equipment', 'Vehicle', 'Other'],
    assetTypeAbbr: {},
    lists: {},
  });

  // Loader honesty gates (integrity review of 05356d4): the config loaders
  // below seed these cards' state; if a load FAILS, the UI would show
  // built-in defaults over the workspace's real config — and autosave would
  // then persist those defaults on the user's next add/remove/blur,
  // overwriting real data. Writers stay blocked until their loader succeeds.
  const [configLoadState, setConfigLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [configReloadNonce, setConfigReloadNonce] = useState(0);
  const [countersigLoaded, setCountersigLoaded] = useState(false);

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
        persistedRef.current.assetTypeAbbr = abbr as Record<string, string>;
      }
    })();
    return () => { cancelled = true; };
  }, [workspace?.id]);

  const [departmentOptions, setDepartmentOptions] = useState<string[]>([]);
  const [newDepartmentOption, setNewDepartmentOption] = useState('');

  const [regionOptions, setRegionOptions] = useState<string[]>([]);
  const [newRegionOption, setNewRegionOption] = useState('');

  const [locationOptions, setLocationOptions] = useState<string[]>([]);
  const [newLocationOption, setNewLocationOption] = useState('');

  const [buildingOptions, setBuildingOptions] = useState<string[]>([]);
  const [newBuildingOption, setNewBuildingOption] = useState('');

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
      persistedRef.current.name = workspace.name || '';
      persistedRef.current.timezone = workspace.timezone || 'America/New_York';
      persistedRef.current.notificationDays = String(workspace.defaultNotificationDays || 90);
    }
  }, [workspace]);

  // Phase 5 — load counter_signature_default_due_days for this workspace.
  // Not on the WorkspaceBasic context shape (yet), so fetched directly.
  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('workspaces')
        .select('counter_signature_default_due_days')
        .eq('id', workspace.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        // Leave countersigLoaded false — the default '21' on screen is NOT the
        // stored value, so blur-persist stays blocked (loader-honesty gate).
        console.error('Failed to load counter-signature window:', error);
        return;
      }
      const v = (data as any)?.counter_signature_default_due_days;
      if (typeof v === 'number') {
        setCounterSignatureDueDays(String(v));
        persistedRef.current.counterSignatureDueDays = String(v);
      }
      setCountersigLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  // Load financial settings from workspaces table
  useEffect(() => {
    if (!workspace?.id) return;
    setConfigLoadState('loading');
    supabase
      .from('workspaces')
      .select('covenant_threshold, approval_threshold, backdoor_enabled, asset_type_config, department_options, region_options, location_options, building_options')
      .eq('id', workspace.id)
      .single()
      .then(({ data, error }) => {
        if (error || !data) {
          // The defaults on screen are NOT the stored config — block this
          // section's autosave writers so a user action can't persist
          // built-ins over the workspace's real lists (loader-honesty gate).
          console.error('Failed to load workspace configuration:', error);
          setConfigLoadState('error');
          return;
        }
        {
          const cov = (data as any).covenant_threshold != null ? String((data as any).covenant_threshold) : '';
          const appr = String((data as any).approval_threshold ?? 0);
          setCovenantThreshold(cov);
          setApprovalThreshold(appr);
          persistedRef.current.covenantThreshold = cov;
          persistedRef.current.approvalThreshold = appr;
          setBackdoorEnabled((data as any).backdoor_enabled ?? false);
          if (Array.isArray((data as any).asset_type_config) && (data as any).asset_type_config.length > 0) {
            setAssetTypeConfig((data as any).asset_type_config as string[]);
            persistedRef.current.assetTypeConfig = (data as any).asset_type_config as string[];
          }
          for (const [col, set] of [
            ['department_options', setDepartmentOptions],
            ['region_options', setRegionOptions],
            ['location_options', setLocationOptions],
            ['building_options', setBuildingOptions],
          ] as const) {
            if (Array.isArray((data as any)[col])) {
              set((data as any)[col] as string[]);
              persistedRef.current.lists[col] = (data as any)[col] as string[];
            }
          }
          setConfigLoadState('ready');
        }
      });
  }, [workspace?.id, configReloadNonce]);

  // Load functional roles from workspace_roles table. Extracted so the save
  // handler can re-sync the UI to the true persisted state after a failure.
  //
  // INTEGRITY-CRITICAL error handling (review of 05356d4): the RPC persists a
  // FULL-REPLACE of the assignment set, so a silently-failed load that rendered
  // an empty roster would let the user's next single toggle wipe every stored
  // role — with a well-formed audit row. On load failure we keep prior state,
  // flag the error, and block all role writes until a load succeeds.
  const [rolesLoadError, setRolesLoadError] = useState(false);
  const loadRoles = useCallback(async () => {
    if (!workspace?.id) return;
    const { data, error } = await (supabase as any)
      .from('workspace_roles')
      .select('user_id, role')
      .eq('workspace_id', workspace.id);
    if (error) {
      console.error('Failed to load workspace roles:', error);
      setRolesLoadError(true);
      return; // keep whatever state we had; do NOT render a false-empty roster
    }
    const map: Record<string, Set<FunctionalRole>> = {};
    for (const row of (data as Array<{ user_id: string; role: string }> | null) || []) {
      if (!map[row.user_id]) map[row.user_id] = new Set();
      map[row.user_id].add(row.role as FunctionalRole);
    }
    setMemberRoles(map);
    setRolesLoaded(true);
    setRolesLoadError(false);
  }, [workspace?.id]);

  useEffect(() => { void loadRoles(); }, [loadRoles]);

  // Autosave: every role change persists immediately through the atomic
  // set_workspace_roles RPC (full-replace in one transaction — audit D3), so
  // a toggle can never be silently lost by navigating away. On failure the
  // RPC left the stored roles untouched; re-sync the UI to that true state.
  const persistRoles = async (next: Record<string, Set<FunctionalRole>>) => {
    // Never write from a roster that isn't a verified read of the stored
    // state — see the loadRoles integrity note.
    if (!canEdit || !workspace?.id || !rolesLoaded || rolesLoadError) return;
    setStatus('roles', 'saving');
    try {
      const assignments: Array<{ user_id: string; role: FunctionalRole }> = [];
      for (const [userId, roles] of Object.entries(next)) {
        for (const role of roles) {
          assignments.push({ user_id: userId, role });
        }
      }
      const { error } = await (supabase as any).rpc('set_workspace_roles', {
        p_workspace_id: workspace.id,
        p_assignments: assignments,
      });
      if (error) throw error;
      setStatus('roles', 'saved', 2000);
    } catch (error) {
      console.error('Error saving roles:', error);
      setStatus('roles', 'error', 4000);
      toast.error("Couldn't save that role change — it was not applied. Please try again.");
      await loadRoles();
    }
  };

  const rolesSaving = saveStatus['roles'] === 'saving';
  // Controls stay locked until the roster is a verified read (or after a load
  // failure) — matches the persistRoles write gate.
  const rolesWritable = rolesLoaded && !rolesLoadError && !rolesSaving;

  const toggleFunctionalRole = (userId: string, role: FunctionalRole) => {
    if (!rolesWritable) return;
    const next = { ...memberRoles };
    const current = new Set(next[userId] || []);
    if (current.has(role)) current.delete(role);
    else current.add(role);
    next[userId] = current;
    setMemberRoles(next);
    void persistRoles(next);
  };

  // Assign a single approver role (clears existing holder first — one person per step)
  const assignApproverRole = (role: 'manager_approver' | 'financial_approver', userId: string | null) => {
    if (!rolesWritable) return;
    const next: Record<string, Set<FunctionalRole>> = {};
    for (const [uid, roles] of Object.entries(memberRoles)) {
      const updated = new Set(roles);
      updated.delete(role);
      next[uid] = updated;
    }
    if (userId) {
      if (!next[userId]) next[userId] = new Set();
      next[userId].add(role);
    }
    setMemberRoles(next);
    void persistRoles(next);
  };

  const managerApproverId = Object.entries(memberRoles).find(([, r]) => r.has('manager_approver'))?.[0] ?? null;
  const financialApproverId = Object.entries(memberRoles).find(([, r]) => r.has('financial_approver'))?.[0] ?? null;

  const hasFinancialApprover = financialApproverId !== null;

  // OWM Checkpoint 2: members query lives in MembersPanel; the
  // re-exported hook here keeps the roster available for the Approval
  // Roles section below. TanStack dedupes by query key.
  const {
    data: members,
    isLoading: membersLoading,
  } = useWorkspaceMembers(workspace?.id);

  // Generic autosave write for workspaces columns. #70 defense-in-depth:
  // .select('id') so an RLS-blocked 0-row update surfaces as an error rather
  // than a false "Saved". Returns true on success; on failure sets the card's
  // error status + toasts, and the caller reverts the field.
  const persistWorkspace = async (
    key: string,
    patch: Record<string, unknown>,
    friendlyError: string,
  ): Promise<boolean> => {
    if (!canEdit || !workspace?.id) return false;
    setStatus(key, 'saving');
    try {
      const { data, error } = await supabase
        .from('workspaces')
        .update(patch as any)
        .eq('id', workspace.id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('no_rows');
      setStatus(key, 'saved', 2000);
      return true;
    } catch (error) {
      console.error(`Error saving ${key}:`, error);
      setStatus(key, 'error', 4000);
      toast.error(
        error instanceof Error && error.message === 'no_rows'
          ? 'You do not have permission to change these settings.'
          : friendlyError,
      );
      return false;
    }
  };

  // Name persists on blur; timezone on select change. Writing them separately
  // (instead of the old bundled update) means a frozen timezone (#87 — config
  // column locked on a non-live workspace) can't block a rename as collateral.
  const saveName = async () => {
    const name = workspaceName.trim();
    if (!name || name === persistedRef.current.name) {
      if (!name) {
        toast.error("The workspace name can't be empty.");
        setWorkspaceName(persistedRef.current.name);
      }
      return;
    }
    const ok = await persistWorkspace('general', { name }, "Couldn't save the workspace name.");
    if (ok) {
      persistedRef.current.name = name;
      if (refreshProfile) await refreshProfile();
    } else {
      setWorkspaceName(persistedRef.current.name);
    }
  };

  const saveTimezone = async (tz: string) => {
    setTimezone(tz);
    if (tz === persistedRef.current.timezone) return;
    const ok = await persistWorkspace('general', { timezone: tz }, "Couldn't save the timezone — it may be locked on this workspace.");
    if (ok) {
      persistedRef.current.timezone = tz;
      if (refreshProfile) await refreshProfile();
    } else {
      setTimezone(persistedRef.current.timezone);
    }
  };

  const saveNotificationDays = async () => {
    const raw = notificationDays.trim();
    const days = parseInt(raw, 10);
    if (raw === persistedRef.current.notificationDays) return;
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      setStatus('notifications', 'error', 4000);
      toast.error('Reminder days must be between 1 and 365.');
      setNotificationDays(persistedRef.current.notificationDays);
      return;
    }
    const ok = await persistWorkspace('notifications', { default_notification_days: days }, "Couldn't save the reminder setting.");
    if (ok) {
      persistedRef.current.notificationDays = String(days);
      setNotificationDays(String(days));
      if (refreshProfile) await refreshProfile();
    } else {
      setNotificationDays(persistedRef.current.notificationDays);
    }
  };

  // Phase 5 — counter-signature window (act-on-chain-step reads this when
  // computing counter_signature_due_date; CHECK enforces 1..365 server-side).
  const saveCounterSignature = async () => {
    // Loader-honesty gate: never blur-persist the on-screen default over a
    // stored value we failed to read.
    if (!countersigLoaded) return;
    const raw = counterSignatureDueDays.trim();
    if (raw === persistedRef.current.counterSignatureDueDays) return;
    const days = parseInt(raw, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      setStatus('countersig', 'error', 4000);
      toast.error('Counter-signature window must be between 1 and 365 days.');
      setCounterSignatureDueDays(persistedRef.current.counterSignatureDueDays);
      return;
    }
    const ok = await persistWorkspace('countersig', { counter_signature_default_due_days: days }, "Couldn't save the counter-signature window.");
    if (ok) {
      persistedRef.current.counterSignatureDueDays = String(days);
      setCounterSignatureDueDays(String(days));
    } else {
      setCounterSignatureDueDays(persistedRef.current.counterSignatureDueDays);
    }
  };

  // Review thresholds (housed under Approval Rules). The discount rate is
  // saved separately by DiscountRateCard on /app/reports. Validate BEFORE
  // building the patch: JSON serializes NaN/Infinity to null, so an
  // unparseable value would silently CLEAR the threshold in the DB while the
  // chip showed "Saved" (security review of 05356d4).
  const saveThresholds = async () => {
    if (configLoadState !== 'ready') return; // loader-honesty gate
    if (
      covenantThreshold === persistedRef.current.covenantThreshold &&
      approvalThreshold === persistedRef.current.approvalThreshold
    ) return;
    const covenant = covenantThreshold.trim() === '' ? null : parseFloat(covenantThreshold);
    const approval = approvalThreshold.trim() === '' ? 0 : parseFloat(approvalThreshold);
    if (
      (covenant !== null && (!Number.isFinite(covenant) || covenant < 0)) ||
      !Number.isFinite(approval) || approval < 0
    ) {
      setStatus('thresholds', 'error', 4000);
      toast.error('Thresholds must be zero or a positive dollar amount.');
      setCovenantThreshold(persistedRef.current.covenantThreshold);
      setApprovalThreshold(persistedRef.current.approvalThreshold);
      return;
    }
    const ok = await persistWorkspace(
      'thresholds',
      { covenant_threshold: covenant, approval_threshold: approval },
      "Couldn't save the review thresholds.",
    );
    if (ok) {
      // Normalize display to the STORED values so the field never shows ''
      // while the DB holds 0 (display must equal storage).
      const covStr = covenant === null ? '' : String(covenant);
      const apprStr = String(approval);
      setCovenantThreshold(covStr);
      setApprovalThreshold(apprStr);
      persistedRef.current.covenantThreshold = covStr;
      persistedRef.current.approvalThreshold = apprStr;
    } else {
      setCovenantThreshold(persistedRef.current.covenantThreshold);
      setApprovalThreshold(persistedRef.current.approvalThreshold);
    }
  };

  // Routed through persistWorkspace like every other write on this surface
  // (same .select('id') no-rows check + chip; the old bespoke handler was the
  // one write left without them).
  const handleSaveBackdoor = async (value: boolean) => {
    if (configLoadState !== 'ready') return; // loader-honesty gate
    const prev = backdoorEnabled;
    setBackdoorEnabled(value);
    const ok = await persistWorkspace(
      'onboarding',
      { backdoor_enabled: value },
      "Couldn't save the onboarding setting.",
    );
    if (!ok) setBackdoorEnabled(prev);
  };

  // Asset types persist on every add/remove (and abbreviation edits on blur) —
  // the old staged-then-Save model silently lost list edits when the user
  // clicked another rail item before hitting Save.
  const persistAssetTypes = async (nextConfig: string[], nextAbbr: Record<string, string>) => {
    if (configLoadState !== 'ready') return; // loader-honesty gate
    const ok = await persistWorkspace(
      'asset_types',
      { asset_type_config: nextConfig, asset_type_abbreviations: nextAbbr },
      "Couldn't save asset types.",
    );
    if (ok) {
      persistedRef.current.assetTypeConfig = nextConfig;
      persistedRef.current.assetTypeAbbr = nextAbbr;
    } else {
      setAssetTypeConfig(persistedRef.current.assetTypeConfig);
      setAssetTypeAbbr(persistedRef.current.assetTypeAbbr);
    }
  };

  const handleAddAssetType = () => {
    const trimmed = newAssetType.trim();
    if (!trimmed || assetTypeConfig.includes(trimmed)) return;
    const nextConfig = [...assetTypeConfig, trimmed];
    setAssetTypeConfig(nextConfig);
    setNewAssetType('');
    void persistAssetTypes(nextConfig, assetTypeAbbr);
  };

  const handleRemoveAssetType = (type: string) => {
    const prevConfig = assetTypeConfig;
    const prevAbbr = assetTypeAbbr;
    const nextConfig = assetTypeConfig.filter((t) => t !== type);
    const nextAbbr = { ...assetTypeAbbr };
    delete nextAbbr[type];
    setAssetTypeConfig(nextConfig);
    setAssetTypeAbbr(nextAbbr);
    void persistAssetTypes(nextConfig, nextAbbr);
    // Instant-persist removed the old "just don't press Save" safety net —
    // an undo toast is its replacement (restores the abbreviation too).
    toast(`Removed "${type}"`, {
      action: {
        label: 'Undo',
        onClick: () => {
          setAssetTypeConfig(prevConfig);
          setAssetTypeAbbr(prevAbbr);
          void persistAssetTypes(prevConfig, prevAbbr);
        },
      },
    });
  };

  const saveAssetAbbreviations = () => {
    const prev = persistedRef.current.assetTypeAbbr;
    const changed =
      Object.keys({ ...prev, ...assetTypeAbbr }).some((k) => (prev[k] ?? '') !== (assetTypeAbbr[k] ?? ''));
    if (changed) void persistAssetTypes(assetTypeConfig, assetTypeAbbr);
  };

  const makeOptionListHandlers = (
    options: string[],
    setOptions: Dispatch<SetStateAction<string[]>>,
    setNew: Dispatch<SetStateAction<string>>,
    dbColumn: string,
  ) => {
    const persist = async (next: string[]) => {
      if (configLoadState !== 'ready') return; // loader-honesty gate
      setOptions(next);
      const ok = await persistWorkspace(dbColumn, { [dbColumn]: next }, "Couldn't save that change.");
      if (ok) {
        persistedRef.current.lists[dbColumn] = next;
      } else {
        setOptions(persistedRef.current.lists[dbColumn] ?? options);
      }
    };
    return {
      handleAdd: (value: string) => {
        const trimmed = value.trim();
        if (!trimmed || options.includes(trimmed)) return;
        setNew('');
        void persist([...options, trimmed]);
      },
      handleRemove: (item: string) => {
        const prev = options;
        void persist(options.filter((o) => o !== item));
        toast(`Removed "${item}"`, {
          action: { label: 'Undo', onClick: () => void persist(prev) },
        });
      },
    };
  };

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
            {!canEdit && <ReadOnlyNotice />}
            <Card>
              <SectionCardHeader
                icon={Building2}
                title={t('workspace.details')}
                description={t('workspace.basic_info')}
                status={saveStatus['general']}
              />
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="workspace-name">{t('workspace.name')}</Label>
                  <Input
                    id="workspace-name"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    onBlur={() => void saveName()}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    disabled={!canEdit}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">{t('workspace.default_timezone')}</Label>
                  <Select value={timezone} onValueChange={(tz) => void saveTimezone(tz)}>
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
                {canEdit && <p className="text-xs text-muted-foreground">Changes save automatically.</p>}
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
                  <SectionCardHeader
                    icon={Users}
                    title="Default approvers"
                    description="The fallback chain: Manager Approval, then Financial Approval. It routes a lease request only when no Approval Rule matches it."
                    status={saveStatus['roles']}
                  >
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
                  </SectionCardHeader>
                  <CardContent className="space-y-6">
                    {/* Approval chain slots */}
                    {rolesLoadError ? (
                      <div className="flex flex-col items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
                        <p className="text-sm text-destructive font-medium">Couldn't load the current role assignments.</p>
                        <p className="text-xs text-muted-foreground">
                          Editing is paused so nothing gets overwritten — your stored assignments are safe.
                        </p>
                        <Button size="sm" variant="outline" onClick={() => void loadRoles()}>
                          Try again
                        </Button>
                      </div>
                    ) : membersLoading || !rolesLoaded ? (
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
                                    disabled={!rolesWritable}
                                  >
                                    {/* Static trigger text — the assignee's avatar+name already
                                        render at left; echoing the selection here duplicated it. */}
                                    <SelectTrigger
                                      className="h-8 text-xs w-[110px]"
                                      aria-label={`${assignedMember ? 'Change' : 'Assign'} ${label} approver`}
                                    >
                                      {assignedMember ? 'Change' : 'Assign'}
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
                                      disabled={!rolesWritable}
                                      aria-label={`Clear ${label} assignee`}
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
                      {/* Corrected 2026-07-12: the workflow Admin is NOT the Team-Members
                          access level — it's a separate grant (workspace_roles) that
                          canUploadExecutedDocument / canAccessVarianceReview check. The
                          earlier "same Admin" copy was wrong and hid a real capability. */}
                      <p className="text-xs text-muted-foreground mb-3">
                        Submitter: can create and submit lease requests. Workflow admin: can upload
                        executed documents and review variance reports — this is separate from the
                        Team Members access level above.
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
                            <span className="text-center">Workflow admin</span>
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
                                        <span className="text-xs text-muted-foreground sm:hidden">{role === 'admin' ? 'Workflow admin' : 'Submitter'}:</span>
                                        <Checkbox
                                          checked={roles.has(role)}
                                          onCheckedChange={() => { if (canEdit) toggleFunctionalRole(member.user_id, role); }}
                                          disabled={!canEdit || !rolesWritable}
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

                    {canEdit ? (
                      <p className="text-xs text-muted-foreground">Changes save automatically.</p>
                    ) : (
                      <ReadOnlyNotice />
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          )}

          {/* Notifications */}
          {canAccessDefaults && (
            <TabsContent value="notifications" className="space-y-6">
              {!canEdit && <ReadOnlyNotice />}
              <Card>
                <SectionCardHeader
                  icon={Bell}
                  title={t('workspace.notification_settings')}
                  description={t('workspace.notification_timing')}
                  status={saveStatus['notifications']}
                />
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="notification-days">{t('workspace.reminder_days')}</Label>
                    <Input
                      id="notification-days"
                      type="number"
                      value={notificationDays}
                      onChange={(e) => setNotificationDays(e.target.value)}
                      onBlur={() => void saveNotificationDays()}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      min="1"
                      max="365"
                      disabled={!canEdit}
                    />
                    <p className="text-xs text-muted-foreground">{t('workspace.reminder_desc')}</p>
                  </div>
                  {canEdit && <p className="text-xs text-muted-foreground">Changes save automatically.</p>}
                </CardContent>
              </Card>

            </TabsContent>
          )}

          {/* Lease Configuration — admin only */}
          {isAdmin && (
            <TabsContent value="lease_config" className="space-y-6">
              {configLoadState === 'error' && (
                <ConfigLoadErrorNotice onRetry={() => setConfigReloadNonce((n) => n + 1)} />
              )}
              <Card>
                <SectionCardHeader
                  icon={Settings2}
                  title="Asset Types"
                  description="Configure the list of asset types available when classifying leases. These are used by the AI during extraction to classify the asset. Set a short abbreviation (e.g. RE, EQP) to keep the Leases table tight — leave it blank to use the built-in default."
                  status={saveStatus['asset_types']}
                />
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
                          onBlur={saveAssetAbbreviations}
                          placeholder={assetAbbreviation(type)}
                          aria-label={`${type} abbreviation`}
                          maxLength={5}
                          className="h-7 w-20 text-center text-xs"
                          disabled={saveStatus['asset_types'] === 'saving'}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveAssetType(type)}
                          disabled={saveStatus['asset_types'] === 'saving'}
                          aria-label={`Remove ${type}`}
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
                    <Button variant="outline" size="sm" onClick={handleAddAssetType} disabled={!newAssetType.trim() || saveStatus['asset_types'] === 'saving'}>
                      <Plus size={14} className="mr-1" />
                      Add
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Changes save automatically.</p>
                </CardContent>
              </Card>

              {/* Departments */}
              {(['Departments', 'Regions', 'Locations', 'Buildings'] as const).map((label) => {
                const configs: Record<string, { options: string[]; newVal: string; setOptions: Dispatch<SetStateAction<string[]>>; setNew: Dispatch<SetStateAction<string>>; dbColumn: string }> = {
                  Departments: { options: departmentOptions, newVal: newDepartmentOption, setOptions: setDepartmentOptions, setNew: setNewDepartmentOption, dbColumn: 'department_options' },
                  Regions:     { options: regionOptions,     newVal: newRegionOption,     setOptions: setRegionOptions,     setNew: setNewRegionOption,     dbColumn: 'region_options' },
                  Locations:   { options: locationOptions,   newVal: newLocationOption,   setOptions: setLocationOptions,   setNew: setNewLocationOption,   dbColumn: 'location_options' },
                  Buildings:   { options: buildingOptions,   newVal: newBuildingOption,   setOptions: setBuildingOptions,   setNew: setNewBuildingOption,   dbColumn: 'building_options' },
                };
                const cfg = configs[label];
                const handlers = makeOptionListHandlers(cfg.options, cfg.setOptions, cfg.setNew, cfg.dbColumn);
                return (
                  <Card key={label}>
                    <SectionCardHeader
                      icon={Settings2}
                      title={label}
                      description={`Configure the available options for the ${label.toLowerCase().slice(0, -1)} field on leases. Users can also type a custom value.`}
                      status={saveStatus[cfg.dbColumn]}
                    />
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
                              disabled={saveStatus[cfg.dbColumn] === 'saving'}
                              aria-label={`Remove ${item}`}
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
                        <Button variant="outline" size="sm" onClick={() => handlers.handleAdd(cfg.newVal)} disabled={!cfg.newVal.trim() || saveStatus[cfg.dbColumn] === 'saving'}>
                          <Plus size={14} className="mr-1" />
                          Add
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Changes save automatically.</p>
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
              {configLoadState === 'error' && (
                <ConfigLoadErrorNotice onRetry={() => setConfigReloadNonce((n) => n + 1)} />
              )}
              <Card>
                <SectionCardHeader
                  icon={GitBranch}
                  title="Approval Rules"
                  description="Rules decide who approves each lease request — by asset type, department, dollar size, or region. The first matching rule runs its approver chain; when nothing matches, the Default approvers on the Members page take over."
                />
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
                <SectionCardHeader
                  icon={TrendingUp}
                  title="Review Thresholds"
                  description="Dollar limits that trigger financial review for new lease requests."
                  status={saveStatus['thresholds']}
                />
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
                        onBlur={() => void saveThresholds()}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
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
                        onBlur={() => void saveThresholds()}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        disabled={!canEdit}
                        placeholder="Optional"
                        className="pl-7"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Total portfolio lease liability limit. Commitments that exceed this threshold trigger a portfolio risk alert.
                    </p>
                  </div>

                  {canEdit && <p className="text-xs text-muted-foreground">Changes save automatically.</p>}

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
                <SectionCardHeader
                  icon={PenLine}
                  title="Counter-Signature Window"
                  description="Default number of days from signator approval until the counter-signed document is expected. Reminders fire 7 days before, on the due date, and at 7 / 14 / 28 days overdue."
                  status={saveStatus['countersig']}
                />
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
                      onBlur={() => void saveCounterSignature()}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      min={1}
                      max={365}
                      disabled={!canEdit}
                    />
                    <p className="text-xs text-muted-foreground">
                      Must be between 1 and 365 days. Default: 21.
                    </p>
                  </div>
                  {canEdit && <p className="text-xs text-muted-foreground">Changes save automatically.</p>}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* Onboarding — admin only */}
          {isAdmin && (
            <TabsContent value="onboarding" className="space-y-6">
              <Card>
                <SectionCardHeader
                  icon={Package}
                  title="Historical Portfolio Loader"
                  description="Enable a simplified form for loading existing leases during onboarding. Turn off when your portfolio is loaded."
                  status={saveStatus['onboarding']}
                />
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
                      disabled={saveStatus['onboarding'] === 'saving'}
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
