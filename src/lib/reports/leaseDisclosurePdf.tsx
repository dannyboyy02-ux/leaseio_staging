// Single-lease ASC 842 disclosure-report PDF.
// Consumes the structured ReportSection[] produced by
// buildLeaseDisclosureSections in src/lib/asc842Report.ts and renders to
// a Letter-sized PDF via @react-pdf/renderer.
//
// LIABILITY PROTECTION
// The "LeaseIO Data Report — Not a Financial Statement" banner appears
// on EVERY page (View has the `fixed` prop) so it remains visible even
// if the user crops, screenshots, or excerpts a single page. The
// liability disclaimer prints on the cover page in a bordered box.
// These two devices are the product's liability shield — do not
// remove or weaken either without consulting docs/PRODUCT_STRATEGY.md.

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';
import {
  LIABILITY_DISCLAIMER,
  NOT_A_FINANCIAL_STATEMENT_BANNER,
  type Asc842InputsSection,
  type IdentificationSection,
  type KeyTermsSection,
  type PaymentScheduleSection,
  type PreparerFlagSeverity,
  type PreparerNotesSection,
  type ReportSection,
  type VerificationAuditSection,
} from '@/lib/asc842Report';

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: '#111827',
    paddingTop: 56,
    paddingBottom: 50,
    paddingHorizontal: 48,
    lineHeight: 1.5,
  },
  watermarkBand: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#fef3c7',
    borderBottomWidth: 1,
    borderBottomColor: '#b45309',
    paddingVertical: 4,
    paddingHorizontal: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  watermarkText: {
    fontSize: 8,
    fontWeight: 'bold',
    color: '#92400e',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  watermarkRight: {
    fontSize: 7,
    color: '#92400e',
  },
  header: {
    marginTop: 8,
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: '#1d4ed8',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  brandLeft: {
    flexDirection: 'column',
  },
  wordmark: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1d4ed8',
    letterSpacing: 0.5,
  },
  reportTitle: {
    fontSize: 9,
    color: '#374151',
    marginTop: 2,
  },
  brandRight: {
    alignItems: 'flex-end',
  },
  brandRightLine: {
    fontSize: 8,
    color: '#6b7280',
  },
  disclaimerBox: {
    backgroundColor: '#fff7ed',
    borderWidth: 0.5,
    borderColor: '#fdba74',
    padding: 8,
    marginBottom: 14,
    borderRadius: 2,
  },
  disclaimerText: {
    fontSize: 8,
    color: '#7c2d12',
    lineHeight: 1.5,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#1d4ed8',
    marginTop: 14,
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#bfdbfe',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  twoCol: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 4,
  },
  cell: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 6,
    borderRadius: 2,
  },
  cellLabel: {
    fontSize: 7.5,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  cellValue: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#111827',
  },
  cellCitation: {
    fontSize: 7,
    color: '#6b7280',
    marginTop: 3,
    fontStyle: 'italic',
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginBottom: 1,
  },
  tableHeaderText: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e5e7eb',
  },
  tableCell: {
    fontSize: 8.5,
    color: '#374151',
  },
  totalsRow: {
    flexDirection: 'row',
    paddingVertical: 4,
    paddingHorizontal: 6,
    backgroundColor: '#eff6ff',
    borderTopWidth: 0.5,
    borderTopColor: '#bfdbfe',
    marginTop: 2,
  },
  totalsLabel: {
    fontSize: 8.5,
    color: '#1e3a5f',
    fontWeight: 'bold',
  },
  totalsValue: {
    fontSize: 8.5,
    color: '#1e3a5f',
    fontWeight: 'bold',
    textAlign: 'right',
  },
  flagRow: {
    flexDirection: 'row',
    marginBottom: 6,
    gap: 6,
    alignItems: 'flex-start',
  },
  flagBadge: {
    width: 56,
    paddingVertical: 3,
    borderRadius: 2,
    alignItems: 'center',
  },
  flagBadgeText: {
    fontSize: 7,
    fontWeight: 'bold',
    color: '#ffffff',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  flagContent: {
    flex: 1,
  },
  flagTitle: {
    fontSize: 8.5,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 2,
  },
  flagExplanation: {
    fontSize: 8.5,
    color: '#374151',
    lineHeight: 1.5,
  },
  prose: {
    fontSize: 9,
    color: '#374151',
    lineHeight: 1.65,
    marginBottom: 8,
  },
  attestationBox: {
    backgroundColor: '#ecfdf5',
    borderLeftWidth: 3,
    borderLeftColor: '#059669',
    padding: 8,
    marginVertical: 6,
    borderRadius: 2,
  },
  attestationLabel: {
    fontSize: 7.5,
    fontWeight: 'bold',
    color: '#065f46',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 3,
  },
  attestationBody: {
    fontSize: 9,
    color: '#064e3b',
    lineHeight: 1.5,
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 48,
    right: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 0.5,
    borderTopColor: '#e5e7eb',
    paddingTop: 6,
  },
  footerText: {
    fontSize: 7,
    color: '#9ca3af',
  },
});

