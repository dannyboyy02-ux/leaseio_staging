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
  'escalation_review_resolved',
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

  it('contains every one of the 20 expected client-emitted types', () => {
    const missing = EXPECTED_CLIENT_TYPES.filter((t) => !values.has(t));
    expect(missing, `allowlist in ${file} is missing expected client types`).toEqual([]);
    expect(values.size, `${file}: allowlist should be exactly 20 types`).toBe(
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

// KNOWN_ISSUES #90-NULL regression guard.
//
// Migration 20260613070000_activity_log_null_attribution_comment_only.sql
// tightens the same INSERT policy's user_id clause so a NULL (system-attributed)
// user_id is permitted ONLY for activity_type='comment'. Every other allowlisted
// client type must carry user_id = auth.uid(), closing the residual where a
// member could forge a system-attributed 'status_change'/'approval'/'lease_archived'.
//
// We assert against the SAME "latest policy migration" the allowlist test reads,
// so the two guards can never drift onto different files: whichever migration is
// the current definition of the policy MUST carry both the allowlist AND the
// NULL-comment carve-out.
describe('lease_activity_log NULL-attribution carve-out (#90-NULL)', () => {
  function latestPolicyMigrationSql(): { file: string; sql: string } {
    const dir = join(ROOT, 'supabase/migrations');
    const candidates = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        readFileSync(join(dir, f), 'utf8').includes(
          'CREATE POLICY "Users can create activity entries"',
        ),
      )
      .sort();
    expect(candidates.length, 'no migration defines the activity-log INSERT policy').toBeGreaterThan(
      0,
    );
    const file = candidates[candidates.length - 1];
    return { file, sql: readFileSync(join(dir, file), 'utf8') };
  }

  it('permits NULL user_id ONLY for comment, and requires auth.uid() otherwise', () => {
    const { file, sql } = latestPolicyMigrationSql();
    // Normalize whitespace so formatting differences don't break the match.
    const normalized = sql.replace(/\s+/g, ' ');
    expect(
      normalized,
      `${file}: user_id clause must carve NULL to comment-only (#90-NULL)`,
    ).toContain("(user_id = auth.uid()) OR (user_id IS NULL AND activity_type = 'comment')");
  });

  it('no longer carries the loose "user_id IS NULL" allow-any clause', () => {
    const { file, sql } = latestPolicyMigrationSql();
    const normalized = sql.replace(/\s+/g, ' ');
    // The pre-#90-NULL shape allowed NULL for ANY type: `(user_id IS NULL))`
    // immediately closing the user_id group with no activity_type qualifier.
    expect(
      normalized,
      `${file}: the loose unqualified NULL clause must be gone (#90-NULL)`,
    ).not.toContain('OR (user_id IS NULL)) AND');
  });

  // Shared sweep for the user_id/activity_type pairing across client writers.
  // Returns BOTH the offender list (literal `user_id: null` on a non-comment
  // type) AND every matched (user_id, type) pair, so a sibling sanity probe can
  // confirm the regex actually saw the known literal-null comment sites. Without
  // that probe, a future regex break would make the offender check go FALSELY
  // green (zero matches => zero offenders => pass), hiding the regression class
  // this guard exists to catch.
  type NullSweep = {
    offenders: string[];
    literalNullSites: Array<{ file: string; type: string }>;
    matchedFiles: Set<string>;
  };

  function sweepUserIdAttribution(): NullSweep {
    const offenders: string[] = [];
    const literalNullSites: Array<{ file: string; type: string }> = [];
    const matchedFiles = new Set<string>();
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
      if (!src.includes('lease_activity_log') || !src.includes('.insert(')) continue;
      const rel = file.slice(ROOT.length + 1);
      // Match each insert object's user_id + the nearest following activity_type.
      // CAVEAT: assumes user_id precedes activity_type within ~200 chars in the
      // insert object — true for every current writer. A future writer that
      // orders activity_type FIRST, or separates the two keys by more, would
      // escape this sweep; widen the window / add a reverse-order pass if so.
      // The sanity probe below trips if this regex stops matching the known
      // literal-null sites, so a silent break surfaces instead of false-greening.
      for (const m of src.matchAll(
        /user_id:\s*([^,\n]+),[\s\S]{0,200}?activity_type:\s*([^,\n]+)/g,
      )) {
        const userIdExpr = m[1].trim();
        const typeExpr = m[2].trim();
        const isLiteralNull = userIdExpr === 'null'; // exactly `user_id: null`, not `x ?? null`
        const isComment = /['"]comment['"]/.test(typeExpr);
        if (isLiteralNull) {
          literalNullSites.push({ file: rel, type: typeExpr });
          matchedFiles.add(rel);
          if (!isComment) {
            offenders.push(`${rel}: user_id=${userIdExpr} type=${typeExpr}`);
          }
        }
      }
    }
    return { offenders, literalNullSites, matchedFiles };
  }

  it('no client writer hardcodes user_id: null for a NON-comment type', () => {
    // The unambiguous breakage #90-NULL would introduce: a writer passing a
    // LITERAL `user_id: null` for a non-comment type inserts a definitely-null
    // actor, which the tightened policy RLS-rejects (42501). Today every literal
    // `user_id: null` site is a 'comment' (leaseNotifications, FinancialReview,
    // ApprovalQueue, LeaseReview) — this fails if a future writer adds a literal
    // null for any other type.
    //
    // Deliberately EXCLUDED: defensive `user?.id ?? null` / `|| null` on the
    // four non-comment sites (LeaseReview status_change/approval, Leases
    // archived/restored). Those execute only inside authenticated, member-gated
    // flows where the policy's EXISTS check already requires a non-null
    // auth.uid(), so user_id resolves to the real UID at runtime, never null —
    // verified 2026-06-13. Flagging them would be a false positive.
    const { offenders } = sweepUserIdAttribution();
    expect(
      offenders,
      'client writers hardcode user_id: null for a NON-comment type — these ' +
        'rows would be RLS-rejected (42501) after #90-NULL: ' + offenders.join('; '),
    ).toEqual([]);
  });

  it('sanity: the null-attribution sweep actually saw the known literal-null comment sites', () => {
    // Guards against the offender check going FALSELY green if the user_id ->
    // activity_type regex breaks (key-order change, window too narrow, syntax
    // drift). The known literal `user_id: null` sites are ALL 'comment' today;
    // if the sweep stops finding them, the regression guard above is blind and
    // this probe fails instead. Pins the four files carrying literal-null
    // comment inserts (leaseNotifications, FinancialReview, ApprovalQueue).
    const { literalNullSites, matchedFiles } = sweepUserIdAttribution();
    expect(
      literalNullSites.length,
      'sweep found NO literal `user_id: null` insert sites — the regex likely broke',
    ).toBeGreaterThan(0);
    // Every literal-null site the sweep DID see must be a comment (the invariant
    // #90-NULL was verified against); a non-comment would already be an offender,
    // but pinning it here makes the contract explicit.
    for (const site of literalNullSites) {
      expect(
        /['"]comment['"]/.test(site.type),
        `literal user_id: null at ${site.file} is type ${site.type}, expected 'comment'`,
      ).toBe(true);
    }
    for (const expected of [
      'src/lib/leaseNotifications.ts',
      'src/pages/app/FinancialReview.tsx',
      'src/pages/app/ApprovalQueue.tsx',
    ]) {
      expect(
        matchedFiles.has(expected),
        `sweep lost the literal-null comment writer in ${expected}`,
      ).toBe(true);
    }
  });
});
