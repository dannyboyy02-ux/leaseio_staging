import { useState, useEffect, useRef } from 'react';
import { User, Lock, CreditCard, Trash2, Save, Eye, EyeOff, Loader2, LogOut, Palette, Shield, Mail, BarChart3, Building2, ChevronRight, Sun, Moon, Monitor, Archive } from 'lucide-react';
import { useTheme } from 'next-themes';
import { UsageContent } from '@/pages/app/UsageContent';
import { describeLoginEvent, type LoginEventRow } from '@/lib/loginActivity';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { PLANS, isUpgrade, isReadOnlyRetention, normalizePlanId } from '@/config/pricing';
import { trialDaysRemaining } from '@/lib/trialStatus';
import { DocumentPackDialog } from '@/components/workspace/DocumentPackDialog';
import { PlanPickerDialog } from '@/components/billing/PlanPickerDialog';
import type { SubscriptionPlan, BillingSummary } from '@/types';

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
];

/**
 * supabase.functions.invoke collapses any non-2xx response into a
 * FunctionsHttpError (a plain Error whose .message is the generic
 * "Edge Function returned a non-2xx status code") and nulls `data` — so the
 * server's structured `{ reason }` is ONLY reachable via the error's Response
 * body. Without this, every thoughtful server message (no_customer,
 * firm_managed, annual_not_configured, …) is invisible to the user. Mirrors
 * the pattern already used in CancellationBanner.tsx.
 */
async function extractFnReason(error: unknown): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await (error as any)?.context?.json?.();
    return (body?.reason as string) ?? null;
  } catch {
    return null;
  }
}

