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

import { Link } from 'react-router-dom';
import { AlertTriangle, Download, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { graceDaysRemaining } from '@/lib/cancellationLifecycle';

export function CancellationBanner() {
  const { workspace, userRole } = useApp();
  const { t, language } = useLanguage();

  if (!workspace?.canceledAt || workspace.softDeletedAt) return null;

  const isAdmin = userRole === 'admin' || userRole === 'owner';
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
      </div>
    </div>
  );
}
