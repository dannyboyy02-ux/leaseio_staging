import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// #178 — the dashboard Escalation Review panel used to show an unconditional
// "Edit Escalation" button; for a model-locked lease the save deterministically
// failed against the governance trigger and the user hit a dead-end toast.
// The panel now selects model_locked and, for locked leases, replaces Edit
// with a "View Lease" button routing to the lease workbench (/app/leases/:id),
// where the unlock-request governance flow lives. The /lock/i catch-mapping
// stays as the backstop for the stale-data race (locked after the query ran).

describe('EscalationReviewPanel — locked leases route to the workbench', () => {
  const src = read('src/components/dashboard/EscalationReviewPanel.tsx');

  it('selects model_locked in the panel query', () => {
    expect(src).toMatch(/select\(\s*'[^']*\bmodel_locked\b[^']*'/);
  });

  it('gates the row action on lease.model_locked with the locked branch navigating to the lease', () => {
    expect(src).toMatch(
      /lease\.model_locked[\s\S]{0,400}navigate\(`\/app\/leases\/\$\{lease\.id\}`\)/
    );
  });

  it("labels the locked branch with t('notifications.view_lease')", () => {
    expect(src).toContain("t('notifications.view_lease')");
  });

  it('keeps the /lock/i save-error backstop for the stale-data race', () => {
    expect(src).toContain('/lock/i.test(msg)');
    expect(src).toContain("t('dashboard.escalation_save_locked')");
  });

  it('keeps the unlocked Edit Escalation branch', () => {
    expect(src).toContain("t('dashboard.edit_escalation')");
    expect(src).toContain('openEdit(lease)');
  });
});

describe('reused notifications.view_lease key exists non-empty in both locales', () => {
  for (const localePath of ['src/locales/en/common.json', 'src/locales/es/common.json']) {
    it(localePath, () => {
      const json = JSON.parse(read(localePath));
      const value = json?.notifications?.view_lease;
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    });
  }
});
