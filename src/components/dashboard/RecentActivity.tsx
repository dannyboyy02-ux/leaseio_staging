import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Inbox, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate, type SupportedLocale } from '@/lib/dateFormatters';
import { useNavigate } from 'react-router-dom';

interface ActivityRow {
  id: string;
  activity_type: string;
  created_at: string;
  lease_id: string;
  leases: {
    request_title: string | null;
    filename: string | null;
    lifecycle_status: string | null;
    workspace_id: string;
  };
}

interface ExtractionRow {
  id: string;
  request_title: string | null;
  filename: string | null;
  avg_confidence_score: number | null;
  model_locked: boolean | null;
  status: string | null;
  processed_at: string | null;
}

// Phase 3 (KNOWN_ISSUES.md item #7): this local label table duplicates
// the canonical displayLabel() in src/lib/lifecycleStates.ts. Extended
// in place here per the Phase 3 plan; consolidation to a single helper
// is tracked as a dedicated future refactor.
// Values are i18n keys, translated at render via the component's `t`.
const LIFECYCLE_LABEL_KEYS: Record<string, string> = {
  // Legacy
  submitted: 'dashboard.lifecycle.submitted',
  under_review: 'dashboard.lifecycle.under_review',
  approved: 'dashboard.lifecycle.approved',
  executed: 'dashboard.lifecycle.executed',
  active: 'dashboard.lifecycle.active',
  expired: 'dashboard.lifecycle.expired',
  rejected: 'dashboard.lifecycle.rejected',
  // Chain — labels intentionally identical to legacy where the user-facing
  // meaning matches; chain-only states get their canonical labels.
  concept_submitted: 'dashboard.lifecycle.submitted',
  concept_under_review: 'dashboard.lifecycle.under_review',
  in_negotiation: 'dashboard.lifecycle.in_negotiation',
  final_review: 'dashboard.lifecycle.final_review',
  pending_counter_signature: 'dashboard.lifecycle.pending_counter_signature',
  fully_executed: 'dashboard.lifecycle.fully_executed',
  chain_violation: 'dashboard.lifecycle.chain_violation',
};

// Translator signature shared by the module-level helpers below — the
// component passes its react-i18next `t` down so labels re-render on
// language change.
type Translate = (key: string, opts?: Record<string, unknown>) => string;

function getActivityLabel(t: Translate, activityType: string, lifecycleStatus?: string | null): string {
  switch (activityType) {
    case 'created': return t('dashboard.activity_created');
    case 'status_change':
      return lifecycleStatus && LIFECYCLE_LABEL_KEYS[lifecycleStatus]
        ? t('dashboard.activity_status_to', { status: t(LIFECYCLE_LABEL_KEYS[lifecycleStatus]) })
        : t('dashboard.activity_status_updated');
    case 'document_upload': return t('dashboard.activity_document_upload');
    case 'executed_uploaded': return t('dashboard.activity_executed_uploaded');
    default: return activityType;
  }
}

function getDotColor(lifecycleStatus: string | null): string {
  switch (lifecycleStatus) {
    // Legacy
    case 'submitted': return 'bg-blue-400';
    case 'under_review': return 'bg-amber-400';
    case 'approved': return 'bg-purple-400';
    case 'executed': return 'bg-indigo-400';
    case 'active': return 'bg-green-500';
    // Chain — colors mirror equivalent legacy states so the dot looks
    // identical regardless of vocabulary; chain-only states get their
    // own colors in the same family.
    case 'concept_submitted': return 'bg-blue-400';
    case 'concept_under_review': return 'bg-amber-400';
    case 'in_negotiation': return 'bg-purple-400';
    case 'final_review': return 'bg-amber-500';
    case 'pending_counter_signature': return 'bg-amber-500';
    case 'fully_executed': return 'bg-indigo-400';
    case 'chain_violation': return 'bg-red-500';
    default: return 'bg-gray-400';
  }
}

