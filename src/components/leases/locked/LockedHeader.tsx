import { ChevronLeft, Lock, RotateCcw, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
}: Props) {
  const navigate = useNavigate();
  const { t } = useAppTranslation();

  return (
    <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
      <div className="max-w-6xl mx-auto px-6 py-4">
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
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-foreground/80">
                  <Lock className="h-3 w-3" />
                  {t('locked_lease.locked_badge')}
                </span>
                {subtitle ? <span className="truncate">· {subtitle}</span> : null}
              </div>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-2">
            {!isAdmin && !pendingUnlockRequest && (
              <Button variant="outline" size="sm" onClick={onRequestUnlock} disabled={isRequestingUnlock}>
                {isRequestingUnlock ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t('locked_lease.request_unlock')}
              </Button>
            )}
            {!isAdmin && pendingUnlockRequest && (
              <span className="text-xs text-muted-foreground">{t('locked_lease.unlock_pending')}</span>
            )}
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="border-amber-400 text-amber-800 hover:bg-amber-100 dark:text-amber-300"
                onClick={onAdminUnlock}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                {pendingUnlockRequest ? t('locked_lease.approve_and_unlock') : t('locked_lease.admin_unlock')}
              </Button>
            )}
            {leaseId && (
              <ArchiveButton
                leaseId={leaseId}
                isArchived={!!isArchived}
                onChange={onArchiveChange}
              />
            )}
          </div>
        </div>

        {isAdmin && pendingUnlockRequest && (
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
