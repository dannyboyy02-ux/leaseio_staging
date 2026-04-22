import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import { type ReportLease, type ReportProse, formatReportCurrency, formatReportDate } from '@/lib/reportGeneration';
// Helvetica is a standard PDF font available in @react-pdf/renderer without Font.register()

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: '#111827',
    paddingTop: 44,
    paddingBottom: 44,
    paddingHorizontal: 48,
    lineHeight: 1.5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 20,
    paddingBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: '#1d4ed8',
  },
  headerLeft: {
    flexDirection: 'column',
  },
  wordmark: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1d4ed8',
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    fontSize: 8,
    color: '#6b7280',
    marginTop: 2,
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  headerDate: {
    fontSize: 8,
    color: '#6b7280',
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#1d4ed8',
    marginTop: 16,
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#bfdbfe',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  executiveBox: {
    backgroundColor: '#eff6ff',
    borderLeftWidth: 3,
    borderLeftColor: '#1d4ed8',
    padding: 10,
    marginBottom: 16,
    borderRadius: 2,
  },
  executiveText: {
    fontSize: 9.5,
    color: '#1e3a5f',
    lineHeight: 1.6,
  },
  prose: {
    fontSize: 9,
    color: '#374151',
    lineHeight: 1.65,
    marginBottom: 8,
  },
  grid2: {
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
  riskRow: {
    flexDirection: 'row',
    marginBottom: 6,
    gap: 6,
  },
  riskBadge: {
    width: 44,
    paddingTop: 3,
    paddingBottom: 3,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  riskBadgeText: {
    fontSize: 7,
    fontWeight: 'bold',
    color: '#ffffff',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  riskContent: {
    flex: 1,
  },
  riskTitle: {
    fontSize: 8.5,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 2,
  },
  riskNarrative: {
    fontSize: 8.5,
    color: '#374151',
    lineHeight: 1.5,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    paddingVertical: 4,
    paddingHorizontal: 6,
    marginBottom: 2,
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

interface Props {
  lease: ReportLease;
  prose: ReportProse;
  generatedAt: string;
}

export function LeaseAnalysisDocument({ lease, prose, generatedAt }: Props) {
  const hasRentSchedule = lease.rent_schedule.length > 1;

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.wordmark}>LeaseIO</Text>
            <Text style={styles.headerSubtitle}>Lease Analysis Report</Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.headerDate}>Generated {generatedAt}</Text>
            <Text style={[styles.headerDate, { marginTop: 2 }]}>{lease.display_name}</Text>
          </View>
        </View>

        {/* Executive Notes */}
        {prose.executive_notes && (
          <View style={styles.executiveBox}>
            <Text style={styles.executiveText}>{prose.executive_notes}</Text>
          </View>
        )}

        {/* Executive Summary fields */}
        <Text style={styles.sectionTitle}>Executive Summary</Text>
        <View style={styles.grid2}>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Landlord</Text>
            <Text style={styles.cellValue}>{lease.landlord || '—'}</Text>
          </View>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Tenant</Text>
            <Text style={styles.cellValue}>{lease.tenant || '—'}</Text>
          </View>
        </View>
        <View style={styles.grid2}>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Property</Text>
            <Text style={styles.cellValue}>{lease.property_address || '—'}</Text>
          </View>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Asset Type</Text>
            <Text style={styles.cellValue}>{lease.asset_type ? lease.asset_type.replace('_', ' ') : '—'}</Text>
          </View>
        </View>
        <View style={styles.grid2}>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Lease Start</Text>
            <Text style={styles.cellValue}>{formatReportDate(lease.lease_start)}</Text>
          </View>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Lease End</Text>
            <Text style={styles.cellValue}>{formatReportDate(lease.lease_end)}</Text>
          </View>
        </View>
        {lease.square_footage && (
          <View style={styles.grid2}>
            <View style={styles.cell}>
              <Text style={styles.cellLabel}>Square Footage</Text>
              <Text style={styles.cellValue}>{lease.square_footage.toLocaleString()} SF</Text>
            </View>
            <View style={styles.cell}>
              <Text style={styles.cellLabel}>Term</Text>
              <Text style={styles.cellValue}>{lease.term_months ? `${lease.term_months} months` : '—'}</Text>
            </View>
          </View>
        )}

        {/* Financial Summary */}
        <Text style={styles.sectionTitle}>Financial Obligations</Text>
        {prose.financial_summary && (
          <Text style={styles.prose}>{prose.financial_summary}</Text>
        )}
        <View style={styles.grid2}>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Base Monthly Rent</Text>
            <Text style={styles.cellValue}>{formatReportCurrency(lease.monthly_rent)}</Text>
          </View>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Escalation</Text>
            <Text style={styles.cellValue}>
              {lease.escalation_type === 'percent' && lease.escalation_rate
                ? `${lease.escalation_rate}% annually`
                : lease.escalation_type === 'index'
                ? 'Index-based (CPI)'
                : lease.escalation_type === 'none'
                ? 'None'
                : '—'}
            </Text>
          </View>
        </View>
        <View style={styles.grid2}>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>Total Commitment</Text>
            <Text style={styles.cellValue}>{formatReportCurrency(lease.total_commitment)}</Text>
          </View>
          <View style={styles.cell}>
            <Text style={styles.cellLabel}>PV Liability</Text>
            <Text style={styles.cellValue}>{formatReportCurrency(lease.pv_liability)}</Text>
          </View>
        </View>
        {lease.security_deposit && (
          <View style={styles.grid2}>
            <View style={[styles.cell, { flex: 2 }]}>
              <Text style={styles.cellLabel}>Security Deposit</Text>
              <Text style={styles.cellValue}>{lease.security_deposit}</Text>
            </View>
          </View>
        )}

        {/* Rent Schedule (only if multiple periods) */}
        {hasRentSchedule && (
          <>
            <Text style={styles.sectionTitle}>Rent Schedule</Text>
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderText, { flex: 2 }]}>Period</Text>
              <Text style={[styles.tableHeaderText, { flex: 1.5, textAlign: 'right' }]}>Monthly</Text>
              <Text style={[styles.tableHeaderText, { flex: 1.5, textAlign: 'right' }]}>Annual</Text>
              <Text style={[styles.tableHeaderText, { flex: 2 }]}>Notes</Text>
            </View>
            {lease.rent_schedule.slice(0, 8).map((row, i) => (
              <View key={i} style={styles.tableRow}>
                <Text style={[styles.tableCell, { flex: 2 }]}>
                  {row.period_start ? row.period_start.slice(0, 7) : '—'}
                  {row.period_end ? ` – ${row.period_end.slice(0, 7)}` : ''}
                </Text>
                <Text style={[styles.tableCell, { flex: 1.5, textAlign: 'right' }]}>
                  {row.monthly_amount ? formatReportCurrency(row.monthly_amount) : '—'}
                </Text>
                <Text style={[styles.tableCell, { flex: 1.5, textAlign: 'right' }]}>
                  {row.annual_amount ? formatReportCurrency(row.annual_amount) : '—'}
                </Text>
                <Text style={[styles.tableCell, { flex: 2 }]}>{row.notes || ''}</Text>
              </View>
            ))}
          </>
        )}

        {/* Key Clauses */}
        <Text style={styles.sectionTitle}>Key Clauses</Text>
        {prose.key_clauses_summary && (
          <Text style={styles.prose}>{prose.key_clauses_summary}</Text>
        )}
        {lease.renewal_options && (
          <View style={styles.grid2}>
            <View style={[styles.cell, { flex: 1 }]}>
              <Text style={styles.cellLabel}>Renewal Options</Text>
              <Text style={styles.cellValue}>{lease.renewal_options}</Text>
            </View>
          </View>
        )}
        {lease.termination_clauses && (
          <View style={styles.grid2}>
            <View style={[styles.cell, { flex: 1 }]}>
              <Text style={styles.cellLabel}>Termination Provisions</Text>
              <Text style={styles.cellValue}>{lease.termination_clauses}</Text>
            </View>
          </View>
        )}

        {/* Risk Register */}
        {lease.risks.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Risk Register</Text>
            {lease.risks.map((risk, i) => {
              const riskProse = prose.risk_narrative?.find(r => r.title === risk.title);
              const bgColor = risk.severity === 'high' ? '#dc2626' : risk.severity === 'medium' ? '#d97706' : '#2563eb';
              return (
                <View key={i} style={styles.riskRow}>
                  <View style={[styles.riskBadge, { backgroundColor: bgColor }]}>
                    <Text style={styles.riskBadgeText}>{risk.severity}</Text>
                  </View>
                  <View style={styles.riskContent}>
                    <Text style={styles.riskTitle}>{risk.title}</Text>
                    <Text style={styles.riskNarrative}>
                      {riskProse?.narrative || risk.explanation}
                    </Text>
                  </View>
                </View>
              );
            })}
          </>
        )}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>LeaseIO · Confidential · Generated {generatedAt}</Text>
          <Text style={styles.footerText}>AI-assisted analysis — verify all terms against original document</Text>
        </View>
      </Page>
    </Document>
  );
}
