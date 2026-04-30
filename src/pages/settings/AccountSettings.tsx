import { useState, useEffect } from 'react';
import { User, Lock, Bell, CreditCard, Check, Trash2, Save, Eye, EyeOff, Loader2, Star, LogOut, Palette, Shield, Info, Settings2, Sun, Moon, Monitor, Mail, BarChart3 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { UsageContent } from '@/pages/app/UsageContent';
import WorkspaceSettings from '@/pages/settings/WorkspaceSettings';
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
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { PLANS, PLAN_ORDER, isUpgrade, normalizePlanId } from '@/config/pricing';
import type { SubscriptionPlan } from '@/types';

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
];

export default function AccountSettings() {
  const { user, workspace, userRole, refreshProfile } = useApp();
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
  const [activeTab, setActiveTab] = useState('profile');

  // Handle URL params for tab switching
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab) setActiveTab(tab);
    
    const checkout = searchParams.get('checkout');
    if (checkout === 'success') {
      toast.success('Subscription activated successfully!');
      refreshProfile();
    } else if (checkout === 'canceled') {
      toast.info('Checkout was canceled');
    }
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
      toast.error('Create or select a workspace before starting checkout.');
      return;
    }

    setIsUpgrading(planId);
    setConfirmUpgradePlan(null);
    
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { planId, workspaceId: workspace.id },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (error) {
      console.error('Error creating checkout:', error);
      toast.error('Failed to start checkout. Please try again.');
    } finally {
      setIsUpgrading(null);
    }
  };

  const handleManagePayment = async () => {
    setIsManagingPayment(true);
    try {
      const { data, error } = await supabase.functions.invoke('customer-portal');

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (error) {
      console.error('Error opening customer portal:', error);
      toast.error('Failed to open billing portal. You may need an active subscription first.');
    } finally {
      setIsManagingPayment(false);
    }
  };

  const currentPlan = normalizePlanId(workspace?.plan);

  const isAdminUser = userRole === 'admin' || userRole === 'owner';
  const railTriggerClass =
    'w-full justify-start gap-2 px-3 py-2 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground rounded-md';

  return (
    <AppLayout>
      <AppHeader title={t('account.title')} subtitle={t('account.subtitle')} />

      <div className="p-6">
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
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
            <TabsTrigger value="notifications" className={railTriggerClass}>
              <Bell className="h-4 w-4" />
              {t('account.notifications')}
            </TabsTrigger>
            <TabsTrigger value="subscription" className={railTriggerClass}>
              <CreditCard className="h-4 w-4" />
              {t('account.subscription')}
            </TabsTrigger>
            <TabsTrigger value="usage" className={railTriggerClass}>
              <BarChart3 className="h-4 w-4" />
              {t('account.usage')}
            </TabsTrigger>

            {isAdminUser && (
              <>
                <div className="hidden md:block h-px bg-border my-2" />
                <TabsTrigger value="workspace" className={railTriggerClass}>
                  <Settings2 className="h-4 w-4" />
                  {t('account.workspace_settings_link')}
                </TabsTrigger>
              </>
            )}

            <div className="hidden md:block h-px bg-border my-2" />
            <TabsTrigger value="other" className={railTriggerClass}>
              <Info className="h-4 w-4" />
              {t('account.other')}
            </TabsTrigger>
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
          </TabsContent>

          {/* Account (renamed from Security) */}
          <TabsContent value="account" className="space-y-6 mt-0">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.change_password')}</CardTitle>
                <CardDescription>{t('account.update_password')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="current-password">{t('account.current_password')}</Label>
                  <div className="relative">
                    <Input
                      id="current-password"
                      type={showPassword ? 'text' : 'password'}
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
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm-password">{t('account.confirm_password')}</Label>
                  <Input
                    id="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </div>
                <Button variant="accent" onClick={handleChangePassword} disabled={isChangingPassword}>
                  {isChangingPassword ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  {isChangingPassword ? t('account.updating') : t('account.update_password_btn')}
                </Button>
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

          {/* Notifications */}
          <TabsContent value="notifications" className="space-y-6 mt-0">
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
                    <p className="text-sm font-medium">Abstraction complete</p>
                    <p className="text-xs text-muted-foreground">
                      Email me when AI finishes extracting a lease
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

          {/* Subscription */}
          <TabsContent value="subscription" className="space-y-6 mt-0">
            {/* Current Plan & Usage */}
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {t('account.current_plan')}
                    <Badge variant={currentPlan === 'business' ? 'business' : 'secondary'}>
                      {PLANS[currentPlan]?.name || currentPlan}
                    </Badge>
                  </CardTitle>
                  {currentPlan !== 'starter' && (
                    <CardDescription>
                      {t('account.renews_on')}{' '}
                      {new Date(workspace?.renewalDate || '').toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-baseline justify-between mb-2">
                        <span className="text-sm font-medium">{t('account.document_usage')}</span>
                        <span className="text-sm text-muted-foreground">
                          {workspace?.documentsUsed} / {workspace?.documentLimit}
                        </span>
                      </div>
                      <Progress
                        value={workspace ? Math.min((workspace.documentsUsed / workspace.documentLimit) * 100, 100) : 0}
                        variant={
                          workspace && (workspace.documentsUsed / workspace.documentLimit) >= 0.9
                            ? 'destructive'
                            : workspace && (workspace.documentsUsed / workspace.documentLimit) >= 0.75
                            ? 'warning'
                            : 'accent'
                        }
                        className="h-2"
                      />
                    </div>
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
                      <p className="text-sm font-medium">{workspace?.name}</p>
                      <p className="text-sm text-muted-foreground">{user?.email || ''}</p>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={handleManagePayment}
                      disabled={isManagingPayment}
                    >
                      {t('account.update_billing')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Plans */}
            <div>
              <h2 className="text-lg font-semibold mb-4">{t('account.available_plans')}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {PLAN_ORDER.map((planId, index) => {
                  const plan = PLANS[planId];
                  const isCurrent = currentPlan === planId;
                  const isUpgradeOption = isUpgrade(currentPlan, planId);

                  return (
                    <Card
                      key={plan.id}
                      variant={plan.popular ? 'feature' : 'default'}
                      className={cn(
                        'relative animate-fade-up flex flex-col',
                        isCurrent && 'ring-2 ring-accent'
                      )}
                      style={{ animationDelay: `${index * 50}ms` }}
                    >
                      {isCurrent && (
                        <div className="absolute -top-3 right-3">
                          <Star className="h-6 w-6 text-yellow-500 fill-yellow-500" />
                        </div>
                      )}
                      {plan.popular && !isCurrent && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                          <Badge variant="pro">{t('account.popular')}</Badge>
                        </div>
                      )}
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">{t(plan.nameKey)}</CardTitle>
                        <div className="flex items-baseline gap-1 mt-1">
                          {plan.price.monthly === 0 ? (
                            <span className="text-2xl font-bold">{t('account.free')}</span>
                          ) : (
                            <>
                              <span className="text-2xl font-bold">${plan.price.monthly}</span>
                              <span className="text-muted-foreground text-sm">{t('account.per_month')}</span>
                            </>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {plan.maxActiveLeases === -1 ? 'Unlimited' : plan.maxActiveLeases} {plan.maxActiveLeases === 1 ? t('account.lease') : t('account.leases')}
                        </p>
                      </CardHeader>
                      <CardContent className="flex-1 flex flex-col">
                        <ul className="space-y-1.5 mb-4 flex-1">
                          {plan.featureKeys.slice(0, 4).map((featureKey) => (
                            <li key={featureKey} className="flex items-start gap-2 text-xs">
                              <Check className="h-3 w-3 text-success shrink-0 mt-0.5" />
                              <span className="text-muted-foreground">{t(featureKey)}</span>
                            </li>
                          ))}
                        </ul>
                        {isCurrent ? (
                          <Button variant="secondary" size="sm" className="w-full" disabled>
                            <Check className="h-4 w-4 mr-1" />
                            {t('account.current')}
                          </Button>
                        ) : isUpgradeOption ? (
                          <Button 
                            variant="accent" 
                            size="sm" 
                            className="w-full"
                            onClick={() => handleUpgrade(planId)}
                            disabled={isUpgrading === planId}
                          >
                            {isUpgrading === planId ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : null}
                            {t('common.upgrade')}
                          </Button>
                        ) : planId !== 'starter' ? (
                          <Button 
                            variant="outline" 
                            size="sm" 
                            className="w-full"
                            onClick={handleManagePayment}
                          >
                            {t('account.downgrade')}
                          </Button>
                        ) : (
                          <Button variant="ghost" size="sm" className="w-full" disabled>
                            {t('account.free_tier')}
                          </Button>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>

            {/* Cancel Subscription - only show if subscribed */}
            {currentPlan !== 'starter' && (
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
                  <Button 
                    variant="destructive"
                    onClick={handleManagePayment}
                  >
                    {t('account.cancel_subscription')}
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Usage — embedded inside Settings (Claude pattern) */}
          <TabsContent value="usage" className="space-y-6 mt-0">
            <UsageContent />
          </TabsContent>

          {/* Workspace — admin only, embedded inside Settings (Claude pattern) */}
          {isAdminUser && (
            <TabsContent value="workspace" className="mt-0">
              <WorkspaceSettings embedded />
            </TabsContent>
          )}

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
              </CardContent>
            </Card>
          </TabsContent>

          {/* Other — legal links + version */}
          <TabsContent value="other" className="space-y-6 mt-0">
            <Card>
              <CardHeader>
                <CardTitle>{t('account.other')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <Link to="/terms" className="text-primary hover:underline">{t('account.terms_link')}</Link>
                </div>
                <div>
                  <Link to="/privacy" className="text-primary hover:underline">{t('account.privacy_policy_link')}</Link>
                </div>
                <div>
                  <Link to="/app/support" className="text-primary hover:underline">{t('account.support_link')}</Link>
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

      {/* Upgrade Confirmation Dialog */}
      <AlertDialog open={!!confirmUpgradePlan} onOpenChange={() => setConfirmUpgradePlan(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Plan Change</AlertDialogTitle>
            <AlertDialogDescription>
              You are upgrading from {PLANS[currentPlan]?.name} to {confirmUpgradePlan ? PLANS[confirmUpgradePlan as SubscriptionPlan]?.name : ''}. 
              You'll be charged the difference prorated for your current billing period.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmUpgradePlan && proceedWithCheckout(confirmUpgradePlan)}>
              Continue to Checkout
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
