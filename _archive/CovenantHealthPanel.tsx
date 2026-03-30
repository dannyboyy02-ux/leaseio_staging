import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle, ExternalLink, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { Link } from 'react-router-dom';

interface CovenantLease {
  id: string;
  filename: string | null;
  tenant_name: string | null;
  lifecycle_status: string | null;
  lease_classification: string | null;
}

export function CovenantHealthPanel() {
  const { workspace } = useApp();
  const [flagged, setFlagged] = useState<CovenantLease[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const [{ count }, { data: flaggedData }] = await Promise.all([
        supabase
          .from('leases')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id)
          .in('lifecycle_status', ['active', 'executed']),
        supabase
          .from('leases')
          .select('id, filename, tenant_name, lifecycle_status, lease_classification')
          .eq('workspace_id', workspace.id)
          .eq('covenant_flagged', true)
          .in('lifecycle_status', ['active', 'executed'])
          .order('uploaded_at', { ascending: false })
          .limit(5),
      ]);

      setTotal(count ?? 0);
      setFlagged((flaggedData ?? []) as CovenantLease[]);
      setLoading(false);
    }
    fetchData();
  }, [workspace?.id]);

  const healthPct = total > 0 ? Math.round(((total - flagged.length) / total) * 100) : 100;
  const healthColor =
    healthPct >= 90 ? 'text-success' : healthPct >= 70 ? 'text-warning' : 'text-destructive';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-warning/10 text-warning">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Covenant Health</CardTitle>
              <CardDescription>Leases flagged for potential covenant breach</CardDescription>
            </div>
          </div>
          <span className={`text-2xl font-bold ${healthColor}`}>{healthPct}%</span>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center h-24">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : flagged.length === 0 ? (
          <div className="flex items-center gap-3 py-4 text-sm text-success">
            <CheckCircle className="h-5 w-5 shrink-0" />
            All active leases are covenant-compliant.
          </div>
        ) : (
          <div className="space-y-0">
            {flagged.map((lease) => (
              <div
                key={lease.id}
                className="flex items-center justify-between gap-2 py-2.5 border-b border-border last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {lease.filename || lease.tenant_name || 'Unnamed lease'}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {lease.lifecycle_status} · {lease.lease_classification || '—'}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="destructive" className="text-[10px]">Flagged</Badge>
                  <Button variant="ghost" size="icon-sm" asChild>
                    <Link to={`/app/leases/${lease.id}`}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
            {flagged.length === 5 && (
              <Button variant="ghost" size="sm" className="w-full mt-2" asChild>
                <Link to="/app/leases">View all flagged leases</Link>
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