export default function AccountSettings() {
  const { user, workspace, userRole, refreshProfile, isLoading } = useApp();
  // Firm-bound: plan, payment, and capacity are all managed at the firm level;
  // the matching billing controls are hidden (their edge fns 403 firm_managed).
  const firmBound = Boolean(workspace?.firmId);
  const { user: authUser, signOut } = useAuth();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
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
  const [consentRevokeDialogOpen, setConsentRevokeDialogOpen] = useState(false);

  // Login activity — per-user sign-in history (login_events, RLS-scoped to
  // the signed-in user). Replaces the old lease-activity feed, which only
  // repeated what the Dashboard already shows. 5 most recent.
  const [loginEvents, setLoginEvents] = useState<LoginEventRow[]>([]);

  useEffect(() => {
    if (!authUser?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from('login_events')
        .select('id, created_at, ip, user_agent')
        .order('created_at', { ascending: false })
        .limit(5);
      if (cancelled) return;
      setLoginEvents((data ?? []) as LoginEventRow[]);
    })();
    return () => { cancelled = true; };
  }, [authUser?.id]);

  const relativeTime = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return t('account.time_just_now');
    if (m < 60) return t('account.time_minutes_ago', { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('account.time_hours_ago', { count: h });
    const d = Math.floor(h / 24);
    if (d < 30) return t('account.time_days_ago', { count: d });
    return new Date(iso).toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', { month: 'short', day: 'numeric' });
  };

  // Long date ("July 30, 2026") for billing period-end lines + toasts. Guards
  // an invalid/missing date so the UI never renders "Invalid Date".
  const formatLongDate = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLoggingOutOthers, setIsLoggingOutOthers] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState<string | null>(null);
  const [isManagingPayment, setIsManagingPayment] = useState(false);
  // In-app cancel/resume of the plan subscription (replaces the portal bounce).
  const [subActionBusy, setSubActionBusy] = useState(false);
  const [confirmUpgradePlan, setConfirmUpgradePlan] = useState<string | null>(null);
  const [confirmDowngradePlan, setConfirmDowngradePlan] = useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [packDialogOpen, setPackDialogOpen] = useState(false);
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  // Read-only billing summary (saved card + recent invoices) for the Payment
  // and Invoices sections. Fetched once when the Billing tab opens (admin-only)
  // — never on a render path; see the effect below.
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(null);
  const [billingSummaryLoading, setBillingSummaryLoading] = useState(false);
  const [billingSummaryError, setBillingSummaryError] = useState(false);
  const [billingRetry, setBillingRetry] = useState(0);
  const billingSummaryFetchedFor = useRef<string | null>(null);
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

    // Return from the Stripe billing portal (payment-method / invoices). The
    // portal round-trip used to terminate in silence — no toast, no refresh, so
    // an updated card still showed the old brand/last4. customer-portal now
    // stamps ?portal=return; on detecting it we refresh the profile + force the
    // billing-summary to re-fetch (resetting the per-workspace ref makes the
    // fetch effect re-run) and confirm with a neutral toast.
    if (searchParams.get('portal') === 'return') {
      toast.info(t('account.portal_return'));
      refreshProfile();
      billingSummaryFetchedFor.current = null;
      setBillingSummary(null);
      setBillingRetry((n) => n + 1);
      const next = new URLSearchParams(searchParams);
      next.delete('portal');
      navigate({ search: next.toString() ? `?${next.toString()}` : '' }, { replace: true });
    }

    // Deep-link from the quota banner's "Add capacity" CTA opens the pack dialog.
    // Suppressed on firm-bound workspaces — capacity is firm-managed (audit D1).
    if (searchParams.get('packs') === '1') {
      if (!firmBound) setPackDialogOpen(true);
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
  }, [searchParams, refreshProfile, firmBound]);

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

  // Revoke goes through a localized AlertDialog (not window.confirm) — the
  // Switch opens the dialog; this runs only after explicit confirmation.
  const handleRevokeAiConsent = async () => {
    if (!authUser?.id) return;
    setIsRevokingConsent(true);
    try {
      const { error } = await (supabase as any)
        .from('profiles')
        .update({ ai_processing_consent_at: null })
        .eq('id', authUser.id);
      if (error) throw error;
      setAiConsentAt(null);
      toast.success(t('account.consent_revoked_toast'));
    } catch (err) {
      console.error('Error revoking AI consent:', err);
      toast.error(t('account.consent_revoke_failed'));
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
      toast.success(t('account.consent_recorded_toast'));
    } catch (err) {
      console.error('Error granting AI consent:', err);
      toast.error(t('account.consent_record_failed'));
    } finally {
      setIsRevokingConsent(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!authUser) {
      toast.error(t('account.must_be_logged_in'));
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
      toast.success(t('account.profile_updated'));
    } catch (error) {
      console.error('Error saving profile:', error);
      toast.error(t('account.profile_save_failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPassword || !confirmPassword) {
      toast.error(t('account.password_enter_new'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('auth.errors.password_mismatch'));
      return;
    }
    if (newPassword.length < 6) {
      toast.error(t('account.password_min_length'));
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
      toast.success(t('account.password_updated'));
    } catch (error) {
      console.error('Error changing password:', error);
      toast.error(t('account.password_change_failed'));
    } finally {
      setIsChangingPassword(false);
    }
  };

  // Toggles autosave on flip (Claude pattern) — no Save button. The handler
  // takes the just-flipped values as overrides because React state hasn't
  // committed yet when onCheckedChange fires.
  const persistNotificationPrefs = async (overrides: {
    email?: boolean;
    sms?: boolean;
    abstraction?: boolean;
  }) => {
    if (!authUser?.id) return;

    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          email_notifications_enabled: overrides.email ?? emailNotifications,
          sms_notifications_enabled: overrides.sms ?? smsNotifications,
          notify_abstraction_complete: overrides.abstraction ?? notifyAbstractionComplete,
        } as any)
        .eq('id', authUser.id);

      if (error) throw error;
      // Shared id collapses rapid flips into one toast instead of a stack.
      toast.success(t('account.preference_saved'), { id: 'pref-saved' });
    } catch (error) {
      console.error('Error saving notification prefs:', error);
      toast.error(t('account.preferences_save_failed'));
    }
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    try {
      const { data, error } = await supabase.functions.invoke('delete-account');
      
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success(t('account.account_deleted'));
      await signOut();
      navigate('/');
    } catch (error) {
      console.error('Error deleting account:', error);
      toast.error(t('account.account_delete_failed'));
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
      toast.success(t('account.sessions_logged_out'));
    } catch (error) {
      console.error('Error logging out other sessions:', error);
      toast.error(t('account.sessions_logout_failed'));
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

  const proceedWithCheckout = async (planId: string, intervalOverride?: 'monthly' | 'annual') => {
    if (!workspace?.id) {
      toast.error(t('account.checkout_no_workspace'));
      return;
    }

    setIsUpgrading(planId);
    setConfirmUpgradePlan(null);

    try {
      // autoCheckout fires before the `?billing=` → billingInterval state effect
      // has necessarily run, so callers that know the interval (from the URL)
      // pass it explicitly — otherwise an Annual selection silently checks out
      // Monthly (journey walk).
      const interval = intervalOverride ?? billingInterval;
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { planId, workspaceId: workspace.id, billingInterval: interval },
      });

      if (error) {
        // Surface the server's real reason instead of the generic
        // "Edge Function returned a non-2xx status code" (see extractFnReason).
        const reason = await extractFnReason(error);
        throw new Error(mapCheckoutError(reason));
      }
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

  // Map a server `reason` to friendly, localized copy. Falls back to the
  // generic failure string for unknown reasons / network errors.
  const mapCheckoutError = (reason: string | null): string => {
    switch (reason) {
      case 'annual_not_configured':
        return t('account.err_annual_not_configured');
      case 'vault_not_configured':
        return t('account.err_vault_not_configured');
      case 'vault_owner_only':
        return t('account.err_vault_owner_only');
      case 'firm_managed':
        return t('account.err_firm_managed');
      default:
        return t('account.checkout_failed');
    }
  };

  const mapPortalError = (reason: string | null): string => {
    switch (reason) {
      case 'no_customer':
        return t('account.err_no_customer');
      case 'firm_managed':
        return t('account.err_firm_managed');
      case 'not_authorized':
        return t('account.err_not_authorized');
      default:
        return t('account.portal_failed');
    }
  };

  const mapSubError = (reason: string | null): string => {
    switch (reason) {
      case 'no_subscription':
        return t('account.err_no_subscription');
      case 'firm_managed':
        return t('account.err_firm_managed');
      case 'not_authorized':
        return t('account.err_not_authorized');
      default:
        return t('account.cancel_failed');
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
    // P0-h: the plan comes from the onboarding redirect (?plan=). Starter now
    // also auto-fires checkout (was hardcoded 'business'). Default to starter.
    const planParam = searchParams.get('plan');
    const checkoutPlan = planParam === 'business' ? 'business' : 'starter';
    // Read the interval straight from the URL — don't trust billingInterval
    // state, which the sibling `?billing=` effect may not have applied yet.
    const urlInterval = searchParams.get('billing') === 'annual' ? 'annual' : 'monthly';
    proceedWithCheckout(checkoutPlan, urlInterval);

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

      if (error) {
        const reason = await extractFnReason(error);
        throw new Error(mapPortalError(reason));
      }
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

  // In-app cancel / resume of the plan subscription. Replaces the old
  // "confirm dialog → Stripe portal → cancel AGAIN" double-cancel: the confirm
  // dialog's CTA now calls this directly (resume=false), and the scheduled-
  // cancel header's Resume button calls it with resume=true. Mirrors the
  // in-app pattern document packs + firm billing already use. On success we
  // refresh the workspace (status) AND the billing summary (the cancelAtPeriodEnd
  // signal the header reads) so the UI reflects the change immediately.
  const handleSetCancellation = async (resume: boolean) => {
    if (!workspace?.id) {
      toast.error(t('account.portal_no_workspace'));
      return;
    }
    setSubActionBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('cancel-subscription', {
        body: { workspaceId: workspace.id, resume },
      });
      if (error) {
        const reason = await extractFnReason(error);
        throw new Error(mapSubError(reason));
      }
      if (data?.error) throw new Error(data.error);

      setConfirmCancelOpen(false);
      await refreshProfile();
      // Force the billing-summary (scheduled-cancel signal) to re-fetch.
      billingSummaryFetchedFor.current = null;
      setBillingSummary(null);
      setBillingRetry((n) => n + 1);

      const date = formatLongDate(
        (data?.currentPeriodEnd as string | undefined) ?? workspace.subscriptionPeriodEnd,
      );
      toast.success(
        resume
          ? date
            ? t('account.resume_success_date', { date })
            : t('account.resume_success')
          : date
            ? t('account.cancel_success_date', { date })
            : t('account.cancel_success'),
      );
    } catch (err) {
      console.error('Error changing subscription cancellation:', err);
      toast.error(err instanceof Error ? err.message : t('account.cancel_failed'));
    } finally {
      setSubActionBusy(false);
    }
  };

  const currentPlan = normalizePlanId(workspace?.plan);

  const isAdminUser = userRole === 'admin' || userRole === 'owner';

  // Real billing dates come from subscription_period_end (mirrored from
  // Stripe by the webhook). Null until first checkout; guard every render
  // on validity so the UI never shows "Invalid Date".
  const formattedPeriodEnd = formatLongDate(workspace?.subscriptionPeriodEnd);
  const trialDaysLeft = trialDaysRemaining(workspace?.subscriptionPeriodEnd);

  // Scheduled-cancel signal — sourced from get-billing-summary (Stripe leaves
  // status='active' after a cancel is scheduled, so the persisted
  // subscription_status can't distinguish it). When set, the plan header shows
  // "Scheduled to cancel on {date}" + a Resume button instead of "Auto-renews".
  const scheduledCancel = Boolean(billingSummary?.subscription?.cancelAtPeriodEnd);
  const scheduledCancelDate = scheduledCancel
    ? formatLongDate(
        billingSummary?.subscription?.currentPeriodEnd ?? workspace?.subscriptionPeriodEnd,
      )
    : null;

  // Invoice formatting for the Billing tab's Invoices table.
  const localeTag = language === 'es' ? 'es-419' : 'en-US';
  const formatInvoiceDate = (unixSeconds: number) =>
    new Date(unixSeconds * 1000).toLocaleDateString(localeTag, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  const formatInvoiceAmount = (minorUnits: number, currency: string) =>
    new Intl.NumberFormat(localeTag, {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
    }).format((minorUnits ?? 0) / 100);
  const invoiceStatusVariant = (
    status: string | null,
  ): 'success' | 'warning' | 'secondary' | 'outline' =>
    status === 'paid'
      ? 'success'
      : status === 'open'
        ? 'warning'
        : status === 'draft'
          ? 'outline'
          : 'secondary';
  const railTriggerClass =
    'md:w-full justify-start gap-2 px-3 py-2 text-sm font-medium data-[state=active]:bg-muted data-[state=active]:text-foreground rounded-md';

  // Write the tab to the URL on change so refresh/back/share keep position.
  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    const next = new URLSearchParams(searchParams);
    next.set('tab', tab);
    navigate({ search: `?${next.toString()}` }, { replace: true });
  };

  // Fetch the card + invoices once when the Billing tab opens. Admin-only
  // (members can't manage billing and the edge function 403s them), guarded by
  // a per-workspace ref so re-renders / tab toggles never re-hit Stripe.
  // `billingRetry` is the only dep that re-runs it after the first load.
  useEffect(() => {
    if (activeTab !== 'billing') return;
    if (!workspace?.id || !isAdminUser) return;
    if (billingSummaryFetchedFor.current === workspace.id) return;
    billingSummaryFetchedFor.current = workspace.id;
    let cancelled = false;
    setBillingSummaryLoading(true);
    setBillingSummaryError(false);
    supabase.functions
      .invoke('get-billing-summary', { body: { workspaceId: workspace.id } })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || (data && (data as { error?: string }).error)) {
          setBillingSummaryError(true);
          return;
        }
        setBillingSummary(data as BillingSummary);
      })
      .catch(() => {
        if (!cancelled) setBillingSummaryError(true);
      })
      .finally(() => {
        if (!cancelled) setBillingSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, workspace?.id, isAdminUser, billingRetry]);

  const retryBillingSummary = () => {
    billingSummaryFetchedFor.current = null;
    setBillingSummary(null);
    setBillingRetry((n) => n + 1);
  };

  // "Adjust plan" routing: upgrades go through the existing checkout handler
  // (handleUpgrade → proceedWithCheckout), downgrades through the existing
  // feature-loss confirm dialog + portal (setConfirmDowngradePlan). The picker
  // itself owns no billing logic.
  const handleAdjustPlanSelect = (planId: SubscriptionPlan) => {
    setPlanPickerOpen(false);
    if (isUpgrade(currentPlan as SubscriptionPlan, planId)) {
      handleUpgrade(planId);
    } else {
      setConfirmDowngradePlan(planId);
    }
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
          <TabsList className="h-auto flex-wrap shrink-0 md:w-56 md:flex-col md:items-stretch md:justify-start md:bg-transparent md:p-0 md:gap-1 md:sticky md:top-20 md:self-start md:max-h-[calc(100vh-6rem)] md:overflow-y-auto">
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

          {/* Content panel — capped width (matches the Workspaces settings
              surface) so forms don't stretch on wide monitors; min-h stabilizes
              the layout so switching tabs with different content lengths doesn't
              make the page reflow. */}
          <div className="flex-1 min-w-0 max-w-4xl md:min-h-[32rem]">

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
                {/* Phone field removed (#69/#80): profiles has no phone column,
                    so the input was a dead control — Save discarded it while
                    toasting success. Restore only alongside a real phone column
                    + load/save wiring. */}
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
                      <SelectValue placeholder={t('workspace.select_timezone')} />
                    </SelectTrigger>
                    <SelectContent>
                      {timezones.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>
                          {t(`workspace.tz.${tz.value}`, { defaultValue: tz.label })}
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
                    onCheckedChange={(v) => {
                      setEmailNotifications(v);
                      void persistNotificationPrefs({ email: v });
                    }}
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
                    onCheckedChange={(v) => {
                      setSmsNotifications(v);
                      void persistNotificationPrefs({ sms: v });
                    }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{t('account.notify_abstraction_complete')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('account.notify_abstraction_complete_desc')}
                    </p>
                  </div>
                  <Switch
                    checked={notifyAbstractionComplete}
                    onCheckedChange={(v) => {
                      setNotifyAbstractionComplete(v);
                      void persistNotificationPrefs({ abstraction: v });
                    }}
                  />
                </div>
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
                <CardTitle>{t('account.login_activity')}</CardTitle>
                <CardDescription>{t('account.login_activity_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {loginEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic py-2">
                    {t('account.login_activity_empty')}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {loginEvents.map((row) => (
                      <li
                        key={row.id}
                        className="flex items-center justify-between gap-3 py-2.5"
                      >
                        <p className="text-sm font-medium text-foreground truncate min-w-0">
                          {describeLoginEvent(row, t('account.login_unknown_device'))}
                        </p>
                        <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                          {relativeTime(row.created_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
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
          <TabsContent value="billing" className="space-y-8 mt-0">
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
            {/* Firm-bound: plan + billing are managed at the firm level. */}
            {firmBound && (
              <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
                <p className="text-sm font-medium text-foreground">{t('account.firm_managed_title')}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('account.firm_managed_desc', { firm: workspace.firmName ?? t('account.firm_fallback') })}
                </p>
              </div>
            )}

            {/* Trial banner — visible while subscription is in Stripe's trial window.
                Suppressed on firm-bound workspaces: the firm owns billing (audit D1).
                When a cancel is SCHEDULED the charge warning would be a lie
                ("card will be charged on X" directly above "Scheduled to cancel
                on X" — live walkthrough 2026-07-12), so the banner swaps to the
                honest no-charge variant. The payment-method button was removed:
                the Payment section directly below is the single portal door
                (one action, one label — the banner is informational). */}
            {!firmBound && workspace.subscriptionStatus === 'trialing' && formattedPeriodEnd && (
              scheduledCancel ? (
                <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
                  <p className="text-sm font-medium text-foreground">{t('account.trial_canceled_banner_title')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('account.trial_canceled_banner_desc', { date: scheduledCancelDate ?? formattedPeriodEnd })}
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3">
                  <p className="text-sm font-medium text-foreground">{t('account.trial_banner_title')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {trialDaysLeft === 0
                      ? t('account.trial_banner_desc_today')
                      : t('account.trial_banner_desc', {
                          days: t('account.trial_days_left', { count: trialDaysLeft ?? 0 }),
                          date: formattedPeriodEnd,
                        })}
                  </p>
                </div>
              )
            )}

            {/* Past-due / unpaid / incomplete states — payment failed; user must update method.
                Suppressed on firm-bound workspaces — the firm owns billing and the
                child admin cannot fix a firm sub from here (audit D1); a stale
                status would otherwise show an alarming red button that 403s. */}
            {!firmBound && workspace?.subscriptionStatus &&
              ['past_due', 'unpaid', 'incomplete'].includes(workspace.subscriptionStatus) && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/5 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-sm font-medium text-destructive">{t('account.past_due_banner_title')}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('account.past_due_banner_desc')}</p>
                  </div>
                  {isAdminUser ? (
                    <Button variant="destructive" size="sm" onClick={handleManagePayment} disabled={isManagingPayment}>
                      {isManagingPayment ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                      {t('account.update_payment_method')}
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('account.billing_admin_only')}</p>
                  )}
                </div>
              )}

            {/* P0-h — NEVER-SUBSCRIBED recovery. A workspace that never started a
                subscription (signup checkout abandoned/canceled) is blocked from
                processing by the no_subscription gate; without a visible CTA the
                user is stranded (told they "have Starter" but can't do anything).
                Fires for BOTH plans (was Business-only), starting the 7-day trial
                for the user's intended plan (or the current plan). Hidden for
                vault (its own reactivation surface) and cancellation grace (its
                own banner). */}
            {currentPlan !== 'vault' &&
              !workspace?.canceledAt &&
              workspace?.subscriptionStatus !== 'active' &&
              workspace?.subscriptionStatus !== 'trialing' &&
              !workspace?.subscriptionStatus && (() => {
                const startPlan = workspace?.intendedPlan === 'business' ? 'business' : currentPlan;
                return (
                <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t('account.start_trial_callout_title')}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('account.start_trial_callout_desc')}</p>
                  </div>
                  {isAdminUser ? (
                    <Button size="sm" onClick={() => proceedWithCheckout(startPlan)} disabled={isUpgrading !== null}>
                      {isUpgrading !== null ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                      {t('account.start_trial_callout_cta')}
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('account.billing_admin_only')}</p>
                  )}
                </div>
                );
              })()}

            {/* Plan header — calm Claude-style summary. Vault swaps in its own
                reactivation surface in place of the generic header. */}
            {currentPlan === 'vault' ? (
              <section>
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                    <Archive className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-foreground">{t('account.vault_card_title')}</p>
                    <p className="text-sm text-muted-foreground mt-0.5 max-w-prose">
                      {formattedPeriodEnd
                        ? t('account.vault_card_desc', { date: formattedPeriodEnd, price: PLANS.vault.price.annual })
                        : t('account.vault_card_desc_nodate', { price: PLANS.vault.price.annual })}
                    </p>
                  </div>
                </div>
                {isAdminUser ? (
                  <div className="flex flex-wrap items-center gap-2 mt-4">
                    <Button onClick={() => proceedWithCheckout('starter')} disabled={isUpgrading !== null}>
                      {isUpgrading === 'starter' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                      {t('account.vault_reactivate_starter')}
                    </Button>
                    <Button variant="outline" onClick={() => proceedWithCheckout('business')} disabled={isUpgrading !== null}>
                      {isUpgrading === 'business' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                      {t('account.vault_reactivate_business')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground mt-3">{t('account.billing_admin_only')}</p>
                )}
              </section>
            ) : (
              <section>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <CreditCard className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-base font-semibold text-foreground">{t(PLANS[currentPlan].nameKey)}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{t(`account.plan_benefit_${currentPlan}`)}</p>
                      {/* Scheduled-cancel wins over the renewal line: once a
                          cancel is scheduled Stripe keeps status='active', so
                          without this the header would falsely read "Auto-renews".
                          We only ASSERT renewal when the cancel flag is actually
                          known (billingSummary.subscription is present — i.e. an
                          admin whose summary loaded). A viewer who can't see the
                          flag (non-admin, or a transient retrieve failure) gets
                          NO line rather than a possibly-false "Auto-renews"
                          (integrity review 2026-07-11). Paid Starter renews too. */}
                      {scheduledCancel && scheduledCancelDate ? (
                        <p className="text-sm text-amber-600 dark:text-amber-500 mt-0.5 font-medium">
                          {t('account.scheduled_cancel_on', { date: scheduledCancelDate })}
                        </p>
                      ) : billingSummary?.subscription &&
                        workspace.subscriptionStatus === 'active' &&
                        formattedPeriodEnd ? (
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {t('account.auto_renews_on', { date: formattedPeriodEnd })}
                        </p>
                      ) : null}
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline mt-1"
                        onClick={() => handleTabChange('usage')}
                      >
                        {t('account.view_usage_link')}
                      </button>
                    </div>
                  </div>
                  {firmBound ? null : !isAdminUser ? (
                    <p className="text-xs text-muted-foreground shrink-0">{t('account.plan_changes_admin_only')}</p>
                  ) : scheduledCancel ? (
                    /* Reverse the scheduled cancel in-app — same edge fn,
                       resume=true. Prevents the "can't undo without the portal"
                       dead-end. */
                    <Button size="sm" onClick={() => handleSetCancellation(true)} disabled={subActionBusy}>
                      {subActionBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                      {t('account.resume_subscription')}
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setPlanPickerOpen(true)}>
                      {t('account.adjust_plan')}
                    </Button>
                  )}
                </div>
              </section>
            )}

            {/* Payment + Invoices are workspace-scoped billing. On firm-bound
                workspaces the firm owns billing (the banner above explains) and
                get-billing-summary is workspace-scoped, so these would render
                empty/actionless — hide them entirely rather than show a header
                over a bare card line + a button that 403s (audit D1). */}
            {!firmBound && (
            <>
            {/* Payment — saved card from get-billing-summary; "Update" opens the
                Stripe portal. Card data is admin-only (privileged); members see
                an explanatory note rather than an empty section. */}
            <section>
              <div className="flex items-center justify-between gap-3 mb-3">
                <h3 className="text-sm font-semibold text-foreground">{t('account.payment')}</h3>
                {/* Always available to admins (opens the Stripe portal) — a
                    subscriber always has a customer to manage, even before a
                    card detail loads. */}
                {isAdminUser && !billingSummaryLoading && (
                  <Button variant="outline" size="sm" onClick={handleManagePayment} disabled={isManagingPayment}>
                    {isManagingPayment ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {billingSummary?.card
                      ? t('account.payment_update')
                      : t('account.payment_add')}
                  </Button>
                )}
              </div>
              {!isAdminUser ? (
                <p className="text-sm text-muted-foreground">{t('account.billing_admin_only')}</p>
              ) : billingSummaryLoading ? (
                <Skeleton className="h-8 w-44" />
              ) : billingSummaryError ? (
                <div className="flex items-center gap-3">
                  <p className="text-sm text-muted-foreground">{t('account.billing_summary_error')}</p>
                  <Button variant="ghost" size="sm" onClick={retryBillingSummary}>{t('account.retry')}</Button>
                </div>
              ) : billingSummary?.card ? (
                <div className="flex items-center gap-3">
                  <div className="h-8 w-12 rounded border border-border bg-muted flex items-center justify-center">
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                  </div>
                  {/* Card → "Visa •••• 4242"; a wallet/bank method (Stripe Link,
                      Apple Pay, ACH) has no last4 → render its label so a paying
                      customer never sees a blank "no payment method" line
                      (incident 2026-07-11). `capitalize` ONLY on the brand line —
                      applied to a label it mangled the Link email into
                      "Lat36foods@Gmail.Com" (live walkthrough 2026-07-12). */}
                  <span
                    className={cn(
                      'text-sm text-foreground',
                      billingSummary.card.last4 && 'capitalize',
                    )}
                  >
                    {billingSummary.card.last4
                      ? `${billingSummary.card.brand ?? ''} •••• ${billingSummary.card.last4}`
                      : (billingSummary.card.label ?? t('account.payment_none'))}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('account.payment_none')}</p>
              )}
            </section>

            {/* Invoices — recent history from get-billing-summary; admin-only
                data, members see an explanatory note. */}
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-3">{t('account.invoices')}</h3>
              {!isAdminUser ? (
                <p className="text-sm text-muted-foreground">{t('account.billing_admin_only')}</p>
              ) : billingSummaryLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : billingSummaryError ? (
                <p className="text-sm text-muted-foreground">{t('account.billing_summary_error')}</p>
              ) : (billingSummary?.invoices?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">{t('account.invoices_empty')}</p>
              ) : (
                <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('account.invoice_col_date')}</TableHead>
                        <TableHead>{t('account.invoice_col_total')}</TableHead>
                        <TableHead>{t('account.invoice_col_status')}</TableHead>
                        <TableHead className="text-right">{t('account.invoice_col_actions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(billingSummary?.invoices ?? []).map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="whitespace-nowrap">{formatInvoiceDate(inv.created)}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatInvoiceAmount(inv.total, inv.currency)}</TableCell>
                          <TableCell>
                            <Badge variant={invoiceStatusVariant(inv.status)}>
                              {inv.status ? t(`account.invoice_status_${inv.status}`) : '—'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {/* Hosted page + direct PDF. Stripe's hosted invoice
                                page is a JS app (blank under content blockers —
                                owner report 2026-07-12, verified server-side:
                                200 OK but a 745-byte script shell); the PDF
                                downloads with no JS, so it's the robust path. */}
                            {inv.hostedInvoiceUrl || inv.invoicePdf ? (
                              <span className="inline-flex items-center gap-3">
                                {inv.hostedInvoiceUrl && (
                                  <a
                                    href={inv.hostedInvoiceUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline text-sm"
                                  >
                                    {t('account.invoice_view')}
                                  </a>
                                )}
                                {inv.invoicePdf && (
                                  <a
                                    href={inv.invoicePdf}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline text-sm"
                                  >
                                    {t('account.invoice_pdf')}
                                  </a>
                                )}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-sm">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </section>
            </>
            )}

            {/* Capacity packs moved to the Usage tab's Active leases row
                (2026-06-15) to keep Billing focused on plan + payment + invoices.
                The pack dialog is still mounted below and is opened from there
                via the onAddCapacity prop, plus the quota-banner ?packs=1
                deep-link. */}

            {/* Single-lease credits — only renders while a balance exists.
                Credits are granted by the Stripe webhook on a one-time
                purchase from the limit wall and consumed by process_lease.
                Hidden on read-only Vault (credits are unusable there). */}
            {currentPlan !== 'vault' && (workspace.purchasedLeaseCredits ?? 0) > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-foreground mb-1">{t('account.credits_title')}</h3>
                <p className="text-sm text-muted-foreground">{t('account.credits_desc')}</p>
                <p className="text-sm font-medium text-foreground mt-1">
                  {t('account.credits_balance', { count: workspace.purchasedLeaseCredits })}
                </p>
              </section>
            )}

            {/* Cancel subscription — any active/paid subscription (paid Starter
                included), admin-only. Hidden once a cancel is already scheduled
                (the plan header then shows the Resume affordance instead — never
                offer Cancel and Resume at once). Excluded on Vault: it's a
                read-only retention offramp ("nothing is deleted"), so a
                delete-everything cancel CTA under the Reactivate header would
                contradict the tier; Vault renewal/cancellation lives in the
                Stripe portal. */}
            {!firmBound &&
              currentPlan !== 'vault' &&
              !scheduledCancel &&
              ['active', 'trialing', 'past_due'].includes(workspace.subscriptionStatus ?? '') &&
              isAdminUser && (
                <section>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-foreground">{t('account.cancel_subscription')}</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive border-destructive/40 hover:text-destructive hover:bg-destructive/10"
                      onClick={() => setConfirmCancelOpen(true)}
                    >
                      {t('account.cancel_subscription')}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 max-w-prose">{t('account.cancel_warning')}</p>
                </section>
              )}
            </>
            )}
          </TabsContent>

          {/* Usage — embedded inside Settings (Claude pattern) */}
          <TabsContent value="usage" className="space-y-6 mt-0">
            <UsageContent onAddCapacity={firmBound ? undefined : () => setPackDialogOpen(true)} />
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
            {/* Claude-pattern rows: label + description on the left, the
                control (toggle or action button) on the right. AI consent is
                the one stored boolean here, so it renders as a Switch; the
                rest are inherently actions. */}
            <Card>
              <CardHeader>
                <CardTitle>{t('account.privacy_ai_title')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-muted-foreground">{t('account.privacy_ai_desc')}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {aiConsentAt
                        ? `${t('account.privacy_consent_recorded')} ${new Date(aiConsentAt).toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`
                        : t('account.privacy_consent_revoked')}
                    </p>
                  </div>
                  <Switch
                    checked={!!aiConsentAt}
                    disabled={isRevokingConsent}
                    aria-label={t('account.privacy_ai_title')}
                    onCheckedChange={(v) => {
                      if (v) void handleGrantAiConsent();
                      else setConsentRevokeDialogOpen(true);
                    }}
                  />
                </div>
                <AlertDialog
                  open={consentRevokeDialogOpen}
                  onOpenChange={setConsentRevokeDialogOpen}
                >
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('account.consent_revoke_title')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('account.consent_revoke_desc')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          setConsentRevokeDialogOpen(false);
                          void handleRevokeAiConsent();
                        }}
                      >
                        {t('account.consent_revoke_cta')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('account.privacy_data_export')}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm text-muted-foreground min-w-0">
                    {t('account.privacy_data_export_desc')}
                  </p>
                  <Button variant="outline" className="shrink-0" asChild>
                    <a href="mailto:privacy@theleaseio.com?subject=Data%20Export%20Request">
                      <Mail className="h-4 w-4 mr-2" />
                      {t('account.privacy_request_export')}
                    </a>
                  </Button>
                </div>
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
                <div className="flex items-start justify-between gap-4">
                  <ul className="text-sm text-muted-foreground space-y-1 ml-5 list-disc min-w-0">
                    <li>{t('account.privacy_right_access')}</li>
                    <li>{t('account.privacy_right_correct')}</li>
                    <li>{t('account.privacy_right_delete')}</li>
                    <li>{t('account.privacy_right_portability')}</li>
                    <li>{t('account.privacy_right_object')}</li>
                  </ul>
                  <Button variant="outline" className="shrink-0" asChild>
                    <a href="mailto:privacy@theleaseio.com?subject=Privacy%20Rights%20Request&body=Please%20describe%20your%20request%20(access%2C%20correction%2C%20deletion%2C%20portability%2C%20or%20objection)%20and%20we'll%20respond%20within%2030%20days.">
                      <Mail className="h-4 w-4 mr-2" />
                      {t('account.privacy_rights_contact_btn')}
                    </a>
                  </Button>
                </div>
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

      {/* "Adjust plan" picker — replaces the inline upgrade card + downgrade
          hint. Delegates to handleAdjustPlanSelect, which routes through the
          existing upgrade/downgrade handlers + confirm dialogs below. */}
      <PlanPickerDialog
        open={planPickerOpen}
        onOpenChange={setPlanPickerOpen}
        currentPlan={currentPlan as SubscriptionPlan}
        billingInterval={billingInterval}
        onBillingIntervalChange={setBillingInterval}
        onSelectPlan={handleAdjustPlanSelect}
        isBusy={isUpgrading}
      />

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

      {/* Downgrade Confirmation Dialog — spells out Business feature loss,
          then routes through CHECKOUT like an upgrade (2026-07-12): one
          consistent plan-change flow. The webhook cancels the displaced sub
          automatically, and the portal is card-management-only now, so the
          old "finish in the billing portal" handoff would dead-end. */}
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
                const planId = confirmDowngradePlan;
                setConfirmDowngradePlan(null);
                if (planId) proceedWithCheckout(planId);
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
          {/* Vault offramp (VAULT_TIER_SPEC.md V3): convert-at-grace model —
              the actual $249/yr Vault checkout lives on the grace banner once
              the plan ends, so here we only set the expectation. Hidden when
              the workspace is ALREADY on Vault (a Vault sub is 'active', so
              this cancel card renders — offering Vault to someone on Vault
              would contradict itself; polish review 2026-06-13). */}
          {!isReadOnlyRetention(workspace?.plan) && (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              {t('account.cancel_vault_note', { price: PLANS.vault.price.annual })}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={subActionBusy}>{t('account.keep_subscription')}</AlertDialogCancel>
            {/* This CTA now CANCELS in-app (cancel-subscription edge fn, sets
                cancel_at_period_end) — no more portal round-trip / double
                confirm. preventDefault keeps the dialog open while the request
                is in flight (spinner) and on error; handleSetCancellation closes
                it on success. */}
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={subActionBusy}
              onClick={(e) => {
                e.preventDefault();
                handleSetCancellation(false);
              }}
            >
              {subActionBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
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
  const { t } = useLanguage();
  const options: Array<{ value: 'light' | 'dark' | 'system'; label: string; Icon: typeof Sun }> = [
    { value: 'light', label: t('account.theme_light'), Icon: Sun },
    { value: 'dark', label: t('account.theme_dark'), Icon: Moon },
    { value: 'system', label: t('account.theme_system'), Icon: Monitor },
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
