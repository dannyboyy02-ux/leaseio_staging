// Pure SECTION_CONFIG + findFieldLabel. Extracted from
// LeaseReviewSections.tsx (P2-04 monolith decomposition).
//
// The component file pulls in the supabase client at import time
// (transitively via shadcn components → react-query → etc.), and the
// supabase client touches `localStorage` at module init. That makes
// any test importing from the .tsx file blow up in the node-environment
// vitest run. Hosting SECTION_CONFIG + findFieldLabel here keeps the
// data and lookup pure and testable; LeaseReviewSections.tsx re-exports
// for backwards compatibility with existing imports.
//
// Icons are React components but they're pure JS modules; importing
// them in a node test environment is safe (they don't run any
// browser-only code at import time).

import {
  Building2,
  Calendar,
  DollarSign,
  FileText,
  MapPin,
  RefreshCw,
  ScrollText,
  Users,
} from 'lucide-react';

export const SECTION_CONFIG = {
  parties: {
    title: 'Parties',
    icon: Users,
    fields: [
      { id: 'landlord_name', label: 'Landlord', icon: Building2 },
      { id: 'tenant_name', label: 'Tenant', icon: Building2 },
    ],
  },
  vendor: {
    title: 'Vendor / Counterparty',
    icon: Building2,
    fields: [
      { id: 'vendor_name', label: 'Vendor / Counterparty', icon: Building2 },
      { id: 'vendor_address_line1', label: 'Address Line 1', icon: MapPin },
      { id: 'vendor_address_line2', label: 'Address Line 2', icon: MapPin },
      { id: 'vendor_city', label: 'City', icon: MapPin },
      { id: 'vendor_state', label: 'State', icon: MapPin },
      { id: 'vendor_zip', label: 'Zip Code', icon: MapPin },
      { id: 'vendor_phone', label: 'Phone', icon: Building2 },
    ],
  },
  property: {
    title: 'Property',
    icon: MapPin,
    fields: [
      { id: 'property_address', label: 'Property Address', icon: MapPin },
      { id: 'square_footage', label: 'Square Footage', icon: Building2, type: 'number' },
      { id: 'asset_type', label: 'Asset Type', icon: Building2 },
      { id: 'location', label: 'Location', icon: MapPin },
      { id: 'building', label: 'Building', icon: Building2 },
      { id: 'region', label: 'Region', icon: MapPin },
    ],
  },
  dates: {
    title: 'Dates & Term',
    icon: Calendar,
    fields: [
      { id: 'lease_start', label: 'Lease Start', icon: Calendar, type: 'date' },
      { id: 'lease_end', label: 'Lease End', icon: Calendar, type: 'date' },
      { id: 'rent_commencement_date', label: 'Rent Commencement', icon: Calendar, type: 'date' },
      { id: 'term_months', label: 'Lease Term', icon: Calendar, type: 'term' },
    ],
  },
  rent: {
    title: 'Rent',
    icon: DollarSign,
    fields: [
      { id: 'current_monthly_rent', label: 'Current Monthly Rent', icon: DollarSign, type: 'number' },
      { id: 'base_rent_amount', label: 'Base Rent Amount', icon: DollarSign, type: 'number' },
      { id: 'base_rent_frequency', label: 'Rent Frequency', icon: RefreshCw },
      { id: 'security_deposit', label: 'Security Deposit', icon: DollarSign, type: 'number' },
      { id: 'rent_escalation_type', label: 'Escalation Type', icon: RefreshCw },
    ],
  },
  options: {
    title: 'Options & Clauses',
    icon: ScrollText,
    fields: [
      { id: 'renewal_options', label: 'Renewal Options', icon: RefreshCw, type: 'textarea' },
      { id: 'termination_clauses', label: 'Termination Clauses', icon: FileText, type: 'textarea' },
      { id: 'escalation_clauses', label: 'Escalation Clauses', icon: RefreshCw, type: 'textarea' },
    ],
  },
} as const;

export type SectionKey = keyof typeof SECTION_CONFIG;

/**
 * Look up the display label for a SECTION_CONFIG field by id. Returns
 * the id itself as a fallback so callers (e.g. audit-log entry writers
 * in LeaseReview) always have a non-empty string to display.
 *
 * The `as const` declaration makes each section's `fields` a different
 * readonly tuple type, so `Object.values(SECTION_CONFIG).flatMap(...)`
 * widens to `unknown[]` for TS — the lookup cast was being duplicated
 * at every call site. Centralized here so callers don't need the cast.
 */
export function findFieldLabel(fieldId: string): string {
  for (const section of Object.values(SECTION_CONFIG)) {
    for (const field of section.fields as readonly { id: string; label: string }[]) {
      if (field.id === fieldId) return field.label;
    }
  }
  return fieldId;
}
