// PendingCounterSignatureCard — Phase 5 Checkpoint 4.
//
// Dashboard card listing leases in pending_counter_signature for the
// current workspace. Sorts by urgency (worst first) then by due date.
// Auto-hides when nothing is pending so the dashboard stays clean.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import {
  counterSignatureUrgency,
  counterSignatureUrgencyLabel,
  type CounterSignatureUrgency,
} from '@/lib/lifecycleStates';

interface Row {
  id: string;
  filename: string | null;
  tenant_name: string | null;
  landlord_name: string | null;
  counter_signature_due_date: string | null;
  counter_signature_reminder_count: number | null;
  execution_owner_id: string | null;
}

const URGENCY_RANK: Record<CounterSignatureUrgency, number> = {
  critically_overdue: 0,
  overdue: 1,
  due_today: 2,
  approaching: 3,
  on_track: 4,
  no_due_date: 5,
};

const URGENCY_TEXT: Record<CounterSignatureUrgency, string> = {
  critically_overdue: 'text-destructive',
  overdue: 'text-destructive',
  due_today: 'text-warning',
  approaching: 'text-warning',
  on_track: 'text-success',
  no_due_date: 'text-muted-foreground',
};

export function PendingCounterSignatureCard() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspace?.id) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('leases')
        .select(
          'id, filename, tenant_name, landlord_name, counter_signature_due_date, counter_signature_reminder_count, execution_owner_id',
        )
        .eq('workspace_id', workspace.id)
        .eq('lifecycle_status', 'pending_counter_signature')
        .order('counter_signature_due_date', { ascending: true });
      if (!cancelled) {
        if (error) {
          console.error('[PendingCounterSignatureCard] load error:', error.message);
          setRows([]);
        } else {
          setRows((data ?? []) as Row[]);
        }
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.id]);

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const ua = counterSignatureUrgency(a.counter_signature_due_date ?? null);
      const ub = counterSignatureUrgency(b.counter_signature_due_date ?? null);
      if (URGENCY_RANK[ua] !== URGENCY_RANK[ub]) {
        return URGENCY_RANK[ua] - URGENCY_RANK[ub];
      }
      // Tie-break by due date ascending (older overdue first)
      const da = a.counter_signature_due_date
        ? new Date(a.counter_signature_due_date).getTime()
        : Number.MAX_SAFE_INTEGER;
      const db = b.counter_signature_due_date
        ? new Date(b.counter_signature_due_date).getTime()
        : Number.MAX_SAFE_INTEGER;
      return da - db;
    });
  }, [rows]);

  if (loading) return null;
  if (sorted.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4" />
          Awaiting Counter-Signature
          <Badge variant="secondary" className="ml-1">
            {sorted.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {sorted.map((r) => {
          const urgency = counterSignatureUrgency(r.counter_signature_due_date ?? null);
          const dueFmt = r.counter_signature_due_date
            ? format(new Date(r.counter_signature_due_date), 'MMM d')
            : '—';
          const title =
            r.filename ||
            [r.tenant_name, r.landlord_name].filter(Boolean).join(' ↔ ') ||
            'Untitled lease';
          return (
            <button
              key={r.id}
              onClick={() => navigate(`/app/leases/${r.id}`)}
              className="w-full text-left flex items-center justify-between gap-3 px-3 py-2 rounded-md border hover:bg-muted/50 transition-colors"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{title}</p>
                <p className="text-xs text-muted-foreground">
                  Due {dueFmt}
                  {r.counter_signature_reminder_count != null &&
                  r.counter_signature_reminder_count > 0
                    ? ` · ${r.counter_signature_reminder_count} reminder${
                        r.counter_signature_reminder_count === 1 ? '' : 's'
                      } sent`
                    : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge
                  variant="outline"
                  className={cn('text-[10px]', URGENCY_TEXT[urgency])}
                >
                  {counterSignatureUrgencyLabel(urgency)}
                </Badge>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
