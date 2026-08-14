import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';
import { localizedStatusLabel } from '@/lib/lifecycleLabels';
import { formatLocalizedCurrency, formatLocalizedDate, formatLocalizedDateTime, type SupportedLocale } from '@/lib/dateFormatters';
import { useLanguage } from '@/contexts/LanguageContext';

export interface SummaryData {
  requestTitle: string;
  assetType: string;
  description: string;
  vendor: string | null;
  requestingDepartment: string;
  submittedAt: string;

  monthlyPayment: number;
  termMonths: number;
  startDate: string;
  endDate: string;
  escalationRate: number;

  calcTotalCommitment: number;
  calcPvLiability: number;
  calcStraightLineExp: number;
  calcCashPlDelta: number;
  discountRateUsed: number;

  leaseClassification: string;
  covenantFlagged: boolean;

  lifecycleStatus: string;
  financialApprovedAt: string | null;
  financialApproverName: string | null;

  workspaceName: string;
}

interface Props {
  data: SummaryData;
  shareUrl?: string;
  generatedAt?: string;
}

// Phase 3 (KNOWN_ISSUES.md item #7): extended in place with chain
// vocabulary equivalents of the post-concept / executed / active groups.
// Consolidation to a STATE_GROUPS-derived helper is filed for a future
// refactor.
const APPROVED_STATUSES = [
  // Legacy
  'approved', 'executed', 'active',
  // Chain
  'in_negotiation', 'final_review', 'pending_counter_signature', 'fully_executed',
];

function fmt(n: number, language: SupportedLocale) {
  return formatLocalizedCurrency(n, language);
}

// Wave 5: localized \u2014 this summary renders on the PUBLIC no-login share link,
// where an es reader previously got English month names mid-Spanish-sentence.
function fmtDate(d: string, language: SupportedLocale) {
  if (!d) return '\u2014';
  try {
    return formatLocalizedDate(new Date(d + (d.length === 10 ? 'T12:00:00' : '')), language);
  } catch {
    return d;
  }
}

function fmtDateTime(d: string, language: SupportedLocale) {
  if (!d) return '\u2014';
  try {
    return formatLocalizedDateTime(d, language);
  } catch {
    return d;
  }
}

