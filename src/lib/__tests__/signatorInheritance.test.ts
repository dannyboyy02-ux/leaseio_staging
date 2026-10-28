import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Move 2 (D2) — materialized signator inheritance. A one-stage rule (concept
// steps, no signator steps) gets its signature stage MATERIALIZED at
// chain-creation time by cloning the concept steps. The load-bearing invariants
// (verified statically so drift fails CI, since the edge fn can't be unit-run):
//   1. resolve-approval-chain applies materializeSignatorInheritance in BOTH the
//      initial-resolution AND the reroute branch, and the reroute rowsToInsert
//      maps the EXPANDED steps (else the inherited signature stage silently drops
//      on reroute).
//   2. The SoD check runs over the AUTHORED steps BEFORE the expansion — that
//      ordering is exactly how "SoD auto-satisfied for the inherited stage" is
//      implemented.
//   3. The Node + Deno mirrors of materializeSignatorInheritance are behaviorally
//      identical (same body modulo quote style).
//   4. The preview RPC migration mirrors the inheritance (inherited=true +
//      signator_inherited) so the tester equals the live chain.

const repoRoot = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `expected to find "${start}"`).toBeGreaterThanOrEqual(0);
  const j = src.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

// Extract the materializeSignatorInheritance function source and normalize away
// quote style (Node uses ', Deno uses ") + whitespace so the two mirrors compare
// on behavior, not incidental formatting.
function materializeBody(src: string): string {
  const body = sliceBetween(
    src,
    'export function materializeSignatorInheritance',
    '\n}\n',
  );
  return body.replace(/["']/g, '"').replace(/\s+/g, ' ').trim();
}

describe('#move2 — resolve-approval-chain applies inheritance in both branches', () => {
  const src = read('supabase/functions/resolve-approval-chain/index.ts');

  it('imports the helper from the shared Deno module', () => {
    // Everything from the first import up to the approval_chain from-path — the
    // helper identifier must appear in that shared-module import list.
    const importSpan = sliceBetween(src, 'import {', 'from "../_shared/approval_chain.ts"');
    expect(importSpan).toContain('materializeSignatorInheritance');
  });

  it('initial-resolution branch expands policySteps AFTER the SoD check', () => {
    const branch = src.slice(src.indexOf('// ─── Branch: initial resolution (Phase 2 path)'));
    const sodAt = branch.indexOf('checkSeparationOfDuties(sodCheckSteps');
    const materializeAt = branch.indexOf('materializeSignatorInheritance(policySteps)');
    expect(sodAt, 'SoD check present in initial branch').toBeGreaterThan(0);
    expect(materializeAt, 'materialize present in initial branch').toBeGreaterThan(0);
    expect(materializeAt, 'materialize runs AFTER the authored-steps SoD check').toBeGreaterThan(sodAt);
    // rows are built from the EXPANDED list
    expect(branch).toContain('const rowsToInsert = effectiveSteps.map(');
  });

  it('reroute branch expands newPolicySteps AFTER the SoD check and inserts the expanded rows', () => {
    const branch = sliceBetween(
      src,
      '// ─── Branch: Phase 6 reroute mode',
      '// ─── Branch: initial resolution (Phase 2 path)',
    );
    const sodAt = branch.indexOf('checkSeparationOfDuties(newAsLike');
    const materializeAt = branch.search(/materializeSignatorInheritance\(\s*newPolicySteps/);
    expect(sodAt, 'SoD check present in reroute branch').toBeGreaterThan(0);
    expect(materializeAt, 'materialize present in reroute branch').toBeGreaterThan(0);
    expect(materializeAt, 'materialize runs AFTER the authored-steps SoD check').toBeGreaterThan(sodAt);
    // reconcile / rollback / insert all run over the EXPANDED list
    expect(branch).toContain('reconcileChainSteps(existingChain, effectiveNewAsLike)');
    expect(branch).toContain('rollbackTargetForNewChain(effectiveNewAsLike, reconciled)');
    expect(branch).toContain('const rowsToInsert = effectiveNewSteps');
  });

  it('records signator_inherited in the chain_resolved / chain_rerouted audit', () => {
    expect(src).toContain('signator_inherited: inheritedSignator');
    expect(src).toContain('signator_steps_inherited: inheritedSignator ? conceptCount : 0');
  });
});

describe('#move2 — Node and Deno mirrors of materializeSignatorInheritance match', () => {
  const nodeBody = materializeBody(read('src/lib/approvalChainLogic.ts'));
  const denoBody = materializeBody(read('supabase/functions/_shared/approval_chain.ts'));

  it('are behaviorally identical (body modulo quote style + whitespace)', () => {
    expect(nodeBody).toBe(denoBody);
  });

  it('both refuse to expand when signator steps exist or concept is empty', () => {
    for (const body of [nodeBody, denoBody]) {
      expect(body).toContain('const hasSignator = steps.some((s) => s.stage === "signator")');
      expect(body).toContain('if (hasSignator || concept.length === 0) return { steps, inheritedSignator: false }');
      expect(body).toContain('stage: "signator" as Stage');
    }
  });
});

describe('#move2 — preview RPC migration mirrors the inheritance', () => {
  const dir = join(repoRoot, 'supabase', 'migrations');
  const file = readdirSync(dir)
    .filter((f) => f.includes('preview_policy_resolution_signator_inheritance'))
    .sort()
    .pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');

  it('appends inherited signator rows and returns signator_inherited', () => {
    expect(sql).toContain("'inherited', true");
    expect(sql).toContain("'signator_inherited', v_signator_inherited");
    // guarded on the concept agg being non-null (malformed zero-step policy safe)
    expect(sql).toContain('IF v_inherited_signator IS NOT NULL THEN');
  });
});
