import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCircle2, ChevronDown, CheckSquare, RotateCcw, Unlock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { cn } from '@/lib/utils';
import { useNeedsAction } from '@/hooks/useNeedsAction';

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

export default function NeedsActionPage() {
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleSection = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const { data, isPending: loading } = useNeedsAction();

  const pendingApprovals = data?.pendingApprovals ?? [];
  const unlockedLeases   = data?.unlockedLeases   ?? [];
  const returnedLeases   = data?.returnedLeases   ?? [];
  const otherFlags       = data?.otherFlags       ?? [];

  const totalCount = pendingApprovals.length + returnedLeases.length + otherFlags.filter((f) => f.count > 0).length + unlockedLeases.length;

  return (
    <AppLayout>
      <AppHeader
        title="Needs Your Action"
        subtitle={!loading && totalCount > 0 ? `${totalCount} item${totalCount !== 1 ? 's' : ''} require attention` : undefined}
      />
      <div className="p-6">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse bg-muted h-14 rounded-lg" />
            ))}
          </div>
        ) : totalCount === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mb-3" />
            <p className="text-base font-medium">All caught up</p>
            <p className="text-sm text-muted-foreground mt-1">No actions required right now</p>
          </div>
        ) : (
          <div className="space-y-6 max-w-3xl">
            {pendingApprovals.length > 0 && (
              <div>
                <button
                  className="flex items-center gap-1 w-full mb-3"
                  onClick={() => toggleSection('approvals')}
                >
                  <div className="flex items-center gap-2 flex-1">
                    <Bell className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">Pending Approvals</span>
                    <Badge variant="secondary">{pendingApprovals.length}</Badge>
                  </div>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', collapsed.approvals && 'rotate-180')} />
                </button>
                {!collapsed.approvals && (
                  <div className="space-y-1">
                    {pendingApprovals.map((item) => (
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
                            <Badge variant="destructive" className="text-xs">Overdue</Badge>
                          ) : (
                            <p className="text-xs text-muted-foreground">{item.daysWaiting}d waiting</p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {formatCurrency(item.annualValue)}/yr
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {returnedLeases.length > 0 && (
              <div>
                <button
                  className="flex items-center gap-1 w-full mb-3"
                  onClick={() => toggleSection('returned')}
                >
                  <div className="flex items-center gap-2 flex-1">
                    <RotateCcw className="h-4 w-4 text-amber-600" />
                    <span className="text-sm font-semibold">Returned for Revision</span>
                    <Badge variant="secondary">{returnedLeases.length}</Badge>
                  </div>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', collapsed.returned && 'rotate-180')} />
                </button>
                {!collapsed.returned && (
                  <div className="space-y-1">
                    {returnedLeases.map((item) => (
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
                            <p className="text-xs text-muted-foreground">Returned for revision</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {unlockedLeases.length > 0 && (
              <div>
                <button
                  className="flex items-center gap-1 w-full mb-3"
                  onClick={() => toggleSection('unlocked')}
                >
                  <div className="flex items-center gap-2 flex-1">
                    <Unlock className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-semibold">Unlocked for Editing</span>
                    <Badge variant="secondary">{unlockedLeases.length}</Badge>
                  </div>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', collapsed.unlocked && 'rotate-180')} />
                </button>
                {!collapsed.unlocked && (
                  <div className="space-y-1">
                    {unlockedLeases.map((item) => (
                      <div
                        key={item.leaseId}
                        onClick={() => navigate(`/app/leases/${item.leaseId}`)}
                        className="flex items-center gap-2 cursor-pointer rounded-md px-3 py-2 text-sm bg-blue-50 hover:bg-blue-100 transition-colors"
                      >
                        <Unlock className="h-4 w-4 shrink-0 text-blue-500" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{item.leaseName}</p>
                          <p className="text-xs text-muted-foreground">Draft changes pending submission</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {otherFlags.length > 0 && (
              <div>
                <button
                  className="flex items-center gap-1 w-full mb-3"
                  onClick={() => toggleSection('flags')}
                >
                  <div className="flex items-center gap-2 flex-1">
                    <span className="text-sm font-semibold">Other Flags</span>
                    <Badge variant="secondary">{otherFlags.reduce((s, f) => s + f.count, 0)}</Badge>
                  </div>
                  <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', collapsed.flags && 'rotate-180')} />
                </button>
                {!collapsed.flags && (
                  <div className="space-y-1">
                    {otherFlags.map((flag) => (
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
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
