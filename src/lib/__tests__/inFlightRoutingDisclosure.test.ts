import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Approval Rules redesign — D-Q5 (in-flight routing disclosure).
//
// An adversarial review REFUTED the claim "no reorder can change approvers on an
// in-flight request". It is not true and cannot be made true without freezing
// routing, which the owner explicitly declined. D-Q5, ratified:
//
//   KEEP the behaviour — an in-flight lease re-evaluates against the CURRENT
//   rules when its OWN attributes change materially — and ADD the disclosure.
//
// This suite pins the three artifacts that carry that decision and cannot be
// unit-run: two Phase-0 migration headers (prose that reviewers quote), the Deno
// edge function, and the activity_type CHECK constraint the disclosure row needs
// in order to land at all.

const repoRoot = join(__dirname, '..', '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

function migration(fragment: string): { name: string; sql: string } {
  const name = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f.includes(fragment))
    .sort()
    .pop();
  expect(name, `expected a migration matching "${fragment}"`).toBeTruthy();
  return { name: name!, sql: readFileSync(join(migrationsDir, name!), 'utf8') };
}

function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

const fnSrc = read('supabase/functions/resolve-approval-chain/index.ts');

describe('#dq5 — migration headers state the accurate claim, not the overclaim', () => {
  const versionTrigger = migration('approval_policies_version_ignores_priority');
  const versionHeader = versionTrigger.sql.slice(
    0,
    versionTrigger.sql.indexOf('CREATE OR REPLACE TRIGGER'),
  );
  const retirement = migration('retire_is_default_fallback_routing');

  it('the version-trigger header scopes its benefit to SPURIOUS reroutes', () => {
    expect(versionHeader).toMatch(/SPURIOUS/);
    expect(versionHeader).toMatch(/fabricat/i);
  });

  it('the version-trigger header explicitly disclaims freezing in-flight routing', () => {
    expect(versionHeader).toMatch(/does NOT freeze routing/i);
    expect(versionHeader).toMatch(/D-Q5/);
    // ...and names the reroute condition honestly (own attributes, material).
    expect(versionHeader).toMatch(/attributes materially change|OWN attributes/i);
  });

  it('the version-trigger header points at the disclosure that replaces the guarantee', () => {
    expect(versionHeader).toContain('chain_routing_rule_changed');
  });

  it('the retired overclaims are gone from both headers', () => {
    // "Nothing real is missed" implied the version comparison covered every way
    // routing could move under an in-flight lease. It did not.
    expect(versionHeader).not.toContain('Nothing real is missed');
    // "(inFlightSafety guarantee)" asserted a guarantee that does not exist.
    expect(retirement.sql).not.toContain('inFlightSafety guarantee');
  });

  it('the retirement migration carries an explicit HONEST LIMIT note', () => {
    const header = retirement.sql.slice(0, retirement.sql.indexOf('DO $$'));
    expect(header).toMatch(/HONEST LIMIT/);
    expect(header).toMatch(/D-Q5/);
    expect(header).toContain('chain_routing_rule_changed');
    expect(header).toMatch(/immutability guarantee; there is none|not a promise/i);
  });

  it('the increment_policy_version COMMENT does not overclaim either', () => {
    const comment = sliceBetween(
      versionTrigger.sql,
      'COMMENT ON FUNCTION public.increment_policy_version()',
      ';\n',
    );
    expect(comment).toMatch(/SPURIOUS/);
    expect(comment).toMatch(/does NOT freeze routing/i);
  });
});

describe('#dq5 — reroute path discloses a winning-rule change', () => {
  const reroute = sliceBetween(
    fnSrc,
    '// ─── Branch: Phase 6 reroute mode',
    '// ─── Branch: initial resolution',
  );

  it('distinguishes a WINNER change from a version bump of the same rule', () => {
    expect(reroute).toContain(
      'const routingRuleChanged = (snapshot?.policy_id ?? null) !== newPolicy.id;',
    );
    // The pre-existing immaterial short-circuit (same id AND same version) is
    // untouched — the disclosure is additive, not a behaviour change.
    expect(reroute).toContain('snapshot.policy_id === newPolicy.id');
    expect(reroute).toContain('snapshot.policy_version === newPolicy.version');
  });

  it('resolves the prior rule to a NAME (a uuid does not answer "why")', () => {
    expect(reroute).toContain('loadPolicyIdentity(snapshot?.policy_id ?? null)');
    expect(fnSrc).toContain('async function loadPolicyIdentity(');
    expect(fnSrc).toContain('.select("id, name")');
  });

  it('writes the explicit disclosure row only when the winner changed', () => {
    const guard = sliceBetween(reroute, 'if (routingRuleChanged) {', '}');
    expect(guard).toContain('logRoutingRuleChanged({');
    expect(guard).toContain('context: "reroute"');
    expect(guard).toContain('changedAttributes');
  });

  it('enriches the existing chain_rerouted audit with both rule names', () => {
    const rerouted = sliceBetween(reroute, 'logActivity(leaseId, "chain_rerouted", {', '});');
    expect(rerouted).toContain('routing_rule_changed: routingRuleChanged');
    expect(rerouted).toContain('prior_policy_name');
    expect(rerouted).toContain('new_policy_name: newPolicy.name');
  });

  it('audit mode reports the would-be routing change but writes no disclosure row', () => {
    const auditBlock = sliceBetween(reroute, 'if (auditMode) {', '// ── Apply reconciliation');
    expect(auditBlock).toContain('would_change_routing_rule: routingRuleChanged');
    expect(auditBlock).toContain('routingChanged: routingRuleChanged');
    // Dry run changes nothing, so it must NOT claim a change happened.
    expect(auditBlock).not.toContain('logRoutingRuleChanged(');
  });

  it('returns routingChanged + both rule names to the caller', () => {
    expect(reroute).toContain('routingChanged: routingRuleChanged');
    expect(reroute).toContain('priorPolicyName: priorPolicyIdentity?.name ?? null');
    expect(reroute).toContain('newPolicyName: newPolicy.name');
  });
});

