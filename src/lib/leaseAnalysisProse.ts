// Deterministic prose generator for the Lease Analysis Report.
//
// Replaces a Claude Sonnet call that was just rephrasing structured
// data — no judgement, no portfolio context, just formatting. A template
// gives the same output, faster, free, deterministic, and available to
// all tiers.
//
// i18n: prose renders in the viewer's language at generation time (the PDF
// is built client-side on click, after i18next init), via the module-level
// `t` — same idiom as the PDF builders (LeaseAnalysisExport, RentRollExport).

import { t } from 'i18next';
import {
  formatReportCurrency,
  formatReportDate,
  type ReportLease,
  type ReportProse,
} from '@/lib/reportGeneration';

function sentences(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join(' ');
}

function describeTerm(lease: ReportLease): string {
  const months = lease.term_months;
  const start = formatReportDate(lease.lease_start);
  const end = formatReportDate(lease.lease_end);
  if (months && start !== '—' && end !== '—') {
    return t('leases.analysis_prose.term_full', { months, start, end });
  }
  if (months) return t('leases.analysis_prose.term_months_only', { months });
  if (start !== '—' && end !== '—') {
    return t('leases.analysis_prose.term_dates_only', { start, end });
  }
  return '';
}

function describeRent(lease: ReportLease): string {
  if (lease.monthly_rent == null) return '';
  const monthly = formatReportCurrency(lease.monthly_rent);
  const annual = formatReportCurrency(lease.monthly_rent * 12);
  return t('leases.analysis_prose.rent', { monthly, annual });
}

function describeEscalation(lease: ReportLease): string {
  if (!lease.escalation_type || lease.escalation_type === 'none') return '';
  if (lease.escalation_type === 'fixed_percent' && lease.escalation_rate != null) {
    return t('leases.analysis_prose.esc_fixed', { rate: lease.escalation_rate });
  }
  if (lease.escalation_type === 'index') {
    return t('leases.analysis_prose.esc_index');
  }
  if (lease.escalation_type === 'stepped') {
    return t('leases.analysis_prose.esc_stepped');
  }
  return t('leases.analysis_prose.esc_other', {
    type: lease.escalation_type.replace(/_/g, ' '),
  });
}

function describeCommitment(lease: ReportLease): string {
  const parts: string[] = [];
  if (lease.total_commitment != null) {
    parts.push(
      t('leases.analysis_prose.commitment_total', {
        amount: formatReportCurrency(lease.total_commitment),
      }),
    );
  }
  if (lease.pv_liability != null) {
    parts.push(
      t('leases.analysis_prose.commitment_pv', {
        amount: formatReportCurrency(lease.pv_liability),
      }),
    );
  }
  return parts.join(' ');
}

function buildFinancialSummary(lease: ReportLease): string {
  return sentences([
    describeTerm(lease),
    describeRent(lease),
    describeEscalation(lease),
    describeCommitment(lease),
  ]);
}

function describeRenewal(lease: ReportLease): string {
  const r = lease.renewal_options;
  if (!r) return t('leases.analysis_prose.renewal_none');
  return t('leases.analysis_prose.renewal', { text: r }).trim();
}

function describeTermination(lease: ReportLease): string {
  const term = lease.termination_clauses;
  if (!term) return t('leases.analysis_prose.termination_none');
  return t('leases.analysis_prose.termination', { text: term }).trim();
}

function describeDeposit(lease: ReportLease): string {
  if (!lease.security_deposit) return '';
  return t('leases.analysis_prose.deposit', { text: lease.security_deposit });
}

function buildKeyClausesSummary(lease: ReportLease): string {
  return sentences([
    describeRenewal(lease),
    describeTermination(lease),
    describeDeposit(lease),
  ]);
}

function buildRiskNarrative(lease: ReportLease): Array<{ title: string; narrative: string }> {
  // The risks table already carries an `explanation` column populated at
  // extraction time. Use that directly — no AI rephrasing needed.
  return lease.risks.map((risk) => ({
    title: risk.title,
    narrative:
      risk.explanation ||
      t('leases.analysis_prose.risk_severity', {
        severity: t(`leases.analysis_prose.severity_${risk.severity}`, {
          defaultValue: risk.severity,
        }),
      }),
  }));
}

function buildExecutiveNotes(lease: ReportLease): string {
  // Surface the single most decision-relevant fact for a finance reviewer.
  // Priority: highest-severity risk > index escalation flag > size of commitment.
  const highRisk = lease.risks.find((r) => r.severity === 'high');
  if (highRisk) {
    return `${t('leases.analysis_prose.exec_top_risk', { title: highRisk.title })} ${highRisk.explanation || ''}`.trim();
  }
  if (lease.escalation_type === 'index' || lease.needs_escalation_review) {
    return t('leases.analysis_prose.exec_index_escalation');
  }
  if (lease.total_commitment != null && lease.total_commitment > 0) {
    return t('leases.analysis_prose.exec_commitment', {
      amount: formatReportCurrency(lease.total_commitment),
    });
  }
  return t('leases.analysis_prose.exec_no_risks');
}

export function buildLeaseAnalysisProse(lease: ReportLease): ReportProse {
  return {
    financial_summary: buildFinancialSummary(lease) || undefined,
    key_clauses_summary: buildKeyClausesSummary(lease) || undefined,
    risk_narrative: buildRiskNarrative(lease),
    executive_notes: buildExecutiveNotes(lease),
  };
}
