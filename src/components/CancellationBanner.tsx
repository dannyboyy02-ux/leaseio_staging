// Cancellation-lifecycle surfaces (ratified 2026-06-12).
//
// Two states, both driven by billing-system-owned workspace columns:
//   GRACE (canceledAt set, softDeletedAt null) — persistent, non-dismissible
//   banner: view/export until graceExpiresAt, then deletion. Renew CTA for
//   admins; export link for everyone.
//   SOFT-DELETED (softDeletedAt set) — full-screen wall replacing the page
//   content: access has ended, deletion scheduled; renewing before the purge
//   restores everything.
//
// The server backstop lives in process_lease (uploads/AI blocked when
// canceled); these surfaces are the honest UX layer over it.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Download, Sparkles, Archive, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { graceDaysRemaining } from '@/lib/cancellationLifecycle';
import { PLANS } from '@/config/pricing';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const VAULT_PRICE = PLANS.vault.price.annual;

export function CancellationBanner() {
  const { workspace, userRole } = useApp();
  const { t, language } = useLanguage();
  const [vaultLoading, setVaultLoading] = useState(false);

  if (!workspace?.canceledAt || workspace.softDeletedAt) return null;

  const isAdmin = userRole === 'admin' || userRole === 'owner';
  // Vault conversion is OWNER-ONLY (members lose access in Vault) — the server
  // enforces this too (create-checkout rejects non-owners with vault_owner_only).
  const isOwner = userRole === 'owner';

  const handleVaultCheckout = async () => {
    if (!workspace?.id) return;
    setVaultLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { planId: 'vault', workspaceId: workspace.id },
      });
      if (error) {
        // supabase-js collapses any non-2xx into a FunctionsHttpError and
        // nulls `data`, so the server's reason ('vault_not_configured' when
        // the Stripe price isn't set; 'vault_owner_only') is only reachable
        // via the response body. A config/permission failure will NEVER
        // succeed on retry, so it must route to support, not "try again."
        let reason: string | undefined;
        try {
          // deno-lint-ignore no-explicit-any
          reason = (await (error as any)?.context?.json?.())?.reason;
        } catch { /* body not JSON / unavailable — fall through to generic */ }
        throw new Error(
          reason === 'vault_not_configured' || reason === 'vault_owner_only'
            ? t('cancellation.vault_unavailable')
            : t('cancellation.vault_failed'),
        );
      }
      if (data?.error) throw new Error(t('cancellation.vault_failed'));
      if (data?.url) {
        // Same-tab redirect — a post-await window.open is popup-blocked.
        window.location.href = data.url;
      }
    } catch (err) {
      console.error('Vault checkout failed:', err);
      toast.error(err instanceof Error ? err.message : t('cancellation.vault_failed'));
    } finally {
      setVaultLoading(false);
    }
  };
  const daysLeft = workspace.graceExpiresAt
    ? graceDaysRemaining(workspace.graceExpiresAt)
    : 0;
  const endDate = workspace.graceExpiresAt
    ? new Date(workspace.graceExpiresAt).toLocaleDateString(
        language === 'es' ? 'es-419' : 'en-US',
        { month: 'long', day: 'numeric', year: 'numeric' },
      )
    : '';

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-6 py-3 text-sm"
    >
      <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
      <span className="flex-1 min-w-[16rem] text-foreground">
        {t('cancellation.banner_text', { date: endDate, count: daysLeft })}
      </span>
      <Button asChild size="sm" variant="outline">
        <Link to="/app/reports">
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {t('cancellation.export_cta')}
        </Link>
      </Button>
      {isOwner && (
        <Button
          size="sm"
          variant="secondary"
          disabled={vaultLoading}
          onClick={handleVaultCheckout}
        >
          {vaultLoading ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Archive className="h-3.5 w-3.5 mr-1.5" />
          )}
          {vaultLoading
            ? t('cancellation.vault_redirecting')
            : t('cancellation.vault_cta', { price: VAULT_PRICE })}
        </Button>
      )}
      {isAdmin && (
        <Button asChild size="sm">
          <Link to="/app/settings/account?tab=billing">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            {t('cancellation.renew_cta')}
          </Link>
        </Button>
      )}
    </div>
  );
}

/** Full-page wall for a soft-deleted workspace — access has ended. */
export function SoftDeletedWall() {
  const { workspace, userRole } = useApp();
  const { t } = useLanguage();
  const isAdmin = userRole === 'admin' || userRole === 'owner';

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
        <h2 className="mt-4 text-lg font-semibold">{t('cancellation.wall_title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('cancellation.wall_desc', { name: workspace?.name ?? '' })}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          {isAdmin ? (
            <Button asChild>
              <Link to="/app/settings/account?tab=billing">
                <Sparkles className="h-4 w-4 mr-2" />
                {t('cancellation.renew_cta')}
              </Link>
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">{t('cancellation.wall_ask_admin')}</p>
          )}
          <Button asChild variant="outline">
            <a href="mailto:support@theleaseio.com?subject=Restore%20workspace">
              {t('cancellation.contact_support')}
            </a>
          </Button>
        </div>
        {/* Vault is a grace-window offramp (ratified 2026-06-13); once
            soft-deleted, renewing is the only path. Stating it avoids a
            silent "where did the Vault option go" dead-end. */}
        {isAdmin && (
          <p className="mt-4 text-xs text-muted-foreground">
            {t('cancellation.wall_vault_note')}
          </p>
        )}
      </div>
    </div>
  );
}