describe('#dq5 — forceConceptReactivation is honest, not frozen', () => {
  const branch = sliceBetween(
    fnSrc,
    'if (forceConceptReactivation) {',
    '// ─── Branch: Phase 6 reroute mode',
  );

  it('still rebuilds from the CURRENT match (the #111 fix is NOT reverted)', () => {
    expect(branch).toContain('m = await matchPolicy();');
    expect(branch).toContain('const chosen = m.policy;');
    // Fresh rows are built from the CURRENT policy's concept steps.
    expect(branch).toContain('.eq("policy_id", chosen.id)');
    expect(branch).toContain('policy_id: chosen.id');
  });

  it('compares the current winner against the snapshot, like the reroute branch', () => {
    expect(branch).toContain('.from("lease_attribute_snapshots")');
    expect(branch).toContain('const reactSnapshot = reactSnapData as SnapshotRow | null;');
    expect(branch).toContain(
      'const reactRoutingChanged = priorRoutedPolicyId !== null && priorRoutedPolicyId !== chosen.id;',
    );
  });

  it('falls back to the lease\'s own chain rows, and never invents a change', () => {
    expect(branch).toContain('.eq("stage", "concept")');
    expect(branch).toContain('.not("policy_id", "is", null)');
    // Unknown prior routing is REPORTED as unknown rather than counted as a change.
    expect(branch).toContain('prior_policy_unknown: true');
  });

  it('audits the winner change instead of suppressing the rebuild', () => {
    expect(branch).toContain('context: "concept_reactivation"');
    // Order matters: the rebuild lands FIRST, then the disclosure. If the
    // disclosure ever became a precondition/early-return, the #111 regression
    // (superseded approvers resurrecting) would be back.
    const reconcileAt = branch.indexOf('reroute_reconcile_chain_steps');
    const discloseAt = branch.indexOf('logRoutingRuleChanged({');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(discloseAt).toBeGreaterThan(reconcileAt);
    // No early return gated on the routing change.
    expect(branch).not.toMatch(/if\s*\(\s*reactRoutingChanged\s*\)\s*\{\s*return/);
  });

  it('returns routingChanged + the prior rule name to the caller', () => {
    expect(branch).toContain('routingChanged: reactRoutingChanged');
    expect(branch).toContain('priorPolicyName: reactPriorIdentity?.name ?? null');
  });
});

describe('#dq5 — the disclosure activity_type can actually land', () => {
  it('the writer emits the literal (visible to the #76 drift sweep)', () => {
    expect(fnSrc).toContain('await logActivity(leaseId, "chain_routing_rule_changed", {');
  });

  it('the latest activity_type CHECK migration allows it', () => {
    const marker = 'ADD CONSTRAINT lease_activity_log_activity_type_check';
    const latest = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => readFileSync(join(migrationsDir, f), 'utf8').includes(marker))
      .sort()
      .pop();
    expect(latest, 'no migration defines the lease_activity_log activity_type CHECK').toBeTruthy();
    const sql = readFileSync(join(migrationsDir, latest!), 'utf8');
    const block = sql.slice(sql.indexOf(marker), sql.indexOf('));', sql.indexOf(marker)));
    expect(block, `${latest} is missing 'chain_routing_rule_changed'`).toContain(
      "'chain_routing_rule_changed'",
    );
    // Superset guard: the re-snapshot must not have dropped prior values.
    for (const v of [
      "'chain_resolution_fallback_to_default'",
      "'escalation_review_resolved'",
      "'chain_rerouted'",
      "'chain_resolved'",
      "'lease_purged'",
    ]) {
      expect(block, `${latest} dropped ${v}`).toContain(v);
    }
  });

  it('that migration is idempotent and applies after the Phase-1 order RPC', () => {
    const { name, sql } = migration('chain_routing_rule_changed_activity_type');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check');
    expect(name > '20260719121000_set_approval_policy_order_rpc.sql').toBe(true);
  });
});
