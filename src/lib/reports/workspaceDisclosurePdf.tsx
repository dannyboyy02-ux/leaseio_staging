// Workspace-wide ASC 842 disclosure-report PDF.
//
// Consolidates every model-locked lease in the workspace into a single
// PDF: a cover page (workspace identity + lease count + liability box),
// followed by one report Page per lease using the same layout as the
// per-lease LeaseDisclosureDocument.
//
// LIABILITY PROTECTION
// The "LeaseIO Data Report — Not a Financial Statement" banner appears
// on EVERY page (View has the `fixed` prop). The liability disclaimer
// renders on the cover page in a bordered box. These two devices are
// the product's liability shield — do not remove or weaken either
// without consulting docs/PRODUCT_STRATEGY.md.

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from '@react-pdf/renderer';
// Non-component module — no hooks; the app initializes i18next at boot
// (src/i18n.ts), so the bound global t resolves the active language at
// PDF-generation time.
import { t } from 'i18next';
import {
  LIABILITY_DISCLAIMER,
  NOT_A_FINANCIAL_STATEMENT_BANNER,
  type ReportSection,
} from '@/lib/asc842Report';
import { renderLeaseSections } from '@/lib/reports/leaseDisclosureSections';

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
  coverHeader: {
    marginTop: 24,
    marginBottom: 18,
    paddingBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: '#1d4ed8',
  },
  coverWordmark: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#1d4ed8',
    letterSpacing: 0.5,
  },
  coverTitle: {
    fontSize: 14,
    color: '#111827',
    marginTop: 8,
  },
  coverSubtitle: {
    fontSize: 10,
    color: '#6b7280',
    marginTop: 4,
  },
  coverFactGrid: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
    marginBottom: 16,
  },
  coverFact: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 10,
    borderRadius: 2,
  },
  coverFactLabel: {
    fontSize: 7.5,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  coverFactValue: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#111827',
  },
  disclaimerBox: {
    backgroundColor: '#fff7ed',
    borderWidth: 0.5,
    borderColor: '#fdba74',
    padding: 10,
    marginVertical: 12,
    borderRadius: 2,
  },
  disclaimerText: {
    fontSize: 9,
    color: '#7c2d12',
    lineHeight: 1.55,
  },
  tocHeading: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#1d4ed8',
    marginTop: 14,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  tocRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e5e7eb',
  },
  tocLabel: {
    fontSize: 9,
    color: '#374151',
    flex: 1,
  },
  tocIndex: {
    fontSize: 9,
    color: '#6b7280',
    fontWeight: 'bold',
  },
  leasePageHeader: {
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

interface LeasePayload {
  leaseId: string;
  leaseLabel: string;
  sections: ReportSection[];
}

interface Props {
  organizationName: string;
  generatedAtIso: string;
  leases: LeasePayload[];
}

export function WorkspaceDisclosureDocument({
  organizationName,
  generatedAtIso,
  leases,
}: Props) {
  const generatedAtDisplay = generatedAtIso.slice(0, 19).replace('T', ' ') + ' UTC';
  const reportId = `ws-${Date.now().toString(36)}`;

  return (
    <Document>
      {/* Cover page */}
      <Page size="LETTER" style={styles.page}>
        <View style={styles.watermarkBand} fixed>
          <Text style={styles.watermarkText}>{t('reports.not_financial_statement', { defaultValue: NOT_A_FINANCIAL_STATEMENT_BANNER })}</Text>
          <Text style={styles.watermarkRight}>{t('reports.pdf_consolidated_id', { id: reportId.slice(0, 12) })}</Text>
        </View>

        <View style={styles.coverHeader}>
          <Text style={styles.coverWordmark}>LeaseIO</Text>
          <Text style={styles.coverTitle}>{t('reports.pdf_consolidated_title')}</Text>
          <Text style={styles.coverSubtitle}>
            {organizationName} · {t('reports.generated_on', { date: generatedAtDisplay })}
          </Text>
        </View>

        <View style={styles.coverFactGrid}>
          <View style={styles.coverFact}>
            <Text style={styles.coverFactLabel}>{t('reports.pdf_workspace_label')}</Text>
            <Text style={styles.coverFactValue}>{organizationName}</Text>
          </View>
          <View style={styles.coverFact}>
            <Text style={styles.coverFactLabel}>{t('reports.pdf_leases_included')}</Text>
            <Text style={styles.coverFactValue}>{leases.length}</Text>
          </View>
          <View style={styles.coverFact}>
            <Text style={styles.coverFactLabel}>{t('reports.pdf_generated_label')}</Text>
            <Text style={styles.coverFactValue}>{generatedAtIso.slice(0, 10)}</Text>
          </View>
        </View>

        <View style={styles.disclaimerBox}>
          <Text style={styles.disclaimerText}>{t('reports.disclaimer_body', { defaultValue: LIABILITY_DISCLAIMER })}</Text>
        </View>

        {leases.length > 0 && (
          <>
            <Text style={styles.tocHeading}>{t('reports.pdf_contents')}</Text>
            {leases.map((lease, i) => (
              <View key={`toc-${lease.leaseId}`} style={styles.tocRow}>
                <Text style={styles.tocLabel}>{lease.leaseLabel}</Text>
                <Text style={styles.tocIndex}>{i + 1}</Text>
              </View>
            ))}
          </>
        )}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {t('reports.pdf_footer_line', { date: generatedAtDisplay })}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) => t('reports.pdf_page_of', { page: pageNumber, total: totalPages })}
          />
        </View>
      </Page>

      {/* One Page per lease — shared rendering with the per-lease document */}
      {leases.map((lease) => (
        <Page key={lease.leaseId} size="LETTER" style={styles.page}>
          <View style={styles.watermarkBand} fixed>
            <Text style={styles.watermarkText}>{t('reports.not_financial_statement', { defaultValue: NOT_A_FINANCIAL_STATEMENT_BANNER })}</Text>
            <Text style={styles.watermarkRight}>{t('reports.pdf_consolidated_id', { id: reportId.slice(0, 12) })}</Text>
          </View>

          <View style={styles.leasePageHeader}>
            <View style={styles.brandLeft}>
              <Text style={styles.wordmark}>LeaseIO</Text>
              <Text style={styles.reportTitle}>{t('reports.pdf_lease_disclosure_title', { label: lease.leaseLabel })}</Text>
            </View>
            <View style={styles.brandRight}>
              <Text style={styles.brandRightLine}>{organizationName}</Text>
              <Text style={styles.brandRightLine}>{t('reports.generated_on', { date: generatedAtDisplay })}</Text>
            </View>
          </View>

          {renderLeaseSections(lease.sections)}

          <View style={styles.footer} fixed>
            <Text style={styles.footerText}>
              {t('reports.pdf_footer_line', { date: generatedAtDisplay })}
            </Text>
            <Text
              style={styles.footerText}
              render={({ pageNumber, totalPages }) => t('reports.pdf_page_of', { page: pageNumber, total: totalPages })}
            />
          </View>
        </Page>
      ))}
    </Document>
  );
}
