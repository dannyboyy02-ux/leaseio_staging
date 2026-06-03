import { Download, FileJson, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { RentScheduleEntry } from './RentScheduleTable';

interface LeaseExportsProps {
  lease: {
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
  };
  formValues: Record<string, string>;
  rentSchedule: RentScheduleEntry[];
}

// Helper to get value from extracted field (handles both string and object formats)
const getExtractedValue = (field: any): string | null => {
  if (!field) return null;
  if (typeof field === 'string') return field;
  if (typeof field === 'number') return String(field);
  if (typeof field === 'object' && 'value' in field) {
    return field.value != null ? String(field.value) : null;
  }
  return null;
};

// Build flat export data from lease and form values
const buildExportData = (
  lease: LeaseExportsProps['lease'],
  formValues: Record<string, string>,
  rentSchedule: RentScheduleEntry[]
) => {
  const extracted = lease.extracted_json || {};
  
  // Merge extracted values with user-edited form values (form values take precedence)
  const fields = {
    id: lease.id,
    filename: lease.filename,
    status: lease.status,
    lifecycle_status: lease.lifecycle_status,
    // Core fields - prefer form values, fallback to extracted
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
    rent_schedule: rentSchedule.map(entry => ({
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

// Download JSON file
export const downloadJSON = (
  lease: LeaseExportsProps['lease'],
  formValues: Record<string, string>,
  rentSchedule: RentScheduleEntry[]
) => {
  const data = buildExportData(lease, formValues, rentSchedule);
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `lease-${lease.id.slice(0, 8)}-export.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Convert to CSV and download
export const downloadCSV = (
  lease: LeaseExportsProps['lease'],
  formValues: Record<string, string>,
  rentSchedule: RentScheduleEntry[]
) => {
  const data = buildExportData(lease, formValues, rentSchedule);
  const leaseFields = data.lease;
  
  // Lease data CSV
  const leaseHeaders = Object.keys(leaseFields);
  const leaseValues = Object.values(leaseFields).map(v => {
    if (v === null || v === undefined) return '';
    // Escape quotes and wrap in quotes if contains comma
    const str = String(v);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  });
  
  let csvContent = '### LEASE DATA ###\n';
  csvContent += leaseHeaders.join(',') + '\n';
  csvContent += leaseValues.join(',') + '\n\n';
  
  // Rent schedule CSV (if present)
  if (data.rent_schedule.length > 0) {
    csvContent += '### RENT SCHEDULE ###\n';
    const scheduleHeaders = ['period_start', 'period_end', 'monthly_amount', 'annual_amount', 'notes'];
    csvContent += scheduleHeaders.join(',') + '\n';
    
    data.rent_schedule.forEach(entry => {
      const row = scheduleHeaders.map(header => {
        const val = entry[header as keyof typeof entry];
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      });
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

export function LeaseExports({ lease, formValues, rentSchedule }: LeaseExportsProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download size={14} className="mr-1" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => downloadJSON(lease, formValues, rentSchedule)}>
          <FileJson size={14} className="mr-2" />
          Download JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadCSV(lease, formValues, rentSchedule)}>
          <FileSpreadsheet size={14} className="mr-2" />
          Download CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
