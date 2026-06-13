import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// KNOWN_ISSUES #90 regression guard.
//
// Migration 20260613050000_activity_log_client_allowlist.sql recreates the
// permissive "Users can create activity entries" INSERT policy on
// lease_activity_log, AND-ing an allowlist of the activity_types a browser
// client is permitted to insert. Every other type (chain_step_*, the
// dashboard-alert types, report_*, tier2_*, OOO/delegate, etc.) is written
// EXCLUSIVELY by edge functions (service_role, RLS-bypassing).
//
// The breakage risk this guards: if a NEW client-side lease_activity_log
// writer emits a type that is NOT in the allowlist, its legitimate audit
// INSERT is silently rejected by RLS (42501) — a broken audit chain. This
// test fails the moment a client writer's literal falls outside the migration
// allowlist, OR the allowlist loses one of the 19 expected client types, OR
// it accidentally admits a sensitive service-role-only type.
//
// Honest limit (shared with the #76 sweep): a writer using a novel dynamic
// pattern (computed key, imported constant) evades the literal sweep. The
// one such site today — useLifecycleWorkflow's `activity_type: activityType`
// ternary — is pinned explicitly below.

const ROOT = join(__dirname, '../../..');
const TOKEN = /['"]([a-z0-9_]+)['"]/g;

// The 19 activity_types a client is expected to emit (mirrors the migration).
const EXPECTED_CLIENT_TYPES = [
  'created',
  'status_change',
  'approval',
  'rejection',
  'send_back',
  'pause',
  'comment',
  'nudge_sent',
  'document_upload',
  'document_deleted',
  'risk_added',
  'risk_dismissed',
  'asc842_inputs_updated',
  'discount_rate_set',
  'discount_rate_cleared',
  'amendment_archived',
  'lease_archived',
  'lease_restored',
  'chain_violation_resolved',
] as const;

// A sample of types written ONLY by edge functions — they MUST NOT be
// client-insertable. The #78 addendum specifically called out the first two
// (forgeable system alerts that can induce admin action).
const SERVICE_ROLE_ONLY_SAMPLE = [
  'policy_assignee_validation_failed',
  'stuck_chain_detected',
  'chain_step_approved',
  'report_generation_requested',
  'executed_uploaded',
  'tier2_classification_passed',
] as const;

function allowlistMigration(): { file: string; values: Set<string> } {
  const dir = join(ROOT, 'supabase/migrations');
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      readFileSync(join(dir, f), 'utf8').includes(
        'CREATE POLICY "Users can create activity entries"',
      ),
    )
    .filter((f) =>
      readFileSync(join(dir, f), 'utf8').includes('activity_type = ANY (ARRAY['),
    )
    .sort();
  expect(
    candidates.length,
    'no migration defines the client activity-type allowlist (#90)',
  ).toBeGreaterThan(0);
  const file = candidates[candidates.length - 1];
  const sql = readFileSync(join(dir, file), 'utf8');
  // Bound the slice to the ARRAY[...] literal itself — harvesting wider would
  // let the predicate's other quoted tokens / comments leak into the set.
  const start = sql.indexOf('activity_type = ANY (ARRAY[');
  expect(start, `${file}: allowlist ARRAY not found`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(']::text[]', start);
  expect(end, `${file}: allowlist ARRAY is unterminated`).toBeGreaterThan(start);
  const block = sql.slice(start, end);
  const values = new Set([...block.matchAll(TOKEN)].map((m) => m[1]));
  return { file, values };
}

// Sweep src/ for activity_type literals at sites that also insert into
// lease_activity_log — the real completeness guard. We restrict to files that
// reference `lease_activity_log').insert` so reads/labels (AuditLog,
// RecentActivity, types.ts) don't pollute the set.
function collectClientInsertedTypes(): Map<string, string[]> {
  const out = new Map<string, string[]>(); // value -> files
  const walk = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue;
      const p = join(dir, entry);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) files.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(entry)) files.push(p);
    }
    return files;
  };

  for (const file of walk(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8');
    // Gate on files that both name the table and perform an insert; the
    // harvest regex below only matches `activity_type:` object-property
    // literals, so read sites (.eq/.in filters, type decls) never contribute.
    if (!src.includes('lease_activity_log') || !src.includes('.insert(')) continue;
    for (const m of src.matchAll(/activity_type:\s*([^,\n]+)/g)) {
      // Strip ternary CONDITIONS (`action === 'approve' ? ...`) so the
      // compared action literals aren't mistaken for emitted types.
      const span = m[1].replace(/[!=]==?\s*['"][a-z0-9_]+['"]/g, '');
      for (const tok of span.matchAll(TOKEN)) {
        const prev = out.get(tok[1]) ?? [];
        prev.push(file.slice(ROOT.length + 1));
        out.set(tok[1], prev);
      }
    }
  }
  return out;
}

describe('lease_activity_log client INSERT allowlist (#90)', () => {
  const { file, values } = allowlistMigration();

  it('contains every one of the 19 expected client-emitted types', () => {
    const missing = EXPECTED_CLIENT_TYPES.filter((t) => !values.has(t));
    expect(missing, `allowlist in ${file} is missing expected client types`).toEqual([]);
    expect(values.size, `${file}: allowlist should be exactly 19 types`).toBe(
      EXPECTED_CLIENT_TYPES.length,
    );
  });

  it('EXCLUDES sensitive service-role-only types', () => {
    const leaked = SERVICE_ROLE_ONLY_SAMPLE.filter((t) => values.has(t));
    expect(
      leaked,
      `${file}: service-role-only types must NOT be client-insertable`,
    ).toEqual([]);
  });

  it('every client-side activity_type literal is in the allowlist (completeness guard)', () => {
    const swept = collectClientInsertedTypes();
    const orphans = [...swept.keys()].filter((v) => !values.has(v));
    expect(
      orphans,
      `client writers emit activity_types ABSENT from ${file} — their audit ` +
        `rows would be RLS-rejected (42501): ${orphans
          .map((v) => `${v} (${swept.get(v)![0]})`)
          .join(', ')}`,
    ).toEqual([]);
  });

  it('sanity: the sweep actually found the known client writers', () => {
    const swept = collectClientInsertedTypes();
    // Probes across the static-literal sites and the structurally-tricky ones.
    expect(swept.has('lease_archived'), 'sweep lost Leases/ArchiveButton').toBe(true);
    expect(swept.has('chain_violation_resolved'), 'sweep lost ChainViolationBanner').toBe(true);
    expect(swept.has('discount_rate_set'), 'sweep lost LeaseDiscountRateCard').toBe(true);
    expect(swept.has('asc842_inputs_updated'), 'sweep lost Asc842InputsTab').toBe(true);
    expect(swept.size).toBeGreaterThan(10);
  });

  it('pins the dynamic ternary writer (useLifecycleWorkflow activity_type: activityType)', () => {
    // This site emits `activity_type: activityType` where activityType resolves
    // to one of approval | rejection | send_back | pause. The literal sweep
    // cannot see those through the variable, so pin them — and confirm the
    // ternary still lives in the file (if it moves, this guard must follow).
    const file2 = join(ROOT, 'src/hooks/useLifecycleWorkflow.ts');
    const src = readFileSync(file2, 'utf8');
    expect(src).toContain('activity_type: activityType');
    for (const v of ['approval', 'rejection', 'send_back', 'pause'] as const) {
      expect(src, `ternary value ${v} no longer assigned in useLifecycleWorkflow`).toContain(
        `'${v}'`,
      );
      expect(values, `ternary value ${v} missing from allowlist`).toContain(v);
    }
  });
});
