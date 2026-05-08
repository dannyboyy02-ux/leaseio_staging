// LeaseInsightsCard — Tier 3 contextual intelligence (Phase 1 v1)
//
// Renders Sonnet-generated insights that compare this lease against the
// workspace's broader portfolio. Manual trigger for v1; auto-trigger on
// lifecycle events is v2. Business-tier only.

import { useEffect, useState, useCallback } from 'react';
import { Loader2, Sparkles, Info, AlertTriangle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

type InsightSeverity = 'info' | 'notice' | 'concern';
type InsightType =
  | 'portfolio_norm_deviation'
  | 'amendment_impact'
  | 'renewal_proximity'
  | 'risk_pattern_match'
  | 'general_observation';

interface LeaseInsight {
  id: string;
  insight_type: InsightType;
  severity: InsightSeverity;
  title: string;
  body: string;
  source_data: Record<string, unknown>;
  generated_at: string;
}

interface Props {
  leaseId: string;
  workspaceId: string | null;
  plan: 'starter' | 'business' | string | null | undefined;
}

const SEVERITY_STYLES: Record<InsightSeverity, { ring: string; bg: string; text: string; icon: typeof Info }> = {
  info: { ring: 'border-slate-300', bg: 'bg-slate-50', text: 'text-slate-700', icon: Info },
  notice: { ring: 'border-amber-300', bg: 'bg-amber-50', text: 'text-amber-800', icon: AlertTriangle },
  concern: { ring: 'border-red-300', bg: 'bg-red-50', text: 'text-red-800', icon: AlertCircle },
};

const TYPE_LABELS: Record<InsightType, string> = {
  portfolio_norm_deviation: 'Portfolio comparison',
  amendment_impact: 'Amendment impact',
  renewal_proximity: 'Renewal proximity',
  risk_pattern_match: 'Risk pattern',
  general_observation: 'Observation',
};

export function LeaseInsightsCard({ leaseId, workspaceId, plan }: Props) {
  const [insights, setInsights] = useState<LeaseInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const isBusiness = plan === 'business';

  const fetchInsights = useCallback(async () => {
    if (!leaseId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('lease_insights' as any)
        .select('id, insight_type, severity, title, body, source_data, generated_at')
        .eq('lease_id', leaseId)
        .order('generated_at', { ascending: false })
        .limit(20);
      if (error) {
        console.warn('[LeaseInsightsCard] fetch failed:', error.message);
        setInsights([]);
      } else {
        setInsights((data ?? []) as unknown as LeaseInsight[]);
      }
    } finally {
      setLoading(false);
    }
  }, [leaseId]);

  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  const handleGenerate = async () => {
    if (!leaseId) return;
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-lease-insights', {
        body: { leaseId, triggeredBy: 'manual' },
      });
      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? 'Generation failed');
      const generated = (data as any)?.insights ?? [];
      if (generated.length === 0) {
        toast.info('AI found nothing notable in this lease relative to your portfolio.');
      } else {
        toast.success(`${generated.length} insight${generated.length === 1 ? '' : 's'} generated.`);
      }
      await fetchInsights();
    } catch (err) {
      console.error('[LeaseInsightsCard] generate failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to generate insights');
    } finally {
      setGenerating(false);
    }
  };

  // Don't render the card at all for non-Business tiers AND no existing
  // insights. This keeps the surface invisible to users who can't act on
  // it without giving away the upsell context.
  if (!isBusiness && insights.length === 0) return null;

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-primary" />
          Portfolio insights
          <Badge variant="outline" className="text-xs">Business</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading insights…
          </div>
        ) : insights.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No insights yet for this lease.{isBusiness ? ' Generate to compare against your portfolio.' : ''}
          </p>
        ) : (
          <ul className="space-y-2">
            {insights.map((insight) => {
              const style = SEVERITY_STYLES[insight.severity] ?? SEVERITY_STYLES.info;
              const Icon = style.icon;
              return (
                <li key={insight.id} className={`rounded-lg border p-3 ${style.ring} ${style.bg}`}>
                  <div className="flex items-start gap-2">
                    <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${style.text}`} />
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h4 className={`text-sm font-semibold ${style.text}`}>{insight.title}</h4>
                        <Badge variant="outline" className="text-[10px]">
                          {TYPE_LABELS[insight.insight_type] ?? insight.insight_type}
                        </Badge>
                      </div>
                      <p className={`text-xs ${style.text} opacity-90`}>{insight.body}</p>
                      {insight.source_data && Object.keys(insight.source_data).length > 0 && (
                        <details className="mt-2 text-[11px] opacity-70">
                          <summary className="cursor-pointer hover:opacity-100">Data backing this insight</summary>
                          <pre className="mt-1 bg-white/50 rounded p-2 overflow-x-auto">
                            {JSON.stringify(insight.source_data, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {isBusiness && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerate}
            disabled={generating || !workspaceId}
            className="w-full"
          >
            {generating ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
            {insights.length === 0 ? 'Generate insights' : 'Re-run analysis'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