const SEVERITY_COLOR: Record<PreparerFlagSeverity, string> = {
  high: '#dc2626',
  medium: '#d97706',
  low: '#2563eb',
};

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(2)}%`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return value.slice(0, 10);
}

function formatLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return value;
}

interface Props {
  organizationName: string;
  leaseLabel: string;
  generatedAtIso: string;
  reportId: string;
  sections: ReportSection[];
}

export function LeaseDisclosureDocument({
  organizationName,
  leaseLabel,
  generatedAtIso,
  reportId,
  sections,
}: Props) {
  const generatedAtDisplay = generatedAtIso.slice(0, 19).replace('T', ' ') + ' UTC';

  const identification = sections.find((s) => s.kind === 'identification')
    ?.data as IdentificationSection | undefined;
  const payment = sections.find((s) => s.kind === 'payment_schedule')
    ?.data as PaymentScheduleSection | undefined;
  const asc842 = sections.find((s) => s.kind === 'asc842_inputs')
    ?.data as Asc842InputsSection | undefined;
  const keyTerms = sections.find((s) => s.kind === 'key_terms')
    ?.data as KeyTermsSection | undefined;
  const preparer = sections.find((s) => s.kind === 'preparer_notes')
    ?.data as PreparerNotesSection | undefined;
  const audit = sections.find((s) => s.kind === 'verification_audit')
    ?.data as VerificationAuditSection | undefined;

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Watermark band — fixed on every page */}
        <View style={styles.watermarkBand} fixed>
          <Text style={styles.watermarkText}>
            {NOT_A_FINANCIAL_STATEMENT_BANNER}
          </Text>
          <Text style={styles.watermarkRight}>
            Report {reportId.slice(0, 8)}
          </Text>
        </View>

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brandLeft}>
            <Text style={styles.wordmark}>LeaseIO</Text>
            <Text style={styles.reportTitle}>
              ASC 842 Disclosure Report — {leaseLabel}
            </Text>
          </View>
          <View style={styles.brandRight}>
            <Text style={styles.brandRightLine}>{organizationName}</Text>
            <Text style={styles.brandRightLine}>
              Generated {generatedAtDisplay}
            </Text>
          </View>
        </View>

        {/* Liability disclaimer */}
        <View style={styles.disclaimerBox}>
          <Text style={styles.disclaimerText}>{LIABILITY_DISCLAIMER}</Text>
        </View>

        {/* Identification */}
        {identification && (
          <>
            <Text style={styles.sectionTitle}>Lease Identification</Text>
            {pairChunks(identification.fields).map((pair, i) => (
              <View key={`id-${i}`} style={styles.twoCol}>
                {pair.map((field, j) => (
                  <View key={`idc-${i}-${j}`} style={styles.cell}>
                    <Text style={styles.cellLabel}>{field.label}</Text>
                    <Text style={styles.cellValue}>
                      {formatLabel(field.value)}
                    </Text>
                    {field.citation && (
                      <Text style={styles.cellCitation}>
                        Cite p.{field.citation.page}: "{field.citation.snippet}"
                      </Text>
                    )}
                  </View>
                ))}
                {pair.length === 1 && <View style={styles.cell} />}
              </View>
            ))}
          </>
        )}

        {/* ASC 842 Inputs */}
        {asc842 && (
          <>
            <Text style={styles.sectionTitle}>ASC 842 Measurement Inputs</Text>
            <View style={styles.twoCol}>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Classification</Text>
                <Text style={styles.cellValue}>{asc842.classification}</Text>
              </View>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Discount Rate (IBR)</Text>
                <Text style={styles.cellValue}>
                  {formatPercent(asc842.discount_rate_percent)}
                </Text>
              </View>
            </View>
            <View style={styles.twoCol}>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Term (months)</Text>
                <Text style={styles.cellValue}>
                  {asc842.term_months ?? '—'}
                </Text>
              </View>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Commencement</Text>
                <Text style={styles.cellValue}>
                  {formatDate(asc842.commencement_date)}
                </Text>
              </View>
            </View>
            <View style={styles.twoCol}>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Total Cash Commitment</Text>
                <Text style={styles.cellValue}>
                  {formatCurrency(asc842.total_commitment)}
                </Text>
              </View>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Present Value Liability</Text>
                <Text style={styles.cellValue}>
                  {formatCurrency(asc842.pv_liability)}
                </Text>
              </View>
            </View>
            <View style={styles.twoCol}>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>
                  Straight-Line Monthly Expense
                </Text>
                <Text style={styles.cellValue}>
                  {formatCurrency(asc842.straight_line_monthly_expense)}
                </Text>
              </View>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Cash vs P&amp;L Delta</Text>
                <Text style={styles.cellValue}>
                  {formatCurrency(asc842.cash_pl_delta)}
                </Text>
              </View>
            </View>
          </>
        )}

        {/* Payment Schedule */}
        {payment && (
          <>
            <Text style={styles.sectionTitle}>Payment Schedule</Text>
            {payment.periods.length > 0 ? (
              <>
                <View style={styles.tableHeader}>
                  <Text style={[styles.tableHeaderText, { flex: 2 }]}>
                    Period
                  </Text>
                  <Text
                    style={[
                      styles.tableHeaderText,
                      { flex: 1.5, textAlign: 'right' },
                    ]}
                  >
                    Monthly
                  </Text>
                  <Text
                    style={[
                      styles.tableHeaderText,
                      { flex: 1.5, textAlign: 'right' },
                    ]}
                  >
                    Annual
                  </Text>
                  <Text style={[styles.tableHeaderText, { flex: 2 }]}>
                    Notes
                  </Text>
                </View>
                {payment.periods.map((row, i) => (
                  <View key={`rs-${i}`} style={styles.tableRow}>
                    <Text style={[styles.tableCell, { flex: 2 }]}>
                      {formatDate(row.period_start)} –{' '}
                      {formatDate(row.period_end)}
                    </Text>
                    <Text
                      style={[
                        styles.tableCell,
                        { flex: 1.5, textAlign: 'right' },
                      ]}
                    >
                      {formatCurrency(row.monthly_amount)}
                    </Text>
                    <Text
                      style={[
                        styles.tableCell,
                        { flex: 1.5, textAlign: 'right' },
                      ]}
                    >
                      {formatCurrency(row.annual_amount)}
                    </Text>
                    <Text style={[styles.tableCell, { flex: 2 }]}>
                      {row.notes ?? ''}
                    </Text>
                  </View>
                ))}
                <View style={styles.totalsRow}>
                  <Text style={[styles.totalsLabel, { flex: 5.5 }]}>
                    Total Cash Commitment
                  </Text>
                  <Text style={[styles.totalsValue, { flex: 1.5 }]}>
                    {formatCurrency(payment.total_cash_commitment)}
                  </Text>
                </View>
                {payment.has_escalations && (
                  <Text style={[styles.cellCitation, { marginTop: 4 }]}>
                    Schedule contains escalating periods.
                  </Text>
                )}
                {payment.citation && (
                  <Text style={styles.cellCitation}>
                    Cite p.{payment.citation.page}: "{payment.citation.snippet}"
                  </Text>
                )}
              </>
            ) : (
              <Text style={styles.prose}>
                No rent schedule recorded for this lease.
              </Text>
            )}
          </>
        )}

        {/* Key Terms */}
        {keyTerms && (
          <>
            <Text style={styles.sectionTitle}>Key Terms</Text>
            <View style={styles.twoCol}>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Security Deposit</Text>
                <Text style={styles.cellValue}>
                  {formatCurrency(keyTerms.security_deposit)}
                </Text>
                {keyTerms.security_deposit_citation && (
                  <Text style={styles.cellCitation}>
                    Cite p.{keyTerms.security_deposit_citation.page}: "
                    {keyTerms.security_deposit_citation.snippet}"
                  </Text>
                )}
              </View>
              <View style={styles.cell}>
                <Text style={styles.cellLabel}>Asset Type</Text>
                <Text style={styles.cellValue}>
                  {formatLabel(keyTerms.asset_type)}
                </Text>
              </View>
            </View>
            {keyTerms.escalation_clause && (
              <View style={styles.twoCol}>
                <View style={[styles.cell, { flex: 1 }]}>
                  <Text style={styles.cellLabel}>Escalation</Text>
                  <Text style={styles.cellValue}>
                    {keyTerms.escalation_clause.type ?? '—'}
                    {keyTerms.escalation_clause.rate
                      ? ` (${keyTerms.escalation_clause.rate}%)`
                      : ''}
                  </Text>
                  {keyTerms.escalation_clause.notes && (
                    <Text style={styles.cellCitation}>
                      {keyTerms.escalation_clause.notes}
                    </Text>
                  )}
                </View>
              </View>
            )}
            {keyTerms.renewal_options.length > 0 && (
              <View style={styles.twoCol}>
                <View style={[styles.cell, { flex: 1 }]}>
                  <Text style={styles.cellLabel}>Renewal Options</Text>
                  {keyTerms.renewal_options.map((r, i) => (
                    <Text
                      key={`ro-${i}`}
                      style={[styles.cellValue, { fontWeight: 'normal' }]}
                    >
                      {r.option_term_months
                        ? `${r.option_term_months} months`
                        : 'Term not specified'}
                      {r.notice_required_days
                        ? ` — ${r.notice_required_days}-day notice`
                        : ''}
                      {r.notes ? ` — ${r.notes}` : ''}
                    </Text>
                  ))}
                </View>
              </View>
            )}
            {keyTerms.termination_clause && (
              <View style={styles.twoCol}>
                <View style={[styles.cell, { flex: 1 }]}>
                  <Text style={styles.cellLabel}>Termination Provisions</Text>
                  <Text style={styles.cellValue}>
                    {keyTerms.termination_clause.early_termination_allowed ===
                    true
                      ? 'Early termination permitted'
                      : keyTerms.termination_clause.early_termination_allowed ===
                          false
                        ? 'Early termination NOT permitted'
                        : 'Termination terms — see lease'}
                  </Text>
                  {keyTerms.termination_clause.notice_days !== null && (
                    <Text style={styles.cellCitation}>
                      Notice: {keyTerms.termination_clause.notice_days} days
                    </Text>
                  )}
                  {keyTerms.termination_clause.penalty_amount !== null && (
                    <Text style={styles.cellCitation}>
                      Penalty:{' '}
                      {formatCurrency(
                        keyTerms.termination_clause.penalty_amount,
                      )}
                    </Text>
                  )}
                  {keyTerms.termination_clause.notes && (
                    <Text style={styles.cellCitation}>
                      {keyTerms.termination_clause.notes}
                    </Text>
                  )}
                </View>
              </View>
            )}
          </>
        )}

        {/* Preparer Notes */}
        {preparer && preparer.flags.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Preparer Notes</Text>
            {preparer.flags.map((flag, i) => (
              <View key={`pf-${i}`} style={styles.flagRow} wrap={false}>
                <View
                  style={[
                    styles.flagBadge,
                    { backgroundColor: SEVERITY_COLOR[flag.severity] },
                  ]}
                >
                  <Text style={styles.flagBadgeText}>{flag.severity}</Text>
                </View>
                <View style={styles.flagContent}>
                  <Text style={styles.flagTitle}>{flag.title}</Text>
                  <Text style={styles.flagExplanation}>{flag.explanation}</Text>
                </View>
              </View>
            ))}
          </>
        )}

        {/* Verification Audit */}
        {audit && (
          <>
            <Text style={styles.sectionTitle}>Verification Audit Trail</Text>
            <Text style={styles.prose}>
              {audit.total_corrections} correction(s) and{' '}
              {audit.total_verified_unchanged} verified-unchanged
              confirmation(s) recorded.
              {audit.model_locked_at
                ? ` Lease finalized (model-locked) on ${audit.model_locked_at.slice(0, 10)} by ${audit.model_locked_by ?? '—'}.`
                : ' Lease NOT yet finalized (not model-locked).'}
            </Text>
            {audit.entries.length > 0 && (
              <>
                <View style={styles.tableHeader}>
                  <Text style={[styles.tableHeaderText, { flex: 2 }]}>
                    Field
                  </Text>
                  <Text style={[styles.tableHeaderText, { flex: 1.5 }]}>
                    Action
                  </Text>
                  <Text style={[styles.tableHeaderText, { flex: 2 }]}>
                    Confirmed at
                  </Text>
                  <Text style={[styles.tableHeaderText, { flex: 2 }]}>
                    Confirmed by
                  </Text>
                </View>
                {audit.entries.map((entry, i) => (
                  <View key={`va-${i}`} style={styles.tableRow}>
                    <Text style={[styles.tableCell, { flex: 2 }]}>
                      {entry.field_id}
                    </Text>
                    <Text style={[styles.tableCell, { flex: 1.5 }]}>
                      {entry.correction_type.replace(/_/g, ' ')}
                    </Text>
                    <Text style={[styles.tableCell, { flex: 2 }]}>
                      {entry.corrected_at.slice(0, 19).replace('T', ' ')}
                    </Text>
                    <Text style={[styles.tableCell, { flex: 2 }]}>
                      {entry.corrected_by_user_label}
                    </Text>
                  </View>
                ))}
              </>
            )}
            {audit.signator_attestation && (
              <View style={styles.attestationBox}>
                <Text style={styles.attestationLabel}>
                  Signator Attestation
                  {audit.signator_approved_at
                    ? ` — ${audit.signator_approved_at.slice(0, 10)}`
                    : ''}
                </Text>
                <Text style={styles.attestationBody}>
                  {audit.signator_attestation}
                </Text>
              </View>
            )}
          </>
        )}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            LeaseIO Data Report · Not a Financial Statement · {generatedAtDisplay}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

function pairChunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    out.push(items.slice(i, i + 2));
  }
  return out;
}
