import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #111 C6 — per-policy approval SLA (C6a badge + C6b policy editor).
// Static guards complementing the behavioral slaStatus.test.ts. The editor
// threading is the "field silently dropped on save/load" failure class, so we
// pin all of its sites.

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#111 C6 migration — approval_policies.sla_days', () => {
  const dir = join(root, 'supabase/migrations');
  const file = readdirSync(dir).filter((f) => f.includes('approval_policy_sla_days')).sort().pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');
  it('adds the nullable column with a positive CHECK (idempotent)', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sla_days integer');
    expect(sql).toMatch(/CHECK \(sla_days IS NULL OR sla_days > 0\)/);
    expect(sql).toContain('duplicate_object');
  });
});

describe('#111 C6a — ChainStepBadges + ApprovalQueue drive off the policy SLA', () => {
  it('ChainStepBadges uses pendingSlaStatus + a slaDays prop (not a hardcoded 7)', () => {
    const src = fn('src/components/leases/ChainStepBadges.tsx');
    expect(src).toContain("import { pendingSlaStatus } from '@/lib/slaStatus'");
    expect(src).toContain('slaDays?: number | null');
    expect(src).toContain('pendingSlaStatus(pendingSince, slaDays)');
    expect(src).toContain('· over SLA');
    // The old hardcoded threshold must be gone from the badge color logic.
    expect(src).not.toMatch(/days >= 7 \? 'text-destructive'/);
  });

  it('ApprovalQueue fetches each policy sla_days and passes it to the badge', () => {
    const src = fn('src/pages/app/ApprovalQueue.tsx');
    expect(src).toContain("from('approval_policies').select('id, sla_days')");
    expect(src).toContain('slaDays={step.slaDays ?? null}');
    expect(src).toMatch(/slaDays\?: number \| null/);
  });
});

describe('#111 C6b — ApprovalPolicyEditPage threads sla_days through all sites', () => {
  const src = fn('src/pages/settings/ApprovalPolicyEditPage.tsx');
  it('declares sla_days on the form type + emptyForm', () => {
    expect(src).toMatch(/sla_days:\s*string;/);
    expect(src).toMatch(/sla_days:\s*'',/);
  });
  it('loads it from the policy row', () => {
    expect(src).toContain("sla_days: (p as any).sla_days == null ? '' : String((p as any).sla_days)");
  });
  it('saves it (blank → null, else parseInt)', () => {
    expect(src).toContain("sla_days: form.sla_days.trim() === '' ? null : parseInt(form.sla_days, 10)");
  });
  it('validates a positive integer before save', () => {
    expect(src).toContain('Number.isInteger(slaNum)');
    expect(src).toMatch(/slaNum <= 0/);
  });
  it('renders an input bound to form.sla_days', () => {
    expect(src).toContain('value={form.sla_days}');
    expect(src).toContain('Approval SLA (days)');
  });
});
