import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const readRepoFile = (path: string) => readFileSync(join(root, path), 'utf8');

describe('locked-lease informational layout', () => {
  it('LeaseReview dispatches to LockedLeaseDetail when model_locked && lifecycle_status === "active"', () => {
    const source = readRepoFile('src/pages/app/LeaseReview.tsx');

    expect(source).toContain('import { LockedLeaseDetail }');
    expect(source).toContain("lease?.model_locked === true && lease?.lifecycle_status === 'active'");
    expect(source).toContain('return <LockedLeaseDetail');
  });

  it('LockedLeaseDetail keeps Vendor as the only editable section when locked', () => {
    const orchestrator = readRepoFile('src/components/leases/locked/LockedLeaseDetail.tsx');
    const vendorCard = readRepoFile('src/components/leases/locked/VendorCard.tsx');

    // Orchestrator wires VendorCard with the lease's vendor_* fields
    expect(orchestrator).toContain('<VendorCard');
    expect(orchestrator).toContain('vendor_name: lease.vendor_name');
    expect(orchestrator).toContain('vendor_phone: lease.vendor_phone');

    // VendorCard writes directly to the leases table — no governance change-set path
    expect(vendorCard).toContain(".from('leases')");
    expect(vendorCard).toContain('.update({');
    expect(vendorCard).not.toContain('lease_change_sets');
  });

  it('vendor carve-out migration omits vendor_* from the locked-lease comparison', () => {
    const migration = readRepoFile(
      'supabase/migrations/_archive/20260429000004_locked_lease_vendor_carveout.sql'
    );

    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prevent_locked_lease_edits()');
    expect(migration).toContain("'vendor_name'");
    expect(migration).toContain("'vendor_phone'");
    expect(migration).toContain("'vendor_address_line1'");
    expect(migration).toContain("'vendor_address_line2'");
    expect(migration).toContain("'vendor_city'");
    expect(migration).toContain("'vendor_state'");
    expect(migration).toContain("'vendor_zip'");
    expect(migration).toContain('ignored_keys');
    expect(migration).toContain('to_jsonb(OLD) - ignored_keys');
    expect(migration).toContain('to_jsonb(NEW) - ignored_keys');
  });

  it('LabelValueGrid renders dash-em for null/undefined/empty values', () => {
    const source = readRepoFile('src/components/leases/locked/LabelValueGrid.tsx');
    // Confirm the empty glyph constant is the em-dash, not a hyphen
    expect(source).toContain("const EMPTY_GLYPH = '—'");
    expect(source).toContain('isEmpty');
    expect(source).toContain('emptyHint');
  });

  it('LockedHeader exposes Request Unlock for non-admins and Admin Unlock for admins', () => {
    const source = readRepoFile('src/components/leases/locked/LockedHeader.tsx');

    // Non-admin path
    expect(source).toContain('!isAdmin && !pendingUnlockRequest');
    expect(source).toContain('onRequestUnlock');
    // Admin path
    expect(source).toContain('isAdmin &&');
    expect(source).toContain('onAdminUnlock');
    expect(source).toContain('onDenyUnlock');
  });

});