function getRelativeDate(t: Translate, dateStr: string, language: SupportedLocale): string {
  const date = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((todayStart.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return t('dashboard.today');
  if (diffDays === 1) return t('dashboard.yesterday');
  if (diffDays < 30) return t('dashboard.days_ago', { count: diffDays });
  return formatLocalizedDate(date, language, { month: 'short', day: 'numeric' });
}

export function RecentActivity() {
  const { workspace } = useApp();
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const [activityData, setActivityData] = useState<ActivityRow[]>([]);
  const [extractionData, setExtractionData] = useState<ExtractionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!workspace?.id) { setLoading(false); return; }

      const [activityResult, extractionResult] = await Promise.all([
        supabase
          .from('lease_activity_log')
          .select('id, activity_type, created_at, lease_id, leases!inner(request_title, filename, lifecycle_status, workspace_id)')
          .eq('leases.workspace_id', workspace.id)
          .in('activity_type', ['created', 'status_change', 'document_upload', 'executed_uploaded'])
          .order('created_at', { ascending: false })
          .limit(3),
        (() => {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          return supabase
            .from('leases')
            .select('id, request_title, filename, avg_confidence_score, model_locked, status, processed_at')
            .eq('workspace_id', workspace.id)
            .or(`status.eq.Ready,and(status.eq.Processing,uploaded_at.gte.${cutoff})`)
            .order('processed_at', { ascending: false, nullsFirst: false })
            .limit(4);
        })(),
      ]);

      setActivityData((activityResult.data as unknown as ActivityRow[]) ?? []);
      setExtractionData((extractionResult.data as ExtractionRow[]) ?? []);
      setLoading(false);
    }
    fetchData();
  }, [workspace?.id]);

  return (
    <SectionCard
      icon={Inbox}
      title={t('dashboard.recent_activity')}
      action={
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => navigate('/app/leases')}
        >
          {t('dashboard.all_activity')}
        </Button>
      }
    >
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {activityData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">{t('dashboard.no_recent_activity')}</p>
            ) : (
              <div>
                {/* Collapse consecutive runs from the same lease — one lease
                    marching through its lifecycle was eating the whole feed
                    with near-identical rows. The newest event's label leads;
                    the run size shows as "· N updates". */}
                {activityData
                  .reduce<Array<{ item: ActivityRow; runSize: number }>>((acc, item) => {
                    const prev = acc[acc.length - 1];
                    if (prev && prev.item.lease_id === item.lease_id) {
                      prev.runSize += 1;
                    } else {
                      acc.push({ item, runSize: 1 });
                    }
                    return acc;
                  }, [])
                  .map(({ item, runSize }) => {
                  const lease = item.leases;
                  const title = lease.request_title ?? lease.filename ?? t('dashboard.untitled');
                  const label = getActivityLabel(t, item.activity_type, lease.lifecycle_status);
                  const dotColor = getDotColor(lease.lifecycle_status);
                  const relDate = getRelativeDate(t, item.created_at, language);

                  return (
                    <div key={item.id} className="flex items-center gap-3 py-2 border-b last:border-0">
                      <div className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{title}</p>
                        <p className="text-xs text-muted-foreground">
                          {label}
                          {runSize > 1 ? ` · ${t('dashboard.n_more_updates', { count: runSize - 1 })}` : ''}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{relDate}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-4 mb-2">
              {t('dashboard.ai_extractions')}
            </p>

            {extractionData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-2">{t('dashboard.no_extractions')}</p>
            ) : (
              <div>
                {extractionData.map((item) => {
                  const title = item.request_title ?? item.filename ?? t('dashboard.untitled');
                  const score =
                    item.avg_confidence_score !== null
                      ? Math.round(item.avg_confidence_score * 100)
                      : null;
                  const isProcessing = item.status === 'Processing';

                  let badge: React.ReactNode;
                  if (isProcessing) {
                    badge = (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-secondary text-secondary-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {t('common.processing')}
                      </span>
                    );
                  } else if (item.model_locked) {
                    badge = (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">
                        {t('locked_lease.locked_badge')}
                      </span>
                    );
                  } else if (item.avg_confidence_score !== null && item.avg_confidence_score < 0.8) {
                    badge = (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-amber-100 text-amber-700">
                        {t('lease.needs_review')}
                      </span>
                    );
                  } else {
                    badge = (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700">
                        {t('dashboard.reviewed_badge')}
                      </span>
                    );
                  }

                  return (
                    <div key={item.id} className="flex items-center gap-3 py-1.5 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{title}</p>
                        {score !== null && !isProcessing && (
                          <p className="text-xs text-muted-foreground">{t('dashboard.confidence_pct', { score })}</p>
                        )}
                      </div>
                      {badge}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
    </SectionCard>
  );
}
