import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCircle2, ChevronRight, ChevronDown, CheckSquare, RotateCcw, Unlock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { useLanguage } from '@/contexts/LanguageContext';
import { useNeedsAction } from '@/hooks/useNeedsAction';

export function NeedsAction() {
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleSection = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const { data, isPending: loading } = useNeedsAction();

  const pendingApprovals = data?.pendingApprovals ?? [];
  const unlockedLeases   = data?.unlockedLeases   ?? [];
  const returnedLeases   = data?.returnedLeases   ?? [];
  const otherFlags       = data?.otherFlags       ?? [];

  const totalCount = pendingApprovals.length + returnedLeases.length + otherFlags.filter((f) => f.count > 0).length + unlockedLeases.length;

  // "Nothing to do" is already said once by the Needs Action tile above —
  // a ~180px card repeating it was the same signal told twice. The card
  // exists only when it has items to list.
  if (!loading && totalCount === 0) {
    return null;
  }

  return (
    <Card className="border-l-4 border-l-orange-400 h-full">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            {t('dashboard.needs_your_action')}
          </div>
          {!loading && totalCount > 0 && (
            <Badge variant="destructive">{totalCount}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse bg-muted h-12 rounded-lg" />
            ))}
          </div>
        ) : totalCount === 0 ? (
          <div className="flex flex-col items-center py-4 text-center">
            <CheckCircle2 className="h-6 w-6 text-green-500 mb-1.5" />
            <p className="text-sm text-muted-foreground">{t('dashboard.no_actions_required')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pendingApprovals.length > 0 && (
              <div className="space-y-1">
                <button
                  className="flex items-center gap-1 w-full mb-2"
                  onClick={() => toggleSection('approvals')}
                >
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-1 text-left">
                    {t('dashboard.pending_approvals')}
                  </p>
                  <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', collapsed.approvals && 'rotate-180')} />
                </button>
                {!collapsed.approvals && pendingApprovals.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => navigate(`/app/leases/${item.id}`)}
                    className={`flex items-center gap-2 cursor-pointer rounded-md px-3 py-2 text-sm transition-colors ${
                      item.daysWaiting > 7
                        ? 'bg-orange-50 hover:bg-orange-100'
                        : 'bg-muted/40 hover:bg-muted/70'
                    }`}
                  >
                    <CheckSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">{item.department}</p>
                    </div>
                    <div className="ml-3 shrink-0 text-right flex items-center gap-2">
                      {item.daysWaiting > 7 ? (
                        <Badge variant="destructive" className="text-xs">{t('firm.inbox.urgency_overdue')}</Badge>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t('dashboard.days_waiting', { count: item.daysWaiting })}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {formatCurrency(item.annualValue)}/{t('dashboard.per_year_short')}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                  </div>
                ))}
              </div>
            )}

            {returnedLeases.length > 0 && (
              <div className="space-y-1">
                <button
                  className="flex items-center gap-1 w-full mb-2"
                  onClick={() => toggleSection('returned')}
                >
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-1 text-left">
                    {t('dashboard.returned_for_revision')}
                  </p>
                  <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', collapsed.returned && 'rotate-180')} />
                </button>
                {!collapsed.returned && returnedLeases.map((item) => (
                  <div
                    key={item.leaseId}
                    onClick={() => navigate(`/app/leases/${item.leaseId}`)}
                    className="flex items-center gap-2 cursor-pointer rounded-md px-3 py-2 text-sm bg-amber-50 hover:bg-amber-100 transition-colors"
                  >
                    <RotateCcw className="h-4 w-4 shrink-0 text-amber-600" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.leaseName}</p>
                      {item.rejectionReason ? (
                        <p className="text-xs text-muted-foreground truncate">"{item.rejectionReason}"</p>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t('dashboard.returned_for_revision_item')}</p>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                  </div>
                ))}
              </div>
            )}

            {unlockedLeases.length > 0 && (
              <div className="space-y-1">
                <button
                  className="flex items-center gap-1 w-full mb-2"
                  onClick={() => toggleSection('unlocked')}
                >
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-1 text-left">
                    {t('dashboard.unlocked_for_editing')}
                  </p>
                  <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', collapsed.unlocked && 'rotate-180')} />
                </button>
                {!collapsed.unlocked && unlockedLeases.map((item) => (
                  <div
                    key={item.leaseId}
                    onClick={() => navigate(`/app/leases/${item.leaseId}`)}
                    className="flex items-center gap-2 cursor-pointer rounded-md px-3 py-2 text-sm bg-blue-50 hover:bg-blue-100 transition-colors"
                  >
                    <Unlock className="h-4 w-4 shrink-0 text-blue-500" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{item.leaseName}</p>
                      <p className="text-xs text-muted-foreground">{t('dashboard.draft_changes_pending')}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                  </div>
                ))}
              </div>
            )}

            {otherFlags.length > 0 && (
              <div className="space-y-1">
                <button
                  className="flex items-center gap-1 w-full mb-2"
                  onClick={() => toggleSection('flags')}
                >
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-1 text-left">
                    {t('dashboard.other_flags')}
                  </p>
                  <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', collapsed.flags && 'rotate-180')} />
                </button>
                {!collapsed.flags && otherFlags.map((flag) => (
                  <div
                    key={flag.label}
                    onClick={() => navigate(flag.href)}
                    className="flex items-center justify-between rounded-md bg-muted/40 hover:bg-muted/70 px-3 py-2 text-sm cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <flag.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span>{flag.label}</span>
                    </div>
                    <Badge variant="secondary">{flag.count}</Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="pt-1">
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => navigate('/app/needs-action')}
              >
                {t('dashboard.view_all')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
