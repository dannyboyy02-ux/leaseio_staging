// OutOfOfficeSettings — Phase 7 Checkpoint 4.
//
// User account settings card. Lets the current user declare an OOO
// window with a designated delegate. Lists existing OOO records (active
// + upcoming) with revoke buttons.
//
// Spec: §"Frontend — out-of-office settings". Date range picker,
// delegate user picker, optional reason. Submit calls
// declare-out-of-office. Revoke calls revoke-out-of-office.

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { CalendarOff, Loader2, X } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { toast } from 'sonner';

interface OOORow {
  id: string;
  workspace_id: string;
  starts_at: string;
  ends_at: string;
  delegate_user_id: string;
  reason: string | null;
  is_active: boolean;
  delegate_name?: string | null;
}

interface MemberOption {
  id: string;
  display: string;
}

export function OutOfOfficeSettings() {
  const { user, workspace } = useApp();
  const { t } = useAppTranslation();
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [oooRecords, setOooRecords] = useState<OOORow[]>([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [delegateId, setDelegateId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const refresh = async () => {
    if (!user?.id || !workspace?.id) return;
    setLoading(true);
    const { data: rows } = await supabase
      .from('user_out_of_office')
      .select('id, workspace_id, starts_at, ends_at, delegate_user_id, reason, is_active')
      .eq('user_id', user.id)
      .eq('workspace_id', workspace.id)
      .order('starts_at', { ascending: false });
    const list = (rows ?? []) as OOORow[];
    if (list.length > 0) {
      const ids = Array.from(new Set(list.map((r) => r.delegate_user_id)));
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', ids);
      const byId = new Map<string, string>();
      for (const p of ((profiles ?? []) as any[])) {
        const fn = (p.first_name as string | null) ?? '';
        const ln = (p.last_name as string | null) ?? '';
        const display = (fn || ln) ? `${fn} ${ln}`.trim() : (p.email ?? t('workflow.common.unknown'));
        byId.set(p.id as string, display);
      }
      list.forEach((r) => { r.delegate_name = byId.get(r.delegate_user_id) ?? null; });
    }
    setOooRecords(list);
    setLoading(false);
  };

  useEffect(() => {
    if (!workspace?.id || !user?.id) return;
    let cancelled = false;
    (async () => {
      const { data: ws } = await supabase
        .from('workspaces')
        .select('owner_id')
        .eq('id', workspace.id)
        .maybeSingle();
      const ownerId = (ws as any)?.owner_id ?? null;
      const { data: memberRows } = await supabase
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspace.id);
      const memberIds = ((memberRows ?? []) as any[]).map((m) => m.user_id);
      const allIds = Array.from(
        new Set([...(ownerId ? [ownerId] : []), ...memberIds]),
      ).filter((id) => id !== user.id); // exclude self
      const { data: profiles } = allIds.length > 0
        ? await supabase.from('profiles').select('id, email, first_name, last_name').in('id', allIds)
        : { data: [] };
      const opts: MemberOption[] = ((profiles ?? []) as any[])
        .map((p) => {
          const fn = (p.first_name as string | null) ?? '';
          const ln = (p.last_name as string | null) ?? '';
          const display = (fn || ln) ? `${fn} ${ln}`.trim() : (p.email ?? t('workflow.common.unknown'));
          return { id: p.id, display };
        })
        .sort((a, b) => a.display.localeCompare(b.display));
      if (!cancelled) setMembers(opts);
    })();
    refresh();
    return () => { cancelled = true; };
  }, [workspace?.id, user?.id]);

  const submit = async () => {
    if (!startsAt || !endsAt || !delegateId) {
      toast.error(t('workflow.ooo.fields_required'));
      return;
    }
    if (new Date(startsAt) >= new Date(endsAt)) {
      toast.error(t('workflow.ooo.start_before_end'));
      return;
    }
    if (!workspace?.id) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('declare-out-of-office', {
        body: {
          workspaceId: workspace.id,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          delegateUserId: delegateId,
          reason: reason.trim() || undefined,
        },
      });
      if (error || !(data as any)?.ok) {
        const msg = (data as any)?.error || error?.message || t('workflow.ooo.record_failed');
        toast.error(msg);
        return;
      }
      const stepsRouted = (data as any).stepsRouted ?? 0;
      toast.success(
        stepsRouted > 0
          ? t('workflow.ooo.recorded_routed', { count: stepsRouted })
          : t('workflow.ooo.recorded_none'),
      );
      setStartsAt('');
      setEndsAt('');
      setDelegateId('');
      setReason('');
      refresh();
    } catch (err: any) {
      toast.error(err?.message || t('workflow.ooo.record_failed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (oooId: string) => {
    setRevokingId(oooId);
    try {
      const { data, error } = await supabase.functions.invoke('revoke-out-of-office', {
        body: { oooId },
      });
      if (error || !(data as any)?.ok) {
        const msg = (data as any)?.error || error?.message || t('workflow.ooo.revoke_failed');
        toast.error(msg);
        return;
      }
      const reverted = (data as any).stepsReverted ?? 0;
      toast.success(
        reverted > 0
          ? t('workflow.ooo.cancelled_reverted', { count: reverted })
          : t('workflow.ooo.cancelled'),
      );
      refresh();
    } catch (err: any) {
      toast.error(err?.message || t('workflow.ooo.revoke_failed'));
    } finally {
      setRevokingId(null);
    }
  };

  const now = useMemo(() => new Date(), [oooRecords]);
  const activeOOO = useMemo(
    () =>
      oooRecords.find(
        (r) =>
          r.is_active &&
          new Date(r.starts_at) <= now &&
          new Date(r.ends_at) >= now,
      ) ?? null,
    [oooRecords, now],
  );

  return (
    <div className="space-y-6">
      {activeOOO && (
        <Card className="border-l-4 border-l-warning bg-warning/5">
          <CardContent className="py-4 flex items-start gap-3">
            <CalendarOff className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <div className="space-y-1 flex-1">
              <p className="font-semibold text-sm">
                {t('workflow.ooo.active_until', {
                  date: format(new Date(activeOOO.ends_at), 'MMM d, yyyy h:mm a'),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('workflow.ooo.routed_to_prefix')}{' '}
                <strong>{activeOOO.delegate_name ?? t('workflow.ooo.your_delegate')}</strong>.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('workflow.ooo.title')}</CardTitle>
          <CardDescription>
            {t('workflow.ooo.desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ooo-start">{t('leases.start')}</Label>
              <Input
                id="ooo-start"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ooo-end">{t('leases.end')}</Label>
              <Input
                id="ooo-end"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ooo-delegate">{t('workflow.ooo.delegate')}</Label>
            <Select value={delegateId} onValueChange={setDelegateId} disabled={busy}>
              <SelectTrigger id="ooo-delegate">
                <SelectValue placeholder={t('workflow.delegation.select_member')} />
              </SelectTrigger>
              <SelectContent>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.display}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ooo-reason">{t('workflow.delegation.reason_optional')}</Label>
            <Textarea
              id="ooo-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder={t('workflow.ooo.reason_placeholder')}
              disabled={busy}
            />
          </div>
          <Button onClick={submit} disabled={busy || !startsAt || !endsAt || !delegateId}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('workflow.ooo.record')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('workflow.ooo.existing_title')}</CardTitle>
          <CardDescription>
            {t('workflow.ooo.existing_desc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : oooRecords.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t('workflow.ooo.none')}
            </p>
          ) : (
            <div className="space-y-2">
              {oooRecords.map((r) => {
                const isActive =
                  r.is_active &&
                  new Date(r.starts_at) <= new Date() &&
                  new Date(r.ends_at) >= new Date();
                const isUpcoming =
                  r.is_active && new Date(r.starts_at) > new Date();
                const isPast =
                  new Date(r.ends_at) < new Date() || !r.is_active;
                return (
                  <div
                    key={r.id}
                    className="flex items-start justify-between gap-3 rounded-md border p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <span>
                          {format(new Date(r.starts_at), 'MMM d, yyyy h:mm a')}{' '}
                          → {format(new Date(r.ends_at), 'MMM d, yyyy h:mm a')}
                        </span>
                        {isActive && (
                          <Badge variant="default" className="text-[10px]">
                            {t('lease.active')}
                          </Badge>
                        )}
                        {isUpcoming && (
                          <Badge variant="outline" className="text-[10px]">
                            {t('locked_lease.critical_dates.upcoming')}
                          </Badge>
                        )}
                        {isPast && !isActive && (
                          <Badge variant="secondary" className="text-[10px]">
                            {t('notifications.past')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('workflow.ooo.delegate_name', { name: r.delegate_name ?? t('workflow.common.unknown') })}
                      </p>
                      {r.reason && (
                        <p className="text-xs text-muted-foreground mt-0.5 italic">
                          {r.reason}
                        </p>
                      )}
                    </div>
                    {r.is_active && !isPast && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => revoke(r.id)}
                        disabled={revokingId === r.id}
                      >
                        {revokingId === r.id ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <X className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        {t('common.cancel')}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
