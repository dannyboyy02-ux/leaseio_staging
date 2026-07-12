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

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Watermark band — fixed on every page */}
        <View style={styles.watermarkBand} fixed>
          <Text style={styles.watermarkText}>{t('reports.not_financial_statement', { defaultValue: NOT_A_FINANCIAL_STATEMENT_BANNER })}</Text>
          <Text style={styles.watermarkRight}>{t('reports.pdf_report_id_short', { id: reportId.slice(0, 8) })}</Text>
        </View>

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brandLeft}>
            <Text style={styles.wordmark}>LeaseIO</Text>
            <Text style={styles.reportTitle}>
              {t('reports.pdf_lease_report_title', { label: leaseLabel })}
            </Text>
          </View>
          <View style={styles.brandRight}>
            <Text style={styles.brandRightLine}>{organizationName}</Text>
            <Text style={styles.brandRightLine}>{t('reports.generated_on', { date: generatedAtDisplay })}</Text>
          </View>
        </View>

        {/* Liability disclaimer */}
        <View style={styles.disclaimerBox}>
          <Text style={styles.disclaimerText}>{t('reports.disclaimer_body', { defaultValue: LIABILITY_DISCLAIMER })}</Text>
        </View>

        {renderLeaseSections(sections)}

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>
            {t('reports.pdf_footer_line', { date: generatedAtDisplay })}
          </Text>
          <Text
            style={styles.footerText}
            render={({ pageNumber, totalPages }) =>
              t('reports.pdf_page_of', { page: pageNumber, total: totalPages })
            }
          />
        </View>
      </Page>
    </Document>
  );
}
