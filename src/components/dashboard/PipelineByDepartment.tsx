import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useNavigate } from 'react-router-dom';

interface LeaseRow {
  requesting_department: string | null;
  lifecycle_status: string | null;
  monthly_payment: number | null;
  uploaded_at: string | null;
}

interface DeptSummary {
  name: string;
  activeCount: number;
  inProgressCount: number;
  annualValue: number;
}

const IN_PROGRESS_STATUSES = ['submitted', 'under_review', 'approved', 'executed'];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function buildDeptSummaries(leases: LeaseRow[], days: number): DeptSummary[] {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const filtered = leases.filter((l) => {
    if (!l.uploaded_at) return false;
    return new Date(l.uploaded_at) >= cutoff;
  });

  const map: Record<string, DeptSummary> = {};

  filtered.forEach((l) => {
    const dept = l.requesting_department!;
    if (!map[dept]) {
      map[dept] = { name: dept, activeCount: 0, inProgressCount: 0, annualValue: 0 };
    }
    if (l.lifecycle_status === 'active') {
      map[dept].activeCount += 1;
    }
    if (l.lifecycle_status && IN_PROGRESS_STATUSES.includes(l.lifecycle_status)) {
      map[dept].inProgressCount += 1;
    }
    map[dept].annualValue += (l.monthly_payment ?? 0) * 12;
  });

  return Object.values(map)
    .sort((a, b) => b.annualValue - a.annualValue)
    .slice(0, 8);
}

export function PipelineByDepartment() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [rawData, setRawData] = useState<LeaseRow[]>([]);
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const [loading, setLoading] = useState(true);

  // navigate is used for potential future drill-down; suppress lint warning
  void navigate;

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const { data } = await supabase
        .from('leases')
        .select('requesting_department, lifecycle_status, monthly_payment, uploaded_at')
        .eq('workspace_id', workspace.id)
        .not('requesting_department', 'is', null);

      setRawData((data as LeaseRow[]) ?? []);
      setLoading(false);
    }
    fetchData();
  }, [workspace?.id]);

  const depts = buildDeptSummaries(rawData, days);
  const maxValue = Math.max(...depts.map((d) => d.annualValue), 1);

  const toggleUI = (
    <div className="flex gap-1">
      {([30, 60, 90] as const).map((d) => (
        <button
          key={d}
          onClick={() => setDays(d)}
          className={`px-2 py-0.5 text-xs rounded ${
            days === d
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-muted'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Pipeline by Department
          </div>
          {toggleUI}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : depts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No department data yet.</p>
        ) : (
          <div className="space-y-3">
            {depts.map((dept) => (
              <div key={dept.name}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium truncate max-w-[40%]">{dept.name}</span>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{dept.activeCount} active</span>
                    <span>{dept.inProgressCount} in progress</span>
                    <span className="font-medium text-foreground">{formatCurrency(dept.annualValue)}</span>
                  </div>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(dept.annualValue / maxValue) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
