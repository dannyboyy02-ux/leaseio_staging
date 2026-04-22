export interface ReportLease {
  display_name: string;
  asset_type: string | null;
  landlord: string | null;
  tenant: string | null;
  property_address: string | null;
  lease_start: string | null;
  lease_end: string | null;
  term_months: number | null;
  monthly_rent: number | null;
  escalation_type: string | null;
  escalation_rate: number | null;
  needs_escalation_review: boolean | null;
  renewal_options: string | null;
  termination_clauses: string | null;
  escalation_clauses: string | null;
  security_deposit: string | null;
  square_footage: number | null;
  total_commitment: number | null;
  pv_liability: number | null;
  rent_schedule: { period_start: string | null; period_end: string | null; monthly_amount: number | null; annual_amount: number | null; notes: string | null }[];
  risks: { title: string; severity: 'low' | 'medium' | 'high'; explanation: string; citation_snippet?: string; citation_page?: number }[];
}

export interface ReportProse {
  financial_summary?: string;
  key_clauses_summary?: string;
  risk_narrative?: { title: string; narrative: string }[];
  executive_notes?: string;
}

export function formatReportCurrency(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatReportDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export function severityColor(severity: string): string {
  if (severity === 'high') return '#dc2626';
  if (severity === 'medium') return '#d97706';
  return '#2563eb';
}
