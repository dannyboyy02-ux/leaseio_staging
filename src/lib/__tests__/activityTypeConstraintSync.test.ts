import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// KNOWN_ISSUES #76 regression guard.
//
// The 2026-05-08 constraint re-snapshot renamed activity-type values without
// renaming the deployed writers; their audit inserts were then silently
// rejected for a month. This test makes that class of drift impossible to
// reintroduce quietly: every activity_type a writer can emit must be present
// in the latest constraint migration.
//
// Honest limits: literals are collected via three writer-shaped regexes
// (inline `activity_type:`, switch-assigned `activityType =`, and
// helper-funneled `logActivity(..., 'x'`). A writer using a novel dynamic
// pattern would evade the sweep — if you add one, extend the regex list.

const ROOT = join(__dirname, '../../..');

function latestConstraintMigration(): { file: string; values: Set<string> } {
  const dir = join(ROOT, 'supabase/migrations');
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      readFileSync(join(dir, f), 'utf8').includes('lease_activity_log_activity_type_check'),
    )
    .sort();
  expect(candidates.length, 'no migration defines the activity_type CHECK').toBeGreaterThan(0);
  const file = candidates[candidates.length - 1];
  const sql = readFileSync(join(dir, file), 'utf8');
  // Narrow to the ADD CONSTRAINT block before extracting quoted values, so
  // commentary can't satisfy the assertion (full-file matching is the
  // false-positive trap the test conventions warn about).
  const block = sql.slice(sql.indexOf('ADD CONSTRAINT'));
  const values = new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  return { file, values };
}

function collectWriterValues(): Map<string, string[]> {
  const found = new Map<string, string[]>(); // value -> files
  const patterns = [
    /activity_type:\s*['"]([a-z_]+)['"]/g,
    /activityType\s*=\s*['"]([a-z_]+)['"]/g,
    /logActivity\(\s*[^,\n]*,\s*['"]([a-z_]+)['"]/g,
  ];
  const roots = [join(ROOT, 'supabase/functions'), join(ROOT, 'src')];
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
    }
    return out;
  };
  for (const root of roots) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      for (const re of patterns) {
        for (const m of src.matchAll(re)) {
          const prev = found.get(m[1]) ?? [];
          prev.push(file.slice(ROOT.length + 1));
          found.set(m[1], prev);
        }
      }
    }
  }
  return found;
}

describe('activity_type writers stay in sync with the CHECK constraint (#76)', () => {
  const { file, values } = latestConstraintMigration();
  const writers = collectWriterValues();

  it('every writer-emitted activity_type is accepted by the latest constraint migration', () => {
    const orphans = [...writers.keys()].filter((v) => !values.has(v));
    expect(
      orphans,
      `activity types written but ABSENT from ${file} (their audit rows will be ` +
        `silently rejected): ${orphans
          .map((v) => `${v} (${writers.get(v)![0]})`)
          .join(', ')}`,
    ).toEqual([]);
  });

  it('pins the twelve #76-restored writer values in the constraint', () => {
    for (const v of [
      'counter_signature_overdue',
      'counter_signature_received',
      'deactivated_approver_reassigned',
      'delegate_activated',
      'document_iteration_uploaded',
      'negotiation_escalated_to_concept',
      'ooo_revoked',
      'ooo_routed_step',
      'policy_assignee_validation_failed',
      'voluntary_delegation_created',
      'final_review_returned_to_negotiation',
      'unlock_rejected',
    ]) {
      expect(values, `restored value ${v} missing from ${file}`).toContain(v);
    }
  });

  it('sanity: the sweep actually finds writers (regexes not silently broken)', () => {
    expect(writers.size).toBeGreaterThan(20);
    expect(writers.has('status_change')).toBe(true);
    expect(writers.has('document_deleted')).toBe(true);
  });
});
