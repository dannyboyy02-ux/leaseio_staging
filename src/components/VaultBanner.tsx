// Vault retention-tier surfaces (VAULT_TIER_SPEC.md V4).
//
// A Vault workspace is an ACTIVE $249/yr read-only repository — distinct from
// the grace / soft-deleted cancellation states (those have canceled_at set and
// are handled by CancellationBanner; a Vault workspace has canceled_at NULL).
// The OWNER sees a read-only banner over the full repository (view + export —
// the flatten rule); NON-owner members are walled, because Vault is owner-only.
//
// Server enforcement is the V1 restrictive-RLS layer + the read-only config
// guard (20260613010000); these are the honest UX layer over it. Detection is
// isReadOnlyRetention(plan) — the same helper the read/export gates use.

import { Link } from 'react-router-dom';
import { Archive, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { PLANS, isReadOnlyRetention } from '@/config/pricing';

const VAULT_PRICE = PLANS.vault.price.annual;

/** Owner banner for a Vault workspace: read-only state, renewal date, reactivate. */
export function VaultBanner() {
  const { workspace, userRole } = useApp();
  const { t, language } = useLanguage();

  if (!isReadOnlyRetention(workspace?.plan)) return null;
  // Non-owners get the wall (below), never the banner.
  if (userRole !== 'owner') return null;

  const renewDate = workspace?.subscriptionPeriodEnd
    ? new Date(workspace.subscriptionPeriodEnd).toLocaleDateString(
        language === 'es' ? 'es-419' : 'en-US',
        { month: 'long', day: 'numeric', year: 'numeric' },
      )
    : '';

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-border bg-muted/50 px-6 py-3 text-sm"
    >
      <Archive className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="flex-1 min-w-[16rem] text-foreground">
        {renewDate
          ? t('vault.banner_text', { date: renewDate, price: VAULT_PRICE })
          : t('vault.banner_text_nodate', { price: VAULT_PRICE })}
      </span>
      <Button asChild size="sm">
        <Link to="/app/settings/account?tab=billing">
          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          {t('vault.reactivate_cta')}
        </Link>
      </Button>
    </div>
  );
}

/** Full-page wall for a NON-owner member of a Vault (owner-only) workspace. */
export function VaultMemberWall() {
  const { workspace } = useApp();
  const { t } = useLanguage();

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <Archive className="mx-auto h-10 w-10 text-muted-foreground" />
        <h2 className="mt-4 text-lg font-semibold">{t('vault.member_wall_title')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('vault.member_wall_desc', { name: workspace?.name ?? '' })}
        </p>
      </div>
    </div>
  );
}