function titleCase(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function FinancialImpactSummary({ data, shareUrl, generatedAt }: Props) {
  const { language, t } = useLanguage();
  const isApproved = APPROVED_STATUSES.includes(data.lifecycleStatus);
  const isDraft = !isApproved;

  const classificationLabel =
    data.leaseClassification === 'operating'
      ? t('workflow.classification.operating')
      : data.leaseClassification === 'finance'
      ? t('workflow.classification.finance')
      : t('workflow.summary.pending_review');

  const assetLabel = data.assetType
    ? data.assetType.charAt(0).toUpperCase() + data.assetType.slice(1)
    : '\u2014';

  const today = generatedAt || new Date().toISOString();

  const metrics = [
    {
      label: t('workflow.impact.total_cash_commitment'),
      value: fmt(data.calcTotalCommitment, language),
      sublabel: t('workflow.impact.over_months', { count: data.termMonths }),
      color: '#1d4ed8',
      bg: '#eff6ff',
      border: '#bfdbfe',
    },
    {
      label: t('workflow.impact.estimated_liability'),
      value: fmt(data.calcPvLiability, language),
      sublabel: t('workflow.impact.pv_at_rate', { rate: data.discountRateUsed }),
      color: '#7c3aed',
      bg: '#f5f3ff',
      border: '#ddd6fe',
    },
    {
      label: t('workflow.impact.monthly_pl_charge'),
      value: fmt(data.calcStraightLineExp, language),
      sublabel: t('workflow.impact.straight_line'),
      color: '#059669',
      bg: '#f0fdf4',
      border: '#bbf7d0',
    },
    {
      label: t('workflow.impact.cash_pl_delta'),
      value: (data.calcCashPlDelta >= 0 ? '+' : '') + fmt(data.calcCashPlDelta, language),
      sublabel: t('workflow.impact.at_midpoint'),
      color: '#d97706',
      bg: '#fffbeb',
      border: '#fde68a',
    },
  ];

  return (
    <div
      className="summary-container"
      id="financial-impact-summary"
      style={{
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        backgroundColor: '#ffffff',
        color: '#111827',
        position: 'relative',
      }}
    >
      {/* DRAFT watermark */}
      {isDraft && (
        <div
          className="draft-watermark"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 0,
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              fontSize: '80px',
              fontWeight: 900,
              color: 'rgba(239,68,68,0.07)',
              transform: 'rotate(-35deg)',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              letterSpacing: '0.05em',
            }}
          >
            {t('workflow.summary.draft_watermark')}
          </span>
        </div>
      )}

      <div
        style={{
          maxWidth: '760px',
          margin: '0 auto',
          padding: '48px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: '36px',
            paddingBottom: '24px',
            borderBottom: '2px solid #e5e7eb',
          }}
        >
          <div>
            <div
              style={{
                fontSize: '22px',
                fontWeight: 800,
                color: '#1d4ed8',
                letterSpacing: '-0.02em',
                marginBottom: '2px',
              }}
            >
              LeaseIO
            </div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '14px' }}>
              {data.workspaceName}
            </div>
            <h1
              style={{
                fontSize: '19px',
                fontWeight: 700,
                color: '#111827',
                margin: 0,
                lineHeight: 1.3,
              }}
            >
              {t('workflow.summary.title')}
            </h1>
          </div>
          <div style={{ textAlign: 'right', fontSize: '13px', color: '#6b7280', flexShrink: 0 }}>
            <div>{t('workflow.summary.generated')}</div>
            <div style={{ fontWeight: 600, color: '#374151' }}>{fmtDate(today, language)}</div>
            {isDraft && (
              <div
                style={{
                  display: 'inline-block',
                  marginTop: '8px',
                  backgroundColor: '#fef3c7',
                  color: '#92400e',
                  border: '1px solid #fcd34d',
                  borderRadius: '4px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                }}
              >
                {t('workflow.summary.draft')}
              </div>
            )}
          </div>
        </div>

        {/* ── Commitment Details ── */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>{t('workflow.request.commitment_details')}</SectionHeading>
          <FieldTable
            rows={[
              [t('workflow.request.description'), data.requestTitle || '\u2014'],
              [t('workflow.request.asset_type'), assetLabel],
              [t('workflow.request.vendor'), data.vendor || '\u2014'],
              [t('workflow.request.requesting_department'), data.requestingDepartment || '\u2014'],
              [t('approval.submitted'), fmtDate(data.submittedAt, language)],
              [t('lease.status'), data.lifecycleStatus ? localizedStatusLabel(data.lifecycleStatus as LifecycleStatus) : '\u2014'],
            ]}
          />
        </section>

        {/* ── Lease Terms ── */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>{t('workflow.request.lease_terms')}</SectionHeading>
          <FieldTable
            rows={[
              [t('workflow.request.monthly_payment'), data.monthlyPayment ? fmt(data.monthlyPayment, language) : '\u2014'],
              [t('workflow.summary.term'), data.termMonths ? t('workflow.impact.n_months', { count: data.termMonths }) : '\u2014'],
              [t('workflow.summary.start_date'), fmtDate(data.startDate, language)],
              [t('workflow.summary.end_date'), fmtDate(data.endDate, language)],
              [t('workflow.summary.annual_escalation'), data.escalationRate > 0 ? `${data.escalationRate}%` : t('workflow.summary.none')],
            ]}
          />
        </section>

        {/* ── Financial Impact (hero) ── */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>{t('workflow.impact.title')}</SectionHeading>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '14px',
            }}
          >
            {metrics.map(({ label, value, sublabel, color, bg, border }) => (
              <div
                key={label}
                style={{
                  backgroundColor: bg,
                  border: `1px solid ${border}`,
                  borderRadius: '10px',
                  padding: '20px 22px',
                }}
              >
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#6b7280',
                    marginBottom: '8px',
                    letterSpacing: '0.02em',
                  }}
                >
                  {label}
                </div>
                <div
                  style={{
                    fontSize: '30px',
                    fontWeight: 800,
                    color,
                    letterSpacing: '-0.03em',
                    lineHeight: 1.1,
                    marginBottom: '6px',
                  }}
                >
                  {value}
                </div>
                <div style={{ fontSize: '12px', color: '#9ca3af' }}>{sublabel}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Classification & Governance ── */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>{t('workflow.summary.classification_governance')}</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ color: '#6b7280', fontWeight: 500, minWidth: '170px' }}>
                {t('workflow.summary.lease_classification')}
              </span>
              <StatusPill
                label={classificationLabel}
                variant={
                  data.leaseClassification === 'operating'
                    ? 'green'
                    : data.leaseClassification === 'finance'
                    ? 'blue'
                    : 'amber'
                }
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ color: '#6b7280', fontWeight: 500, minWidth: '170px' }}>
                {t('workflow.summary.covenant_impact')}
              </span>
              <StatusPill
                label={data.covenantFlagged ? t('workflow.summary.flagged_for_review') : t('workflow.summary.no_covenant_impact')}
                variant={data.covenantFlagged ? 'amber' : 'green'}
              />
            </div>
            {data.leaseClassification === 'finance' && (
              <div
                style={{
                  marginTop: '6px',
                  padding: '10px 14px',
                  backgroundColor: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: '8px',
                  fontSize: '13px',
                  color: '#1e40af',
                }}
              >
                {t('workflow.summary.rou_note')}
              </div>
            )}
          </div>
        </section>

        {/* ── Approval Record (only if approved) ── */}
        {isApproved && (data.financialApprovedAt || data.financialApproverName) && (
          <section style={{ marginBottom: '28px' }}>
            <SectionHeading>{t('workflow.summary.approval_record')}</SectionHeading>
            <FieldTable
              rows={[
                ...(data.financialApproverName
                  ? [[t('workflow.summary.approved_by'), data.financialApproverName] as [string, string]]
                  : []),
                ...(data.financialApprovedAt
                  ? [[t('workflow.summary.approval_date'), fmtDateTime(data.financialApprovedAt, language)] as [string, string]]
                  : []),
                [t('workflow.summary.classification_confirmed'), classificationLabel],
              ]}
            />
          </section>
        )}

        {/* ── Footer ── */}
        <footer
          style={{
            borderTop: '1px solid #e5e7eb',
            paddingTop: '18px',
            marginTop: '8px',
          }}
        >
          <p
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: '#6b7280',
              margin: '0 0 4px',
            }}
          >
            {t('workflow.summary.footer_tagline')}
          </p>
          {shareUrl && (
            <p
              style={{
                fontSize: '11px',
                color: '#9ca3af',
                margin: '0 0 4px',
                wordBreak: 'break-all',
              }}
            >
              {shareUrl}
            </p>
          )}
          <p
            style={{
              fontSize: '11px',
              color: '#9ca3af',
              margin: 0,
              fontStyle: 'italic',
            }}
          >
            {t('workflow.summary.footer_disclaimer')}
          </p>
        </footer>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: '#6b7280',
        margin: '0 0 10px',
        paddingBottom: '8px',
        borderBottom: '1px solid #f3f4f6',
      }}
    >
      {children}
    </h2>
  );
}

function FieldTable({ rows }: { rows: [string, string][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} style={{ borderBottom: '1px solid #f9fafb' }}>
            <td
              style={{
                padding: '7px 0',
                color: '#6b7280',
                width: '42%',
                fontWeight: 500,
                verticalAlign: 'top',
              }}
            >
              {label}
            </td>
            <td
              style={{
                padding: '7px 0',
                color: '#111827',
                fontWeight: 500,
                verticalAlign: 'top',
              }}
            >
              {value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusPill({
  label,
  variant,
}: {
  label: string;
  variant: 'green' | 'blue' | 'amber';
}) {
  const styles = {
    green: { bg: '#dcfce7', color: '#166534' },
    blue: { bg: '#dbeafe', color: '#1e40af' },
    amber: { bg: '#fef3c7', color: '#92400e' },
  }[variant];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: '12px',
        fontSize: '12px',
        fontWeight: 600,
        backgroundColor: styles.bg,
        color: styles.color,
      }}
    >
      {label}
    </span>
  );
}
