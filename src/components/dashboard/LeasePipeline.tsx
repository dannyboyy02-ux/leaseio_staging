import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);

const STAGES = [
  { key: 'submitted',    label: 'Submitted',    color: 'bg-blue-400' },
  { key: 'under_review', label: 'Under Review',  color: 'bg-amber-400' },
  { key: 'approved',     label: 'Approved',      color: 'bg-purple-400' },
  { key: 'executed',     label: 'Executed',      color: 'bg-indigo-400' },
  { key: 'active',       label: 'Active',        color: 'bg-green-500' },
] as const;

interface StageData {
  key: string;
  label: string;
  color: string;
  count: number;
  annualValue: number;
}

export function LeasePipeline() {
  const { workspace } = useApp();
  const navigate = useNavigate();
  const [stageData, setStageData] = useState<StageData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) {
        setLoading(false);
        return;
      }

      const { data: leases } = await supabase
        .from('leases')
        .select('lifecycle_status, monthly_payment')
        .eq('workspace_id', workspace.id);

      if (!leases) {
        setLoading(false);
        return;
      }

      const derived: StageData[] = STAGES.map((stage) => {
        const matching = leases.filter((l) => l.lifecycle_status === stage.key);
        const annualValue = matching.reduce(
          (sum, l) => sum + (l.monthly_payment ?? 0) * 12,
          0
        );
        return {
          key: stage.key,
          label: stage.label,
          color: stage.color,
          count: matching.length,
          annualValue,
        };
      });

      setStageData(derived);
      setLoading(false);
    }

    fetchData();
  }, [workspace?.id]);

  const maxCount = Math.max(...stageData.map((s) => s.count), 1);

  const inProgressCount = stageData
    .filter((s) => ['submitted', 'under_review', 'approved', 'executed'].includes(s.key))
    .reduce((sum, s) => sum + s.count, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4" />
            Lease Pipeline
          </div>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => navigate('/app/leases')}
          >
            Full pipeline
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="animate-pulse bg-muted h-7 rounded" />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {stageData.map((stage) => (
              <div
                key={stage.key}
                className="flex items-center gap-3 cursor-pointer hover:bg-muted/50 rounded px-2 py-1.5"
                onClick={() => navigate('/app/leases')}
              >
                <span className="w-24 text-xs text-muted-foreground shrink-0">
                  {stage.label}
                </span>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${stage.color}`}
                    style={{ width: `${(stage.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-6 text-xs font-medium text-right shrink-0">
                  {stage.count}
                </span>
                <span className="w-20 text-xs text-muted-foreground text-right shrink-0">
                  {formatCurrency(stage.annualValue)}
                </span>
              </div>
            ))}
            <div className="pt-3 border-t mt-2">
              <p className="text-xs text-muted-foreground">
                Total in progress: {inProgressCount} lease{inProgressCount !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
