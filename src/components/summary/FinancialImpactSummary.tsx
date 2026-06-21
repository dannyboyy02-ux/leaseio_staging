import { format } from 'date-fns';
import { displayLabel, type LifecycleStatus } from '@/lib/lifecycleStates';
import { formatLocalizedCurrency, type SupportedLocale } from '@/lib/dateFormatters';
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

function fmtDate(d: string) {
  if (!d) return '\u2014';
  try {
    return format(new Date(d + (d.length === 10 ? 'T12:00:00' : '')), 'MMM d, yyyy');
  } catch {
    return d;
  }
}

function fmtDateTime(d: string) {
  if (!d) return '\u2014';
  try {
    return format(new Date(d), 'MMM d, yyyy h:mm a');
  } catch {
    return d;
  }
}

function titleCase(s: string) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function FinancialImpactSummary({ data, shareUrl, generatedAt }: Props) {
  const { language } = useLanguage();
  const isApproved = APPROVED_STATUSES.includes(data.lifecycleStatus);
  const isDraft = !isApproved;

  const classificationLabel =
    data.leaseClassification === 'operating'
      ? 'Operating Lease'
      : data.leaseClassification === 'finance'
      ? 'Finance Lease'
      : 'Pending Financial Review';

  const assetLabel = data.assetType
    ? data.assetType.charAt(0).toUpperCase() + data.assetType.slice(1)
    : '\u2014';

  const today = generatedAt || new Date().toISOString();

  const metrics = [
    {
      label: 'Total Cash Commitment',
      value: fmt(data.calcTotalCommitment, language),
      sublabel: `Over ${data.termMonths} months`,
      color: '#1d4ed8',
      bg: '#eff6ff',
      border: '#bfdbfe',
    },
    {
      label: 'Estimated Lease Liability',
      value: fmt(data.calcPvLiability, language),
      sublabel: `PV at ${data.discountRateUsed}% discount rate`,
      color: '#7c3aed',
      bg: '#f5f3ff',
      border: '#ddd6fe',
    },
    {
      label: 'Monthly P&L Charge',
      value: fmt(data.calcStraightLineExp, language),
      sublabel: 'Straight-line per month',
      color: '#059669',
      bg: '#f0fdf4',
      border: '#bbf7d0',
    },
    {
      label: 'Cash vs. P&L Delta',
      value: (data.calcCashPlDelta >= 0 ? '+' : '') + fmt(data.calcCashPlDelta, language),
      sublabel: 'At lease midpoint',
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
            DRAFT \u2014 PENDING APPROVAL
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
              Lease Commitment \u2014 Financial Impact Summary
            </h1>
          </div>
          <div style={{ textAlign: 'right', fontSize: '13px', color: '#6b7280', flexShrink: 0 }}>
            <div>Generated</div>
            <div style={{ fontWeight: 600, color: '#374151' }}>{fmtDate(today)}</div>
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
                DRAFT
              </div>
            )}
          </div>
        </div>

        {/* ── Commitment Details ── */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>Commitment Details</SectionHeading>
          <FieldTable
            rows={[
              ['Description', data.requestTitle || '\u2014'],
              ['Asset Type', assetLabel],
              ['Vendor', data.vendor || '\u2014'],
              ['Requesting Department', data.requestingDepartment || '\u2014'],
              ['Submitted', fmtDate(data.submittedAt)],
              ['Status', data.lifecycleStatus ? displayLabel(data.lifecycleStatus as LifecycleStatus) : '\u2014'],
            ]}
          />
        </section>

        {/* ── Lease Terms ── */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>Lease Terms</SectionHeading>
          <FieldTable
            rows={[
              ['Monthly Payment', data.monthlyPayment ? fmt(data.monthlyPayment, language) : '\u2014'],
              ['Term', data.termMonths ? `${data.termMonths} months` : '\u2014'],
              ['Start Date', fmtDate(data.startDate)],
              ['End Date', fmtDate(data.endDate)],
              ['Annual Escalation', data.escalationRate > 0 ? `${data.escalationRate}%` : 'None'],
            ]}
          />
        </section>

        {/* ── Financial Impact (hero) ── */}
        <section style={{ marginBottom: '28px' }}>
          <SectionHeading>Financial Impact</SectionHeading>
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
          <SectionHeading>Classification &amp; Governance</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ color: '#6b7280', fontWeight: 500, minWidth: '170px' }}>
                Lease Classification
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
                Covenant Impact
              </span>
              <StatusPill
                label={data.covenantFlagged ? 'Flagged for Review' : 'No Covenant Impact'}
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
                \u2139\uFE0F This lease will be recognized as a right-of-use asset on the balance
                sheet.
              </div>
            )}
          </div>
        </section>

        {/* ── Approval Record (only if approved) ── */}
        {isApproved && (data.financialApprovedAt || data.financialApproverName) && (
          <section style={{ marginBottom: '28px' }}>
            <SectionHeading>Approval Record</SectionHeading>
            <FieldTable
              rows={[
                ...(data.financialApproverName
                  ? [['Approved By', data.financialApproverName] as [string, string]]
                  : []),
                ...(data.financialApprovedAt
                  ? [['Approval Date', fmtDateTime(data.financialApprovedAt)] as [string, string]]
                  : []),
                ['Classification Confirmed', classificationLabel],
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
            Generated by LeaseIO \u2014 Pre-signing financial intelligence
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
            This summary is generated from inputs provided at quote stage. Final terms are subject
            to executed lease agreement.
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
