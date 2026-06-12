import { useState, useEffect } from 'react';
import { User, Lock, CreditCard, Check, Trash2, Save, Eye, EyeOff, Loader2, LogOut, Palette, Shield, Mail, BarChart3, Building2, ChevronRight, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from 'next-themes';
import { UsageContent } from '@/pages/app/UsageContent';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ANNUAL_DISCOUNT_PERCENT, PLANS, isUpgrade, normalizePlanId } from '@/config/pricing';
import { trialDaysRemaining } from '@/lib/trialStatus';
import { DocumentPackDialog } from '@/components/workspace/DocumentPackDialog';
import type { SubscriptionPlan } from '@/types';

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
];

export default function AccountSettings() {
  const { user, workspace, userRole, refreshProfile, isLoading } = useApp();
  const { user: authUser, signOut } = useAuth();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [isSaving, setIsSaving] = useState(false);
  
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [emailNotifications, setEmailNotifications] = useState(true);
  const [smsNotifications, setSmsNotifications] = useState(false);
  const [notifyAbstractionComplete, setNotifyAbstractionComplete] = useState(true);
  const [aiConsentAt, setAiConsentAt] = useState<string | null>(null);
  const [isRevokingConsent, setIsRevokingConsent] = useState(false);

  // Recent activity — pulls from lease_activity_log scoped to current user.
  // 4 shown by default, "View more" expands to 20.
  interface ActivityRow {
    id: string;
    activity_type: string;
    from_status: string | null;
    to_status: string | null;
    created_at: string;
    lease_title: string | null;
  }
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [activityExpanded, setActivityExpanded] = useState(false);

  useEffect(() => {
    if (!authUser?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from('lease_activity_log')
        .select('id, activity_type, from_status, to_status, created_at, lease:lease_id (request_title, filename)')
        .eq('user_id', authUser.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (cancelled) return;
      setActivity(
        ((data ?? []) as any[]).map((r) => ({
          id: r.id,
          activity_type: r.activity_type,
          from_status: r.from_status,
          to_status: r.to_status,
          created_at: r.created_at,
          lease_title: r.lease?.request_title ?? r.lease?.filename ?? null,
        }))
      );
    })();
    return () => { cancelled = true; };
  }, [authUser?.id]);

  const formatActivityLabel = (row: ActivityRow): string => {
    const friendly: Record<string, string> = {
      lease_uploaded: 'Uploaded lease',
      lease_extracted: 'AI extraction completed',
      field_edited: 'Edited a field',
      field_verified: 'Verified a field',
      change_submitted: 'Submitted changes for approval',
      change_approved: 'Approved changes',
      change_rejected: 'Rejected changes',
      lease_locked: 'Locked lease',
      lease_unlocked: 'Unlocked lease',
      lease_archived: 'Archived lease',
      lease_unarchived: 'Unarchived lease',
      status_changed: row.from_status && row.to_status
        ? `Status: ${row.from_status} → ${row.to_status}`
        : 'Status changed',
    };
    return friendly[row.activity_type] ?? row.activity_type.replace(/_/g, ' ');
  };

  const relativeTime = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(iso).toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', { month: 'short', day: 'numeric' });
  };
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLoggingOutOthers, setIsLoggingOutOthers] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState<string | null>(null);
  const [isManagingPayment, setIsManagingPayment] = useState(false);
  const [confirmUpgradePlan, setConfirmUpgradePlan] = useState<string | null>(null);
  const [confirmDowngradePlan, setConfirmDowngradePlan] = useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('profile');
  // Billing interval selection for the in-app upgrade flow. Defaults
  // monthly; can be set to 'annual' via the toggle on the upgrade card OR
  // pre-armed via ?billing= when arriving from onboarding.
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'annual'>('monthly');
  const [autoCheckoutFired, setAutoCheckoutFired] = useState(false);

  // Handle URL params for tab switching. Tabs removed/renamed in the 2026-06
  // Claude-alignment pass map to their new homes so old links never strand:
  //   subscription → billing (rename), notifications → profile (folded in),
  //   other → privacy (merged), out-of-office → profile (feature removed),
  //   workspace → navigates to the Workspaces drill-down. Anything unknown
  //   falls back to profile instead of selecting a tab that doesn't exist.
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'workspace') {
      navigate('/app/settings/workspaces', { replace: true });
      return;
    }
    const TAB_ALIASES: Record<string, string> = {
      subscription: 'billing',
      notifications: 'profile',
      'out-of-office': 'profile',
      other: 'privacy',
    };
    const VALID_TABS = ['profile', 'appearance', 'account', 'privacy', 'billing', 'usage'];
    if (tab) {
      const resolved = Object.prototype.hasOwnProperty.call(TAB_ALIASES, tab)
        ? TAB_ALIASES[tab]
        : tab;
      setActiveTab(VALID_TABS.includes(resolved) ? resolved : 'profile');
    }

    const checkout = searchParams.get('checkout');
    if (checkout === 'success' || checkout === 'canceled') {
      if (checkout === 'success') {
        toast.success(t('account.checkout_success'));
        refreshProfile();
      } else {
        toast.info(t('account.checkout_canceled'));
      }
      // Strip the param immediately so the toast/refresh fires exactly once —
      // never on refresh, back-nav, or a re-render (mirrors the autoCheckout
      // cleanup below). Without this the success branch re-fired in a loop.
      const next = new URLSearchParams(searchParams);
      next.delete('checkout');
      navigate({ search: next.toString() ? `?${next.toString()}` : '' }, { replace: true });
    }

    // Deep-link from the quota banner's "Add capacity" CTA opens the pack dialog.
    if (searchParams.get('packs') === '1') {
      setPackDialogOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('packs');
      navigate({ search: next.toString() ? `?${next.toString()}` : '' }, { replace: true });
    }

    // Pre-arm billing interval from onboarding handoff. Stays in state
    // even after the param clears, so subsequent upgrades respect the
    // user's original landing-page choice.
    const billing = searchParams.get('billing');
    if (billing === 'annual' || billing === 'monthly') {
      setBillingInterval(billing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, refreshProfile]);

  useEffect(() => {
    if (user) {
      setFirstName(user.firstName || '');
      setLastName(user.lastName || '');
      setEmail(user.email || '');
      setCompanyName(user.companyName || '');
      setTimezone(user.timezone || 'America/New_York');
    }
  }, [user]);

  // Load notification preferences
  useEffect(() => {
    async function loadPrefs() {
      if (!authUser?.id) return;
      const { data } = await (supabase as any)
        .from('profiles')
        .select('email_notifications_enabled, sms_notifications_enabled, notify_abstraction_complete, ai_processing_consent_at')
        .eq('id', authUser.id)
        .single();
      if (data) {
        setEmailNotifications(data.email_notifications_enabled ?? true);
        setSmsNotifications(data.sms_notifications_enabled ?? false);
        setNotifyAbstractionComplete(data.notify_abstraction_complete ?? true);
        setAiConsentAt(data.ai_processing_consent_at ?? null);
      }
    }
    loadPrefs();
  }, [authUser?.id]);

  const handleRevokeAiConsent = async () => {
    if (!authUser?.id) return;
    if (!confirm('Revoke AI processing consent? You can re-grant it later, but lease uploads may be blocked while revoked.')) return;
    setIsRevokingConsent(true);
    try {
      const { error } = await (supabase as any)
        .from('profiles')
        .update({ ai_processing_consent_at: null })
        .eq('id', authUser.id);
      if (error) throw error;
      setAiConsentAt(null);
      toast.success('AI processing consent revoked');
    } catch (err) {
      console.error('Error revoking AI consent:', err);
      toast.error('Failed to revoke consent');
    } finally {
      setIsRevokingConsent(false);
    }
  };

  const handleGrantAiConsent = async () => {
    if (!authUser?.id) return;
    setIsRevokingConsent(true);
    try {
      const now = new Date().toISOString();
      const { error } = await (supabase as any)
        .from('profiles')
        .update({ ai_processing_consent_at: now })
        .eq('id', authUser.id);
      if (error) throw error;
      setAiConsentAt(now);
      toast.success('AI processing consent recorded');
    } catch (err) {
      console.error('Error granting AI consent:', err);
      toast.error('Failed to record consent');
    } finally {
      setIsRevokingConsent(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!authUser) {
      toast.error('You must be logged in to save changes');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          company_name: companyName.trim(),
          timezone: timezone,
        })
        .eq('id', authUser.id);

      if (error) throw error;

      await refreshProfile();
      toast.success('Profile updated successfully!');
    } catch (error) {
      console.error('Error saving profile:', error);
      toast.error('Failed to save profile');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || !confirmPassword) {
      toast.error('Please enter a new password');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }

    setIsChangingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) throw error;

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password updated successfully!');
    } catch (error) {
      console.error('Error changing password:', error);
      toast.error('Failed to change password');
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleSaveNotificationPrefs = async () => {
    if (!authUser?.id) return;
    
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          email_notifications_enabled: emailNotifications,
          sms_notifications_enabled: smsNotifications,
          notify_abstraction_complete: notifyAbstractionComplete,
        } as any)
        .eq('id', authUser.id);

      if (error) throw error;
      toast.success('Notification preferences saved!');
    } catch (error) {
      console.error('Error saving notification prefs:', error);
      toast.error('Failed to save preferences');
    }
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke('delete-account');
      
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success('Account deleted successfully');
      await signOut();
      navigate('/');
    } catch (error) {
      console.error('Error deleting account:', error);
      toast.error('Failed to delete account. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleLogoutOtherSessions = async () => {
    setIsLoggingOutOthers(true);
    try {
      // Supabase doesn't have a direct "logout other sessions" - we use signOut with scope
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      if (error) throw error;
      toast.success('All other sessions have been logged out');
    } catch (error) {
      console.error('Error logging out other sessions:', error);
      toast.error('Failed to log out other sessions');
    } finally {
      setIsLoggingOutOthers(false);
    }
  };

  const handleUpgrade = async (planId: string) => {
    // If already subscribed, show confirmation first
    const currentPlan = normalizePlanId(workspace?.plan) as SubscriptionPlan;
    if (currentPlan !== 'starter' && isUpgrade(currentPlan, planId as SubscriptionPlan)) {
      setConfirmUpgradePlan(planId);
      return;
    }
    
    await proceedWithCheckout(planId);
  };

  const proceedWithCheckout = async (planId: string) => {
    if (!workspace?.id) {
      toast.error(t('account.checkout_no_workspace'));
      return;
    }

    setIsUpgrading(planId);
    setConfirmUpgradePlan(null);

    try {
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { planId, workspaceId: workspace.id, billingInterval },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.url) {
        // Same-tab redirect — Stripe round-trips back via the success/cancel
        // URLs. window.open('_blank') after an await is outside the click
        // gesture and gets popup-blocked in Safari/Firefox, silently no-op'ing
        // every billing CTA (H1, 2026-06-11).
        window.location.href = data.url;
      }
    } catch (error) {
      console.error('Error creating checkout:', error);
      const msg = error instanceof Error ? error.message : t('account.checkout_failed');
      toast.error(msg);
    } finally {
      setIsUpgrading(null);
    }
  };

  // Auto-trigger checkout when arriving from onboarding with
  // ?autoCheckout=1. Fires once per mount; further visits to the
  // subscription tab require manual upgrade. The param is cleared
  // from the URL after firing so refresh doesn't retrigger before
  // the webhook has updated subscription_status.
  useEffect(() => {
    if (autoCheckoutFired) return;
    if (searchParams.get('autoCheckout') !== '1') return;
    if (!workspace?.id) return;
    if ((workspace.subscriptionStatus === 'active' || workspace.subscriptionStatus === 'trialing')) return;

    setAutoCheckoutFired(true);
    proceedWithCheckout('business');

    const next = new URLSearchParams(searchParams);
    next.delete('autoCheckout');
    navigate({ search: next.toString() ? `?${next.toString()}` : '' }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id, workspace?.subscriptionStatus, searchParams, autoCheckoutFired]);

  const handleManagePayment = async () => {
    if (!workspace?.id) {
      toast.error(t('account.portal_no_workspace'));
      return;
    }
    setIsManagingPayment(true);
    try {
      // P2-07: the portal call is workspace-scoped. The edge function
      // verifies owner/admin and looks up Stripe from the workspace's
      // stored stripe_customer_id (populated by the Stripe webhook),
      // not from the caller's email.
      const { data, error } = await supabase.functions.invoke('customer-portal', {
        body: { workspaceId: workspace.id },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.url) {
        // Same-tab redirect (see proceedWithCheckout) — avoids popup blockers.
        window.location.href = data.url;
      }
    } catch (error) {
      console.error('Error opening customer portal:', error);
      const msg = error instanceof Error ? error.message : t('account.portal_failed');
      toast.error(msg);
    } finally {
      setIsManagingPayment(false);
    }
  };

  const currentPlan = normalizePlanId(workspace?.plan);

  const isAdminUser = userRole === 'admin' || userRole === 'owner';

  // Real billing dates come from subscription_period_end (mirrored from
  // Stripe by the webhook). Null until first checkout; guard every render
  // on validity so the UI never shows "Invalid Date".
  const periodEndMs = workspace?.subscriptionPeriodEnd
    ? new Date(workspace.subscriptionPeriodEnd).getTime()
    : NaN;
  const formattedPeriodEnd = Number.isFinite(periodEndMs)
    ? new Date(periodEndMs).toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const trialDaysLeft = trialDaysRemaining(workspace?.subscriptionPeriodEnd);
  // Effective allowance = base plan limit + active document-pack capacity.
  const addonCapacity = workspace?.addonDocumentCapacity ?? 0;
  const effectiveLimit = (workspace?.documentLimit ?? 0) + addonCapacity;
  const usageRatio =
    workspace && effectiveLimit > 0 ? workspace.documentsUsed / effectiveLimit : 0;
  const railTriggerClass =
    'md:w-full justify-start gap-2 px-3 py-2 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground rounded-md';

  // Write the tab to the URL on change so refresh/back/share keep position.
  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    navigate({ search: `?${next.toString()}` }, { replace: true });
  };

  return (
    <AppLayout>
      <AppHeader title={t('account.title')} subtitle={t('account.subtitle')} />

      <div className="p-6">
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          orientation="vertical"
          className="flex flex-col md:flex-row gap-6 md:items-start"
        >
          {/* Vertical rail (Claude.ai-style). Collapses to a horizontal strip below md breakpoint.
              Override the shadcn defaults (h-10, items-center, justify-center, bg-muted, p-1) for
              vertical mode so the rail floats to the top instead of centering its items. */}
          <TabsList className="h-auto flex-wrap shrink-0 md:w-56 md:flex-col md:items-stretch md:justify-start md:bg-transparent md:p-0 md:gap-1">
            <TabsTrigger value="profile" className={railTriggerClass}>
              <User className="h-4 w-4" />
              {t('account.profile')}
            </TabsTrigger>
            <TabsTrigger value="appearance" className={railTriggerClass}>
              <Palette className="h-4 w-4" />
              {t('account.appearance')}
            </TabsTrigger>
            <TabsTrigger value="account" className={railTriggerClass}>
              <Lock className="h-4 w-4" />
              {t('account.account_tab')}
            </TabsTrigger>
            <TabsTrigger value="privacy" className={railTriggerClass}>
              <Shield className="h-4 w-4" />
              {t('account.privacy')}
            </TabsTrigger>
            <TabsTrigger value="billing" className={railTriggerClass}>
              <CreditCard className="h-4 w-4" />
              {t('account.billing')}
            </TabsTrigger>
            <TabsTrigger value="usage" className={railTriggerClass}>
              <BarChart3 className="h-4 w-4" />
              {t('account.usage')}
            </TabsTrigger>

            {/* Workspaces — navigation out to the workspace-scoped settings
                surface (own rail + back arrow), not a tab. The boundary
                between account-level and workspace-level settings is the
                separator above this link. */}
            <div className="hidden md:block h-px bg-border my-2" />
            <Link
              to="/app/settings/workspaces"
              className={cn(
                railTriggerClass,
                'flex items-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors',
              )}
            >
              <Building2 className="h-4 w-4" />
              {t('account.workspaces_link')}
              <ChevronRight className="h-4 w-4 ml-auto" />
            </Link>
          </TabsList>

          {/* Content panel — min-h stabilizes the layout so switching tabs
              with different content lengths doesn't make the page reflow. */}
          <div className="flex-1 min-w-0 md:min-h-[640px]">

          {/* Profile */}
          <TabsContent value="profile" className="space-y-6 mt-0">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.personal_info')}</CardTitle>
                <CardDescription>{t('account.update_details')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="first-name">{t('account.first_name')}</Label>
                    <Input
                      id="first-name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="last-name">{t('account.last_name')}</Label>
                    <Input
                      id="last-name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">{t('account.email')}</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    disabled
                    className="bg-muted"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">{t('account.phone')}</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 (555) 000-0000"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company">{t('account.company')}</Label>
                  <Input
                    id="company"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="user-timezone">{t('account.timezone')}</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger id="user-timezone">
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
                </div>
                <Button variant="accent" onClick={handleSaveProfile} disabled={isSaving}>
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {isSaving ? t('account.saving') : t('account.save_changes')}
                </Button>
              </CardContent>
            </Card>

            {/* Personal notification preferences — folded in from the former
                Notifications tab. These are per-user (profiles table), so they
                live with the rest of the user's own settings; the workspace's
                reminder defaults live in Workspaces → Notifications. */}
            <Card>
              <CardHeader>
                <CardTitle>{t('account.notification_prefs')}</CardTitle>
                <CardDescription>{t('account.choose_alerts')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{t('account.email_notifications')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('account.email_notifications_desc')}
                    </p>
                  </div>
                  <Switch
                    checked={emailNotifications}
                    onCheckedChange={setEmailNotifications}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{t('account.sms_notifications')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('account.sms_notifications_desc')}
                    </p>
                  </div>
                  <Switch
                    checked={smsNotifications}
                    onCheckedChange={setSmsNotifications}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t('account.notify_abstraction_complete')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('account.notify_abstraction_complete_desc')}
                    </p>
                  </div>
                  <Switch
                    checked={notifyAbstractionComplete}
                    onCheckedChange={setNotifyAbstractionComplete}
                  />
                </div>
                <Button variant="accent" onClick={handleSaveNotificationPrefs}>
                  <Save className="h-4 w-4 mr-2" />
                  {t('account.save_changes')}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Account (renamed from Security) */}
          <TabsContent value="account" className="space-y-6 mt-0">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.change_password')}</CardTitle>
                <CardDescription>{t('account.update_password')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* KNOWN_ISSUES #3: password fields must be wrapped in a
                    <form> and carry the right autocomplete attrs so password
                    managers and Chrome's heuristic stop warning. The form's
                    onSubmit calls the same handler as the button click; we
                    keep the visible submit Button so existing styles work. */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!isChangingPassword) handleChangePassword();
                  }}
                  className="space-y-4"
                >
                  {/* Hidden username input helps password managers associate
                      the new credential with the right account. */}
                  <input
                    type="text"
                    name="username"
                    autoComplete="username"
                    value={email}
                    readOnly
                    style={{ display: 'none' }}
                    aria-hidden="true"
                  />
                  <div className="space-y-2">
                    <Label htmlFor="current-password">{t('account.current_password')}</Label>
                    <div className="relative">
                      <Input
                        id="current-password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="new-password">{t('account.new_password')}</Label>
                    <Input
                      id="new-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">{t('account.confirm_password')}</Label>
                    <Input
                      id="confirm-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                  </div>
                  <Button type="submit" variant="accent" disabled={isChangingPassword}>
                    {isChangingPassword ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    {isChangingPassword ? t('account.updating') : t('account.update_password_btn')}
                  </Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('account.recent_activity')}</CardTitle>
                <CardDescription>{t('account.recent_activity_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {activity.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic py-2">
                    {t('account.recent_activity_empty')}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {(activityExpanded ? activity : activity.slice(0, 4)).map((row) => (
                      <li
                        key={row.id}
                        className="flex items-center justify-between gap-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {formatActivityLabel(row)}
                          </p>
                          {row.lease_title && (
                            <p className="text-xs text-muted-foreground truncate">
                              {row.lease_title}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                          {relativeTime(row.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {activity.length > 4 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full mt-2 text-xs"
                    onClick={() => setActivityExpanded((v) => !v)}
                  >
                    {activityExpanded
                      ? t('account.recent_activity_view_less')
                      : t('account.recent_activity_view_more', { count: activity.length - 4 })}
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="w-full mt-4"
                  onClick={handleLogoutOtherSessions}
                  disabled={isLoggingOutOthers}
                >
                  {isLoggingOutOthers ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <LogOut className="h-4 w-4 mr-2" />
                  )}
                  {t('account.logout_other')}
                </Button>
              </CardContent>
            </Card>

            {/* Danger Zone - Delete Account (moved here from Profile, Claude pattern) */}
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-destructive">{t('account.delete_account')}</CardTitle>
                <CardDescription>{t('account.delete_account_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">{t('account.delete_warning')}</p>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" disabled={isDeleting}>
                      {isDeleting ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 mr-2" />
                      )}
                      {t('account.delete_account')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('account.delete_confirm')}</AlertDialogTitle>
                      <AlertDialogDescription>{t('account.delete_confirm_desc')}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={handleDeleteAccount}
                      >
                        {t('account.delete_account')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          </TabsContent>


          {/* Billing (renamed from Subscription; 'subscription' stays a URL alias) */}
          <TabsContent value="billing" className="space-y-6 mt-0">
            {/* Skeleton while the workspace fetch is in flight. */}
            {isLoading && !workspace ? (
              <div className="space-y-6">
                <Skeleton className="h-44 w-full" />
                <Skeleton className="h-72 w-full" />
              </div>
            ) : !workspace ? (
              /* Fetch finished but no workspace resolved (error / none selected)
                 — never strand the user on skeletons forever. */
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t('account.billing_unavailable_title')}</CardTitle>
                  <CardDescription>{t('account.billing_unavailable_desc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button variant="outline" size="sm" onClick={() => refreshProfile()}>
                    {t('account.retry')}
                  </Button>
                </CardContent>
              </Card>
            ) : (
            <>
            {/* Trial banner — visible while subscription is in Stripe's trial window. */}
            {workspace.subscriptionStatus === 'trialing' && formattedPeriodEnd && (
              <Card className="border-accent/50 bg-accent/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('account.trial_banner_title')}</CardTitle>
                  <CardDescription>
                    {trialDaysLeft === 0
                      ? t('account.trial_banner_desc_today')
                      : t('account.trial_banner_desc', {
                          days: t('account.trial_days_left', { count: trialDaysLeft ?? 0 }),
                          date: formattedPeriodEnd,
                        })}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {isAdminUser ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleManagePayment}
                      disabled={isManagingPayment}
                    >
                      {isManagingPayment ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <CreditCard className="h-4 w-4 mr-2" />
                      )}
                      {t('account.add_payment_method')}
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('account.billing_admin_only')}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Past-due / unpaid / incomplete states — payment failed; user must update method. */}
            {workspace?.subscriptionStatus &&
              ['past_due', 'unpaid', 'incomplete'].includes(workspace.subscriptionStatus) && (
                <Card className="border-destructive/60 bg-destructive/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base text-destructive">
                      {t('account.past_due_banner_title')}
                    </CardTitle>
                    <CardDescription>
                      {t('account.past_due_banner_desc')}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {isAdminUser ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={handleManagePayment}
                        disabled={isManagingPayment}
                      >
                        {isManagingPayment ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                        {t('account.update_payment_method')}
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('account.billing_admin_only')}</p>
                    )}
                  </CardContent>
                </Card>
              )}

            {/* Abandoned-checkout recovery — user selected Business during signup
                but never completed payment. Surfaces a way back into checkout. */}
            {workspace?.intendedPlan === 'business' &&
              workspace.plan !== 'business' &&
              workspace.subscriptionStatus !== 'active' &&
              workspace.subscriptionStatus !== 'trialing' && (
                <Card className="border-primary/50 bg-primary/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">
                      {t('account.recovery_callout_title')}
                    </CardTitle>
                    <CardDescription>
                      {t('account.recovery_callout_desc')}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {isAdminUser ? (
                      <Button
                        size="sm"
                        onClick={() => proceedWithCheckout('business')}
                        disabled={isUpgrading === 'business'}
                      >
                        {isUpgrading === 'business' ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : null}
                        {t('account.recovery_callout_cta')}
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('account.billing_admin_only')}</p>
                    )}
                  </CardContent>
                </Card>
              )}

            {/* Current Plan & Usage */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {t('account.current_plan')}
                    <Badge variant={currentPlan === 'business' ? 'business' : 'secondary'}>
                      {t(PLANS[currentPlan].nameKey)}
                    </Badge>
                  </CardTitle>
                  {/* Renewal date is shown for ANY active paid subscription —
                      paid Starter renews too. Guarded on subscription state +
                      a valid period end, never on plan tier. */}
                  {workspace.subscriptionStatus === 'active' && formattedPeriodEnd && (
                    <CardDescription>
                      {t('account.renews_on')} {formattedPeriodEnd}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-baseline justify-between mb-2">
                        <span className="text-sm font-medium">{t('account.document_usage')}</span>
                        <span className="text-sm text-muted-foreground">
                          {workspace.documentsUsed} / {effectiveLimit}
                          {addonCapacity > 0 && (
                            <span className="text-xs"> {t('account.usage_includes_pack', { base: workspace.documentLimit, count: addonCapacity })}</span>
                          )}
                        </span>
                      </div>
                      <Progress
                        value={Math.min(usageRatio * 100, 100)}
                        variant={
                          usageRatio >= 0.9
                            ? 'destructive'
                            : usageRatio >= 0.75
                            ? 'warning'
                            : 'accent'
                        }
                        className="h-2"
                      />
                      <p className="text-xs text-muted-foreground mt-1.5">
                        {t('account.usage_window_note')}
                      </p>
                    </div>
                    {isAdminUser ? (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={handleManagePayment}
                        disabled={isManagingPayment}
                      >
                        {isManagingPayment ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <CreditCard className="h-4 w-4 mr-2" />
                        )}
                        {t('account.manage_payment')}
                      </Button>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('account.billing_admin_only')}</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t('account.billing_contact')}</CardTitle>
                  <CardDescription>{t('account.invoices_sent')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div>
                      <p className="text-sm font-medium">{workspace.name}</p>
                      <p className="text-sm text-muted-foreground">{user?.email || ''}</p>
                    </div>
                    {/* Intentionally no second button — payment methods,
                        invoices, and billing contact all live behind the one
                        "Open billing portal" CTA on the Current Plan card. */}
                    <p className="text-xs text-muted-foreground">
                      {t('account.billing_portal_note')}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Lease capacity packs */}
            <Card>
              <CardHeader>
                <CardTitle>{t('packs.card_title')}</CardTitle>
                <CardDescription>{t('packs.card_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      {addonCapacity > 0
                        ? t('packs.card_current', { count: addonCapacity })
                        : t('packs.card_none')}
                    </p>
                    {isAdminUser && (
                      <Button variant="outline" size="sm" onClick={() => setPackDialogOpen(true)}>
                        {t('packs.card_cta')}
                      </Button>
                    )}
                  </div>
                  {!isAdminUser && (
                    <p className="text-xs text-muted-foreground">{t('packs.admin_only')}</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Single-lease credits — only renders while a balance exists.
                Credits are granted by the Stripe webhook on a one-time
                purchase from the limit wall and consumed by process_lease. */}
            {(workspace.purchasedLeaseCredits ?? 0) > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{t('account.credits_title')}</CardTitle>
                  <CardDescription>{t('account.credits_desc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm font-medium">
                    {t('account.credits_balance', { count: workspace.purchasedLeaseCredits })}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Plan change — one focused card, not a plan-comparison grid
                (the grid duplicated the landing page and buried the action).
                Starter admins upgrade in place; Business admins downgrade
                via the confirmation dialog that spells out feature loss. */}
            {isAdminUser && currentPlan === 'starter' && (
              <Card variant="feature">
                <CardHeader>
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <CardTitle>{t('account.upgrade_card_title')}</CardTitle>
                    <div className="flex items-center gap-3 text-sm">
                      <span className={cn('font-medium', billingInterval === 'monthly' ? 'text-foreground' : 'text-muted-foreground')}>
                        {t('landing.pricing.monthly')}
                      </span>
                      <Switch
                        checked={billingInterval === 'annual'}
                        onCheckedChange={(v) => setBillingInterval(v ? 'annual' : 'monthly')}
                      />
                      <span className={cn('font-medium', billingInterval === 'annual' ? 'text-foreground' : 'text-muted-foreground')}>
                        {t('landing.pricing.annual')}
                      </span>
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                        {t('landing.pricing.save')} {ANNUAL_DISCOUNT_PERCENT}%
                      </span>
                    </div>
                  </div>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="text-2xl font-bold">
                      ${billingInterval === 'annual' ? Math.round(PLANS.business.price.annual / 12) : PLANS.business.price.monthly}
                    </span>
                    <span className="text-muted-foreground text-sm">{t('account.per_month')}</span>
                  </div>
                  {billingInterval === 'annual' && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {t('account.billed_annually', { total: PLANS.business.price.annual.toLocaleString() })}
                    </p>
                  )}
                  <CardDescription className="mt-1">
                    {t('account.abstractions_included', { count: PLANS.business.abstractionsIncluded })}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ul className="space-y-1.5">
                    {PLANS.business.featureKeys.slice(0, 4).map((featureKey) => (
                      <li key={featureKey} className="flex items-start gap-2 text-xs">
                        <Check className="h-3 w-3 text-success shrink-0 mt-0.5" />
                        <span className="text-muted-foreground">{t(featureKey)}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="accent"
                    className="w-full sm:w-auto"
                    onClick={() => handleUpgrade('business')}
                    disabled={isUpgrading === 'business'}
                  >
                    {isUpgrading === 'business' ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : null}
                    {t('account.upgrade_card_cta')}
                  </Button>
                </CardContent>
              </Card>
            )}
            {isAdminUser && currentPlan === 'business' && (
              <p className="text-xs text-muted-foreground">
                {t('account.downgrade_hint')}{' '}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => setConfirmDowngradePlan('starter')}
                >
                  {t('account.downgrade_link')}
                </button>
              </p>
            )}
            {!isAdminUser && (
              <p className="text-xs text-muted-foreground">
                {t('account.plan_changes_admin_only')}
              </p>
            )}

            {/* Cancel Subscription — shown for any active/paid subscription
                (paid Starter included; plan tier is not a proxy for "has a
                subscription"), admin-only. */}
            {['active', 'trialing', 'past_due'].includes(workspace.subscriptionStatus ?? '') &&
              isAdminUser && (
              <Card className="border-destructive/50">
                <CardHeader>
                  <CardTitle className="text-destructive">{t('account.cancel_subscription')}</CardTitle>
                  <CardDescription>
                    {t('account.cancel_subscription_desc')}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground mb-4">
                    {t('account.cancel_warning')}
                  </p>
                  {/* Confirmation dialog first — destructive action must never
                      jump straight to the Stripe portal (C2, 2026-06-11). */}
                  <Button
                    variant="destructive"
                    onClick={() => setConfirmCancelOpen(true)}
                  >
                    {t('account.cancel_subscription')}
                  </Button>
                </CardContent>
              </Card>
            )}
            </>
            )}
          </TabsContent>

          {/* Usage — embedded inside Settings (Claude pattern) */}
          <TabsContent value="usage" className="space-y-6 mt-0">
            <UsageContent />
          </TabsContent>

          {/* Appearance — theme toggle */}
          <TabsContent value="appearance" className="space-y-6 mt-0">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.appearance')}</CardTitle>
                <CardDescription>{t('account.appearance_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <ThemeRadio />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Privacy — AI consent (moved here from Profile) + data export + policy links */}
          <TabsContent value="privacy" className="space-y-6 mt-0">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.privacy_ai_title')}</CardTitle>
                <CardDescription>{t('account.privacy_ai_desc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {aiConsentAt
                    ? `${t('account.privacy_consent_recorded')} ${new Date(aiConsentAt).toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`
                    : t('account.privacy_consent_revoked')}
                </p>
                {aiConsentAt ? (
                  <Button variant="outline" onClick={handleRevokeAiConsent} disabled={isRevokingConsent}>
                    {isRevokingConsent ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {t('account.privacy_revoke')}
                  </Button>
                ) : (
                  <Button variant="accent" onClick={handleGrantAiConsent} disabled={isRevokingConsent}>
                    {isRevokingConsent ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {t('account.privacy_grant')}
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('account.privacy_data_export')}</CardTitle>
                <CardDescription>{t('account.privacy_data_export_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" asChild>
                  <a href="mailto:privacy@theleaseio.com?subject=Data%20Export%20Request">
                    <Mail className="h-4 w-4 mr-2" />
                    {t('account.privacy_request_export')}
                  </a>
                </Button>
              </CardContent>
            </Card>

            {/* Subject Access Request (SAR) contact — covers the rights to
                access, correct, delete, port data, opt-out of profiling, and
                lodge complaints with a regulator. Required by GDPR/CCPA. */}
            <Card>
              <CardHeader>
                <CardTitle>{t('account.privacy_rights_title')}</CardTitle>
                <CardDescription>{t('account.privacy_rights_desc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="text-sm text-muted-foreground space-y-1 ml-5 list-disc">
                  <li>{t('account.privacy_right_access')}</li>
                  <li>{t('account.privacy_right_correct')}</li>
                  <li>{t('account.privacy_right_delete')}</li>
                  <li>{t('account.privacy_right_portability')}</li>
                  <li>{t('account.privacy_right_object')}</li>
                </ul>
                <Button variant="outline" asChild>
                  <a href="mailto:privacy@theleaseio.com?subject=Privacy%20Rights%20Request&body=Please%20describe%20your%20request%20(access%2C%20correction%2C%20deletion%2C%20portability%2C%20or%20objection)%20and%20we'll%20respond%20within%2030%20days.">
                    <Mail className="h-4 w-4 mr-2" />
                    {t('account.privacy_rights_contact_btn')}
                  </a>
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {t('account.privacy_rights_response_window')}
                </p>
              </CardContent>
            </Card>

            {/* Legal links — absorbed the former "Other" tab (its terms/
                privacy links were duplicates of these; the support link
                lives in the user menu as "Get help"). */}
            <Card>
              <CardHeader>
                <CardTitle>{t('account.privacy_policies')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>
                  <Link to="/privacy" className="text-primary hover:underline">{t('account.privacy_policy_link')}</Link>
                </div>
                <div>
                  <Link to="/terms" className="text-primary hover:underline">{t('account.terms_link')}</Link>
                </div>
                <div className="text-xs text-muted-foreground pt-2 border-t border-border">
                  LeaseIO &middot; {new Date().getFullYear()}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* Document capacity pack purchase/manage dialog */}
      <DocumentPackDialog open={packDialogOpen} onOpenChange={setPackDialogOpen} />

      {/* Upgrade Confirmation Dialog */}
      <AlertDialog open={!!confirmUpgradePlan} onOpenChange={() => setConfirmUpgradePlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('account.upgrade_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('account.upgrade_confirm_desc', {
                from: t(PLANS[currentPlan].nameKey),
                to: confirmUpgradePlan
                  ? t(PLANS[normalizePlanId(confirmUpgradePlan)].nameKey)
                  : '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmUpgradePlan && proceedWithCheckout(confirmUpgradePlan)}>
              {t('account.upgrade_confirm_cta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Downgrade Confirmation Dialog — spells out Business feature loss
          before handing off to the billing portal. */}
      <AlertDialog open={!!confirmDowngradePlan} onOpenChange={() => setConfirmDowngradePlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('account.downgrade_confirm_title', {
                plan: confirmDowngradePlan
                  ? t(PLANS[normalizePlanId(confirmDowngradePlan)].nameKey)
                  : '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('account.downgrade_confirm_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDowngradePlan(null);
                handleManagePayment();
              }}
            >
              {t('account.downgrade_confirm_cta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Subscription Confirmation Dialog — shows the concrete
          end-of-access date when the period end is known. */}
      <AlertDialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('account.cancel_confirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {formattedPeriodEnd
                ? t('account.cancel_confirm_desc_date', { date: formattedPeriodEnd })
                : t('account.cancel_confirm_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('account.keep_subscription')}</AlertDialogCancel>
            {/* CTA names the actual action — clicking opens the Stripe
                portal; it does NOT itself cancel (mirrors the downgrade
                dialog's honesty; H3 2026-06-12). */}
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmCancelOpen(false);
                handleManagePayment();
              }}
            >
              {t('account.cancel_confirm_cta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

/**
 * Theme picker — Light / Dark / System. Wired to next-themes (provider mounted
 * at App root). Renders as a small button row instead of a radio fieldset for
 * a tighter visual style closer to Claude.ai's Appearance tab.
 */
function ThemeRadio() {
  const { theme, setTheme } = useTheme();
  const options: Array<{ value: 'light' | 'dark' | 'system'; label: string; Icon: typeof Sun }> = [
    { value: 'light', label: 'Light', Icon: Sun },
    { value: 'dark', label: 'Dark', Icon: Moon },
    { value: 'system', label: 'System', Icon: Monitor },
  ];
  const active = (theme as 'light' | 'dark' | 'system' | undefined) ?? 'system';
  return (
    <div className="grid grid-cols-3 gap-2 max-w-md">
      {options.map(({ value, label, Icon }) => {
        const selected = active === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            className={[
              'flex flex-col items-center justify-center gap-2 rounded-md border px-3 py-4 transition-colors',
              selected
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-border hover:bg-muted/40 text-muted-foreground',
            ].join(' ')}
          >
            <Icon className="h-5 w-5" />
            <span className="text-xs font-medium">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
