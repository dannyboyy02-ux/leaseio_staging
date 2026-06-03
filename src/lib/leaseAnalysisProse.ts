// Deterministic prose generator for the Lease Analysis Report.
//
// Replaces a Claude Sonnet call that was just rephrasing structured
// data — no judgement, no portfolio context, just formatting. A template
// gives the same output, faster, free, deterministic, and available to
// all tiers.

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
    return `The lease has a ${months}-month term commencing ${start} and expiring ${end}.`;
  }
  if (months) return `The lease has a ${months}-month term.`;
  if (start !== '—' && end !== '—') return `The lease runs from ${start} through ${end}.`;
  return '';
}

function describeRent(lease: ReportLease): string {
  if (lease.monthly_rent == null) return '';
  const monthly = formatReportCurrency(lease.monthly_rent);
  const annual = formatReportCurrency(lease.monthly_rent * 12);
  return `Monthly rent is ${monthly} (${annual} annualized).`;
}

function describeEscalation(lease: ReportLease): string {
  if (!lease.escalation_type || lease.escalation_type === 'none') return '';
  if (lease.escalation_type === 'fixed_percent' && lease.escalation_rate != null) {
    return `Rent escalates at ${lease.escalation_rate}% annually.`;
  }
  if (lease.escalation_type === 'index') {
    return 'Rent escalates against an index (CPI or similar); future obligations carry inflation exposure.';
  }
  if (lease.escalation_type === 'stepped') {
    return 'Rent steps up on a scheduled basis defined in the rent schedule.';
  }
  return `Escalation: ${lease.escalation_type.replace(/_/g, ' ')}.`;
}

function describeCommitment(lease: ReportLease): string {
  const parts: string[] = [];
  if (lease.total_commitment != null) {
    parts.push(`Total cash commitment over the term is ${formatReportCurrency(lease.total_commitment)}.`);
  }
  if (lease.pv_liability != null) {
    parts.push(`Present value of the lease liability is ${formatReportCurrency(lease.pv_liability)}.`);
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
  if (!r) return 'No renewal options recorded.';
  return `Renewal: ${r}`.trim();
}

function describeTermination(lease: ReportLease): string {
  const t = lease.termination_clauses;
  if (!t) return 'No early-termination rights recorded — the tenant is bound for the full term unless the lease specifies otherwise.';
  return `Termination: ${t}`.trim();
}

function describeDeposit(lease: ReportLease): string {
  if (!lease.security_deposit) return '';
  return `Security deposit: ${lease.security_deposit}.`;
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
    narrative: risk.explanation || `Severity: ${risk.severity}.`,
  }));
}

function buildExecutiveNotes(lease: ReportLease): string {
  // Surface the single most decision-relevant fact for a finance reviewer.
  // Priority: highest-severity risk > index escalation flag > size of commitment.
  const highRisk = lease.risks.find((r) => r.severity === 'high');
  if (highRisk) {
    return `Most material risk: ${highRisk.title}. ${highRisk.explanation || ''}`.trim();
  }
  if (lease.escalation_type === 'index' || lease.needs_escalation_review) {
    return 'This lease carries index-based or unresolved escalation terms — future obligations should be reviewed each period before they apply.';
  }
  if (lease.total_commitment != null && lease.total_commitment > 0) {
    return `Total cash commitment of ${formatReportCurrency(lease.total_commitment)} over the term.`;
  }
  return 'No material risks flagged at extraction. Confirm the rent schedule and renewal posture before finalizing.';
}

export function buildLeaseAnalysisProse(lease: ReportLease): ReportProse {
  return {
    financial_summary: buildFinancialSummary(lease) || undefined,
    key_clauses_summary: buildKeyClausesSummary(lease) || undefined,
    risk_narrative: buildRiskNarrative(lease),
    executive_notes: buildExecutiveNotes(lease),
  };
}
