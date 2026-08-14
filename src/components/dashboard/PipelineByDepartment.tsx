import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/ui/section-card';
import { Building2, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatLocalizedCurrency } from '@/lib/dateFormatters';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { getMonthlyRent } from '@/lib/leaseCalculations';

interface LeaseRow {
  requesting_department: string | null;
  lifecycle_status: string | null;
  monthly_payment: number | null;
  executed_monthly_payment: number | null;
  current_monthly_rent: number | null;
  rent_schedules: { period_start: string; period_end: string | null; monthly_amount: number | null }[] | null;
  uploaded_at: string | null;
}

interface DeptSummary {
  name: string;
  activeCount: number;
  inProgressCount: number;
  annualValue: number;
}

// Phase 3 (KNOWN_ISSUES.md item #7): extended in place with chain
// vocabulary equivalents of awaiting_concept_approval, in_concept_review,
// post_concept_pre_signator, signator_review, awaiting_counter_signature,
// and executed_pre_active groups. Consolidation to a STATE_GROUPS-derived
// helper is filed for a future refactor.
const IN_PROGRESS_STATUSES = [
  // Legacy
  'submitted', 'under_review', 'approved', 'executed',
  // Chain
  'concept_submitted', 'concept_under_review', 'in_negotiation',
  'final_review', 'pending_counter_signature', 'fully_executed',
];

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
    map[dept].annualValue += getMonthlyRent(l as any) * 12;
  });

  return Object.values(map)
    .sort((a, b) => b.annualValue - a.annualValue)
    .slice(0, 8);
}

export function PipelineByDepartment() {
  const { t, language } = useLanguage();
  const { workspace } = useApp();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
  const [rawData, setRawData] = useState<LeaseRow[]>([]);
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const { data } = await supabase
        .from('leases')
        .select('requesting_department, lifecycle_status, monthly_payment, executed_monthly_payment, current_monthly_rent, uploaded_at, rent_schedules(period_start, period_end, monthly_amount)')
        .eq('workspace_id', workspace.id)
        // Exclude archived leases — consistent with the rest of the dashboard.
        .eq('archived', false)
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
          {t('dashboard.days_abbrev', { count: d })}
        </button>
      ))}
    </div>
  );

  return (
    <SectionCard icon={Building2} title={t('dashboard.pipeline_by_department')} action={toggleUI}>
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : depts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">{t('dashboard.no_department_data')}</p>
        ) : (
          <div className="space-y-3">
            {depts.map((dept) => (
              <div key={dept.name}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium truncate max-w-[40%]">{dept.name}</span>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{t('dashboard.count_active', { count: dept.activeCount })}</span>
                    <span>{t('dashboard.count_in_progress', { count: dept.inProgressCount })}</span>
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
    </SectionCard>
  );
}
