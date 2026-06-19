// Export helpers for lease data.
//
// The wrapping LeaseExports component was retired 2026-06-03 when the
// LeaseReview action bar collapsed to a single state-aware primary +
// More menu. The JSON export item was further removed 2026-06-04 — the
// SMB finance audience consumes CSV via spreadsheet workflows; JSON
// payloads were never the deliverable. This file is now CSV-only.

import type { RentScheduleEntry } from './RentScheduleTable';
import { escapeCsvCell } from '@/lib/csv';

interface ExportLease {
  id: string;
  filename: string;
  extracted_json: Record<string, any> | null;
  landlord_name: string | null;
  tenant_name: string | null;
  property_address?: string | null;
  lease_start: string | null;
  lease_end: string | null;
  base_rent_amount: string | null;
  current_monthly_rent: number | null;
  status: string;
  lifecycle_status: string | null;
}

const getExtractedValue = (field: any): string | null => {
  if (!field) return null;
  if (typeof field === 'string') return field;
  if (typeof field === 'number') return String(field);
  if (typeof field === 'object' && 'value' in field) {
    return field.value != null ? String(field.value) : null;
  }
  return null;
};

const buildExportData = (
  lease: ExportLease,
  formValues: Record<string, string>,
  rentSchedule: RentScheduleEntry[],
) => {
  const extracted = lease.extracted_json || {};

  const fields = {
    id: lease.id,
    filename: lease.filename,
    status: lease.status,
    lifecycle_status: lease.lifecycle_status,
    landlord_name: formValues.landlord_name || lease.landlord_name || getExtractedValue(extracted.landlord_name),
    tenant_name: formValues.tenant_name || lease.tenant_name || getExtractedValue(extracted.tenant_name),
    property_address: formValues.property_address || getExtractedValue(extracted.property_address),
    square_footage: formValues.square_footage || getExtractedValue(extracted.square_footage),
    lease_start: formValues.lease_start || lease.lease_start || getExtractedValue(extracted.lease_start),
    lease_end: formValues.lease_end || lease.lease_end || getExtractedValue(extracted.lease_end),
    rent_commencement_date: formValues.rent_commencement_date || getExtractedValue(extracted.rent_commencement_date),
    current_monthly_rent: formValues.current_monthly_rent || lease.current_monthly_rent || getExtractedValue(extracted.current_monthly_rent),
    base_rent_amount: formValues.base_rent_amount || lease.base_rent_amount || getExtractedValue(extracted.base_rent_amount),
    base_rent_frequency: formValues.base_rent_frequency || getExtractedValue(extracted.base_rent_frequency),
    security_deposit: formValues.security_deposit || getExtractedValue(extracted.security_deposit),
    rent_escalation_type: formValues.rent_escalation_type || getExtractedValue(extracted.rent_escalation_type),
    renewal_options: formValues.renewal_options || getExtractedValue(extracted.renewal_options),
    termination_clauses: formValues.termination_clauses || getExtractedValue(extracted.termination_clauses),
    escalation_clauses: formValues.escalation_clauses || getExtractedValue(extracted.escalation_clauses),
  };

  return {
    lease: fields,
    rent_schedule: rentSchedule.map((entry) => ({
      period_start: entry.period_start,
      period_end: entry.period_end,
      monthly_amount: entry.monthly_amount,
      annual_amount: entry.annual_amount,
      notes: entry.notes,
    })),
    extracted_json_raw: extracted,
    export_date: new Date().toISOString(),
  };
};

export const downloadCSV = (
  lease: ExportLease,
  formValues: Record<string, string>,
  rentSchedule: RentScheduleEntry[],
) => {
  const data = buildExportData(lease, formValues, rentSchedule);
  const leaseFields = data.lease;

  const leaseHeaders = Object.keys(leaseFields);
  const leaseValues = Object.values(leaseFields).map(escapeCsvCell);

  let csvContent = '### LEASE DATA ###\n';
  csvContent += leaseHeaders.join(',') + '\n';
  csvContent += leaseValues.join(',') + '\n\n';

  if (data.rent_schedule.length > 0) {
    csvContent += '### RENT SCHEDULE ###\n';
    const scheduleHeaders = ['period_start', 'period_end', 'monthly_amount', 'annual_amount', 'notes'];
    csvContent += scheduleHeaders.join(',') + '\n';

    data.rent_schedule.forEach((entry) => {
      const row = scheduleHeaders.map((header) =>
        escapeCsvCell(entry[header as keyof typeof entry]),
      );
      csvContent += row.join(',') + '\n';
    });
  }

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `lease-${lease.id.slice(0, 8)}-export.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
