import { describe, it, expect } from 'vitest';
import { findFieldLabel } from '@/lib/leaseReviewSectionConfig';

describe('findFieldLabel', () => {
  it('returns the configured label for a known field id', () => {
    expect(findFieldLabel('landlord_name')).toBe('Landlord');
    expect(findFieldLabel('tenant_name')).toBe('Tenant');
    expect(findFieldLabel('vendor_name')).toBe('Vendor / Counterparty');
    expect(findFieldLabel('property_address')).toBe('Property Address');
    expect(findFieldLabel('lease_start')).toBe('Lease Start');
    expect(findFieldLabel('current_monthly_rent')).toBe('Current Monthly Rent');
    expect(findFieldLabel('renewal_options')).toBe('Renewal Options');
  });

  it('finds fields across every section, not just the first', () => {
    // parties (first section)
    expect(findFieldLabel('landlord_name')).toBe('Landlord');
    // options (last section) — confirms iteration doesn't short-circuit
    expect(findFieldLabel('escalation_clauses')).toBe('Escalation Clauses');
  });

  it('falls back to the field id when not found', () => {
    expect(findFieldLabel('not_a_real_field')).toBe('not_a_real_field');
    expect(findFieldLabel('')).toBe('');
  });

  it('is case-sensitive (matches the data exactly)', () => {
    expect(findFieldLabel('Landlord_Name')).toBe('Landlord_Name');
    expect(findFieldLabel('LANDLORD_NAME')).toBe('LANDLORD_NAME');
  });
});
