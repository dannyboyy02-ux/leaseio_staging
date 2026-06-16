import { lstatSync, readFileSync, readdirSync } from 'node:fs';
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
// Hardened 2026-06-12 after its own review (auditor + integrity): regexes
// are digit-inclusive ([a-z0-9_], tier2_*/asc842_* were invisible before),
// ternary writers and the ACTION_TO_ACTIVITY map-funnel are swept, the
// funneled values are ALSO pinned explicitly, and each extraction pattern
// has its own sanity probe so a single regex can't regress unnoticed.
//
// Honest limits: a writer using a novel dynamic pattern (computed key,
// imported constant) would still evade the sweep — if you add one, extend
// the pattern list AND the pinned set.

const ROOT = join(__dirname, '../../..');
const TOKEN = /['"]([a-z0-9_]+)['"]/g;

// Harvest the allowed values from the latest migration defining a given
// activity_type CHECK constraint. Bounds the slice to the ADD CONSTRAINT
// statement so unrelated trailing SQL can't count as allowed values.
function constraintValues(constraintName: string): { file: string; values: Set<string> } | null {
  const dir = join(ROOT, 'supabase/migrations');
  const marker = `ADD CONSTRAINT ${constraintName}`;
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(dir, f), 'utf8').includes(marker))
    .sort();
  if (candidates.length === 0) return null;
  const file = candidates[candidates.length - 1];
  const sql = readFileSync(join(dir, file), 'utf8');
  const start = sql.indexOf(marker);
  const end = sql.indexOf('));', start);
  expect(end, `${file}: ${constraintName} statement is unterminated`).toBeGreaterThan(start);
  const block = sql.slice(start, end);
  return { file, values: new Set([...block.matchAll(TOKEN)].map((m) => m[1])) };
}

function latestConstraintMigration(): { file: string; values: Set<string> } {
  // Firm edge functions (Phase 10) write firm-only events to firm_activity_log,
  // which has its OWN activity_type CHECK; lease/workflow writers target
  // lease_activity_log. A writer's value is valid if its TARGET table's
  // constraint accepts it, so the guard checks against the UNION of both
  // constraints' allowed values.
  const lease = constraintValues('lease_activity_log_activity_type_check');
  expect(lease, 'no migration defines the lease_activity_log activity_type CHECK').not.toBeNull();
  const firm = constraintValues('firm_activity_log_activity_type_check');
  const values = new Set<string>([...lease!.values, ...(firm?.values ?? [])]);
  return { file: `${lease!.file}${firm ? ` + ${firm.file}` : ''}`, values };
}

type Sweep = { byPattern: Map<string, Set<string>>; all: Map<string, string[]> };

function collectWriterValues(): Sweep {
  // Each pattern captures a SPAN that may contain one or more quoted values
  // (ternaries put two literals on one expression).
  const patterns: Array<{ name: string; re: RegExp }> = [
    { name: 'inline', re: /activity_type:\s*([^,\n]+)/g },
    { name: 'assignment', re: /activityType\s*=\s*([^;\n]+)/g },
    { name: 'helper', re: /logActivity\(\s*[^,\n]*,\s*(['"][a-z0-9_]+['"])/g },
    { name: 'action_map', re: /ACTION_TO_ACTIVITY[^}]*\}/g },
  ];
  const byPattern = new Map<string, Set<string>>(patterns.map((p) => [p.name, new Set()]));
  const all = new Map<string, string[]>(); // value -> files

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
      const p = join(dir, entry);
      const st = lstatSync(p); // lstat: never follow symlinks (cycle/escape safety)
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
    }
    return out;
  };

  for (const root of [join(ROOT, 'supabase/functions'), join(ROOT, 'src')]) {
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8');
      for (const { name, re } of patterns) {
        for (const m of src.matchAll(re)) {
          // Strip comparison clauses (`action === 'approve' ?`) before
          // harvesting tokens — ternary CONDITIONS name actions, not
          // activity types, and counting them would false-fail the guard.
          const span = (m[1] ?? m[0]).replace(/[!=]==?\s*['"][a-z0-9_]+['"]/g, '');
          for (const tok of span.matchAll(TOKEN)) {
            byPattern.get(name)!.add(tok[1]);
            const prev = all.get(tok[1]) ?? [];
            prev.push(file.slice(ROOT.length + 1));
            all.set(tok[1], prev);
          }
        }
      }
    }
  }
  return { byPattern, all };
}

describe('activity_type writers stay in sync with the CHECK constraint (#76)', () => {
  const { file, values } = latestConstraintMigration();
  const { byPattern, all: writers } = collectWriterValues();

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

  it('pins the funneled/conditional writer values the sweep is most likely to lose', () => {
    // Sole emission paths via map-funnel, ternary, or multi-line conditional
    // assignment — pinned regardless of sweep coverage so a constraint
    // re-snapshot can never drop them while the guard stays green.
    for (const v of [
      'chain_step_approved', // act-on-chain-step ACTION_TO_ACTIVITY
      'chain_step_rejected',
      'chain_step_sent_back',
      'manual_reroute_approved', // admin-trigger-manual-reroute ternary
      'manual_reroute_rejected',
      'approval', // useLifecycleWorkflow conditional assignment
      'rejection',
      'send_back',
      'pause',
      'status_change',
      'tier2_classification_passed', // digit-bearing (pre-hardening blind spot)
      'tier2_classification_rejected',
      'tier2_classification_overridden',
      'tier2_correction_recorded',
      'asc842_inputs_updated',
    ]) {
      expect(values, `funneled writer value ${v} missing from ${file}`).toContain(v);
    }
  });

  it('sanity: each extraction pattern individually finds a known value', () => {
    // One probe per pattern so a single regex regressing cannot hide behind
    // the others still clearing an aggregate threshold.
    expect(byPattern.get('inline'), 'inline pattern broke').toContain('document_deleted');
    expect(byPattern.get('inline'), 'inline ternary handling broke').toContain(
      'manual_reroute_approved',
    );
    expect(byPattern.get('assignment'), 'assignment pattern broke').toContain(
      'final_review_returned_to_negotiation',
    );
    expect(byPattern.get('helper'), 'helper pattern broke').toContain('unlock_rejected');
    expect(byPattern.get('action_map'), 'ACTION_TO_ACTIVITY pattern broke').toContain(
      'chain_step_approved',
    );
    expect(writers.size).toBeGreaterThan(20);
  });

  it('sanity: digit-bearing types are visible to the sweep (the pre-hardening blind spot)', () => {
    expect(writers.has('tier2_classification_passed')).toBe(true);
    expect(writers.has('asc842_inputs_updated')).toBe(true);
  });
});
