import { useState, useEffect } from 'react';
import { ChevronLeft, Lock, RotateCcw, Loader2, History, MoreHorizontal, Archive, ArchiveRestore } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LifecycleStatusBadge } from '@/components/lifecycle/LifecycleStatusBadge';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { ArchiveButton } from '@/components/leases/ArchiveButton';

interface PendingUnlockRequest {
  id: string;
  status: string;
  request_reason: string | null;
  created_at: string;
}

interface Props {
  title: string;
  subtitle?: string | null;
  lifecycleStatus: string | null;
  isAdmin: boolean;
  pendingUnlockRequest: PendingUnlockRequest | null;
  isRequestingUnlock: boolean;
  onRequestUnlock: () => void;
  onApproveUnlock: () => void;
  onDenyUnlock: () => void;
  onAdminUnlock: () => void;
  /** Archive control props — when present, the admin archive button renders. */
  leaseId?: string;
  isArchived?: boolean;
  onArchiveChange?: () => void;
  /** Vault read-only: suppress unlock controls and explain the state. Default false. */
  readOnly?: boolean;
}

export function LockedHeader({
  title,
  subtitle,
  lifecycleStatus,
  isAdmin,
  pendingUnlockRequest,
  isRequestingUnlock,
  onRequestUnlock,
  onApproveUnlock,
  onDenyUnlock,
  onAdminUnlock,
  leaseId,
  isArchived,
  onArchiveChange,
  readOnly = false,
}: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useAppTranslation();
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);

  // #116: honor the ?action=archive deep-link from ImportHistory's Archive
  // steer for a locked-active lease (this header owns the archive control for
  // that view). Opens the archive dialog for an admin and self-strips the param.
  useEffect(() => {
    if (searchParams.get('action') !== 'archive') return;
    if (!isAdmin || readOnly || isArchived) return;
    setArchiveDialogOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('action');
    setSearchParams(next, { replace: true });
  }, [searchParams, isAdmin, readOnly, isArchived, setSearchParams]);

  return (
    <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
      <div className="w-full px-6 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => navigate('/app/leases')}
              className="mt-0.5"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-bold text-foreground truncate max-w-[640px]">
                {title}
              </h1>
              <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                {lifecycleStatus ? <LifecycleStatusBadge status={lifecycleStatus as any} /> : null}
                {/* State + action fused: the padlock chip IS the unlock control
                    (admin → unlock confirm; member → request; pending/read-only
                    → static). One element instead of a pill + a button that
                    both said "locked". Label kept — icon-only unlock controls
                    test poorly for discoverability. */}
                <LockControl
                  readOnly={readOnly}
                  isAdmin={isAdmin}
                  pendingUnlockRequest={pendingUnlockRequest}
                  isRequestingUnlock={isRequestingUnlock}
                  onRequestUnlock={onRequestUnlock}
                  onAdminUnlock={onAdminUnlock}
                  t={t}
                />
                {isArchived && (
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                    <Archive className="h-3 w-3" />
                    {t('archive.deleted_badge')}
                  </span>
                )}
                {subtitle ? <span className="truncate">· {subtitle}</span> : null}
              </div>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-2">
            {readOnly && (
              <p className="text-sm text-muted-foreground">{t('readonly.lease_note')}</p>
            )}
            {/* Unlock now lives ON the Locked chip in the badge row (state +
                action fused); the header's action cluster is just the overflow. */}
            {leaseId && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label={t('common.more_actions')}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem asChild>
                    <Link to={`/app/reports/audit-log?leaseId=${leaseId}`}>
                      <History className="h-4 w-4 mr-2" />
                      {t('locked_lease.view_audit_trail')}
                    </Link>
                  </DropdownMenuItem>
                  {!readOnly && isAdmin && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setArchiveDialogOpen(true)}>
                        {isArchived ? (
                          <ArchiveRestore className="h-4 w-4 mr-2" />
                        ) : (
                          <Archive className="h-4 w-4 mr-2" />
                        )}
                        {isArchived ? t('archive.unarchive') : t('archive.archive')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {!readOnly && leaseId && isAdmin && (
              <ArchiveButton
                leaseId={leaseId}
                isArchived={!!isArchived}
                onChange={onArchiveChange}
                open={archiveDialogOpen}
                onOpenChange={setArchiveDialogOpen}
              />
            )}
          </div>
        </div>

        {/* Archived ("deleted") state must be unmissable — without this
            banner the page renders identically after a delete and users
            conclude the action failed. */}
        {isArchived && (
          <Card className="mt-3 shadow-none border border-destructive/40 bg-destructive/5">
            <CardContent className="py-3 px-4 flex items-center justify-between gap-4 flex-wrap">
              <p className="text-sm text-destructive min-w-0">
                {t('archive.deleted_banner')}
              </p>
              {!readOnly && isAdmin && leaseId && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setArchiveDialogOpen(true)}
                >
                  <ArchiveRestore className="h-3.5 w-3.5 mr-1.5" />
                  {t('archive.unarchive')}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {!readOnly && isAdmin && pendingUnlockRequest && (
          <Card className="mt-3 shadow-none border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
            <CardContent className="py-3 px-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  {t('locked_lease.unlock_requested_title')}
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                  {pendingUnlockRequest.request_reason
                    ? t('locked_lease.unlock_requested_reason', { reason: pendingUnlockRequest.request_reason })
                    : t('locked_lease.unlock_requested_no_reason')}
                </p>
              </div>
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onDenyUnlock}>
                {t('locked_lease.deny_unlock')}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// State-and-action fused: shows the locked state; clicking it is the unlock
// gesture appropriate to the viewer's role. Hover reveals intent via title +
// amber affordance for admins.
function LockControl({
  readOnly,
  isAdmin,
  pendingUnlockRequest,
  isRequestingUnlock,
  onRequestUnlock,
  onAdminUnlock,
  t,
}: {
  readOnly: boolean;
  isAdmin: boolean;
  pendingUnlockRequest: PendingUnlockRequest | null;
  isRequestingUnlock: boolean;
  onRequestUnlock: () => void;
  onAdminUnlock: () => void;
  t: (k: string) => string;
}) {
  const base =
    'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors';

  if (readOnly) {
    return (
      <span className={`${base} bg-muted border-transparent text-foreground/80`}>
        <Lock className="h-3 w-3" />
        {t('locked_lease.locked_badge')}
      </span>
    );
  }

  if (!isAdmin && pendingUnlockRequest) {
    return (
      <span
        className={`${base} bg-muted border-transparent text-muted-foreground`}
        title={t('locked_lease.unlock_pending')}
      >
        <Lock className="h-3 w-3" />
        {t('locked_lease.unlock_pending')}
      </span>
    );
  }

  const label = isAdmin
    ? pendingUnlockRequest
      ? t('locked_lease.approve_and_unlock')
      : t('locked_lease.admin_unlock')
    : t('locked_lease.request_unlock');

  return (
    <button
      type="button"
      onClick={isAdmin ? onAdminUnlock : onRequestUnlock}
      disabled={isRequestingUnlock}
      title={label}
      aria-label={label}
      className={`${base} bg-muted border-transparent text-foreground/80 hover:border-amber-400 hover:bg-amber-50 hover:text-amber-800 dark:hover:bg-amber-950/30 dark:hover:text-amber-300 disabled:opacity-60 group/lock`}
    >
      {isRequestingUnlock ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <>
          <Lock className="h-3 w-3 group-hover/lock:hidden" />
          <RotateCcw className="h-3 w-3 hidden group-hover/lock:inline" />
        </>
      )}
      <span className="group-hover/lock:hidden">{t('locked_lease.locked_badge')}</span>
      <span className="hidden group-hover/lock:inline">{label}</span>
    </button>
  );
}
