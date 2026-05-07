// Portfolio-period ASC 842 disclosure-report PDF.
// Consumes the PortfolioReport produced by buildPortfolioPeriodReport in
// src/lib/asc842Report.ts and renders to a Letter-sized PDF via
// @react-pdf/renderer.
//
// Watermark and disclaimer protection mirrors leaseDisclosurePdf.tsx
// — see that file's header for the rationale. Both are intentional.

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
  type PortfolioReport,
  type PreparerFlagSeverity,
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
  totalsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  },
  totalsCell: {
    width: '32%',
    backgroundColor: '#f9fafb',
    padding: 6,
    borderRadius: 2,
    marginBottom: 6,
  },
  cellLabel: {
    fontSize: 7.5,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  cellValue: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#111827',
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
  exclusionGroup: {
    marginBottom: 6,
  },
  exclusionTitle: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#374151',
    marginBottom: 2,
  },
  exclusionList: {
    fontSize: 8,
    color: '#6b7280',
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

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'not_model_locked':
      return 'Not yet model-locked';
    case 'not_active':
      return 'Not in active lifecycle';
    case 'period_no_overlap':
      return 'Term does not overlap period';
    case 'verification_incomplete':
      return 'Verification incomplete';
    default:
      return reason;
  }
}

interface Props {
  report: PortfolioReport;
  reportId: string;
}

export function PortfolioReportDocument({ report, reportId }: Props) {
  const generatedAtDisplay =
    report.report_metadata.generated_at.slice(0, 19).replace('T', ' ') +
    ' UTC';

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.watermarkBand} fixed>
          <Text style={styles.watermarkText}>
            {NOT_A_FINANCIAL_STATEMENT_BANNER}
          </Text>
          <Text style={styles.watermarkRight}>
            Report {reportId.slice(0, 8)}
          </Text>
        </View>

        <View style={styles.header}>
          <View style={styles.brandLeft}>
            <Text style={styles.wordmark}>LeaseIO</Text>
            <Text style={styles.reportTitle}>
              Portfolio Disclosure — {report.report_metadata.period_start}{' '}
              through {report.report_metadata.period_end}
            </Text>
          </View>
          <View style={styles.brandRight}>
            <Text style={styles.brandRightLine}>
              {report.report_metadata.organization_name}
            </Text>
            <Text style={styles.brandRightLine}>
              Generated {generatedAtDisplay}
            </Text>
          </View>
        </View>

        <View style={styles.disclaimerBox}>
          <Text style={styles.disclaimerText}>{LIABILITY_DISCLAIMER}</Text>
        </View>

        {/* Totals */}
        <Text style={styles.sectionTitle}>Portfolio Totals</Text>
        <View style={styles.totalsGrid}>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Leases included</Text>
            <Text style={styles.cellValue}>
              {report.totals.lease_count}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Leases excluded</Text>
            <Text style={styles.cellValue}>
              {report.totals.excluded_count}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Operating</Text>
            <Text style={styles.cellValue}>
              {report.totals.operating_lease_count}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Finance</Text>
            <Text style={styles.cellValue}>
              {report.totals.finance_lease_count}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Pending classification</Text>
            <Text style={styles.cellValue}>
              {report.totals.pending_classification_count}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Total PV liability</Text>
            <Text style={styles.cellValue}>
              {formatCurrency(report.totals.total_pv_liability)}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Total commitment</Text>
            <Text style={styles.cellValue}>
              {formatCurrency(report.totals.total_commitment)}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Total monthly straight-line</Text>
            <Text style={styles.cellValue}>
              {formatCurrency(report.totals.total_monthly_straight_line)}
            </Text>
          </View>
          <View style={styles.totalsCell}>
            <Text style={styles.cellLabel}>Discount rate methodology</Text>
            <Text style={styles.cellValue}>
              {report.report_metadata.discount_rate_method}
            </Text>
          </View>
        </View>

        {/* Per-lease summaries */}
        {report.per_lease_summaries.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Per-Lease Summary</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderText, { flex: 2 }]}>Tenant</Text>
              <Text style={[styles.tableHeaderText, { flex: 1 }]}>Class</Text>
              <Text
                style={[
                  styles.tableHeaderText,
                  { flex: 1.5, textAlign: 'right' },
                ]}
              >
                PV Liab
              </Text>
              <Text
                style={[
                  styles.tableHeaderText,
                  { flex: 1.5, textAlign: 'right' },
                ]}
              >
                Commitment
              </Text>
              <Text
                style={[
                  styles.tableHeaderText,
                  { flex: 1, textAlign: 'right' },
                ]}
              >
                Flags
              </Text>
            </View>
            {report.per_lease_summaries.map((s) => (
              <View key={s.lease_id} style={styles.tableRow} wrap={false}>
                <Text style={[styles.tableCell, { flex: 2 }]}>
                  {s.tenant_name ?? s.lease_id.slice(0, 8)}
                </Text>
                <Text style={[styles.tableCell, { flex: 1 }]}>
                  {s.classification}
                </Text>
                <Text
                  style={[
                    styles.tableCell,
                    { flex: 1.5, textAlign: 'right' },
                  ]}
                >
                  {formatCurrency(s.pv_liability)}
                </Text>
                <Text
                  style={[
                    styles.tableCell,
                    { flex: 1.5, textAlign: 'right' },
                  ]}
                >
                  {formatCurrency(s.total_commitment)}
                </Text>
                <Text
                  style={[
                    styles.tableCell,
                    {
                      flex: 1,
                      textAlign: 'right',
                      color:
                        s.high_severity_flag_count > 0 ? '#dc2626' : '#374151',
                    },
                  ]}
                >
                  {s.flag_count} ({s.high_severity_flag_count} high)
                </Text>
              </View>
            ))}
          </>
        )}

        {/* Exclusions */}
        {report.exclusions.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Excluded Leases</Text>
            {report.exclusions.map((g) => (
              <View key={g.reason} style={styles.exclusionGroup}>
                <Text style={styles.exclusionTitle}>
                  {reasonLabel(g.reason)} ({g.count})
                </Text>
                <Text style={styles.exclusionList}>
                  {g.lease_ids
                    .map((id) => id.slice(0, 8))
                    .join(', ')}
                </Text>
              </View>
            ))}
          </>
        )}

        {/* Preparer Notes */}
        {report.preparer_notes.flags.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Preparer Notes</Text>
            {report.preparer_notes.flags.map((flag, i) => (
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
