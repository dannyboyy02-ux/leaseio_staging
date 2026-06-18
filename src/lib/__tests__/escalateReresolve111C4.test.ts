import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #111 C4 — escalate-to-concept rebuilds the concept stage from the
// CURRENT policy (re-match) instead of cloning prior rows verbatim (which
// resurrected superseded prior-policy approvers). Implemented as a
// forceConceptReactivation mode in resolve-approval-chain, invoked by escalate
// BEFORE the lifecycle flip so a failed match can't strand the lease.

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#111 C4 — resolve-approval-chain forceConceptReactivation mode', () => {
  const src = fn('supabase/functions/resolve-approval-chain/index.ts');

  it('accepts the forceConceptReactivation flag and branches on it', () => {
    expect(src).toContain('forceConceptReactivation?: boolean');
    expect(src).toContain('const forceConceptReactivation = body?.forceConceptReactivation === true');
    expect(src).toContain('if (forceConceptReactivation) {');
  });

  it('re-matches the current policy and loads CONCEPT steps only', () => {
    // The branch calls the shared matchPolicy() (no duplicated routing logic)
    // and scopes the step load to the concept stage.
    const branch = src.slice(src.indexOf('if (forceConceptReactivation) {'));
    expect(branch).toContain('await matchPolicy()');
    expect(branch).toMatch(/\.eq\("policy_id", chosen\.id\)\s*\.eq\("stage", "concept"\)/);
    expect(branch).toContain('checkSeparationOfDuties(');
  });

  it('rebuilds atomically via the C5 RPC and returns assignees (no lifecycle change)', () => {
    const branch = src.slice(
      src.indexOf('if (forceConceptReactivation) {'),
      src.indexOf('// ─── Branch: Phase 6 reroute mode'),
    );
    expect(branch).toContain('reroute_reconcile_chain_steps');
    expect(branch).toContain('reactivated: true');
    // The mode must NOT touch the lease lifecycle — the caller owns that.
    expect(branch).not.toMatch(/lifecycle_status:/);
  });
});

describe('#111 C4 — escalate-to-concept invokes the mode, then flips lifecycle', () => {
  const src = fn('supabase/functions/escalate-to-concept-approver/index.ts');

  it('no longer clones prior concept rows verbatim', () => {
    expect(src).not.toContain('clone the most recent concept-stage rows');
    expect(src).not.toContain('priorConceptRows');
    expect(src).not.toContain('newChainStepIds');
  });

  it('invokes resolve-approval-chain in forceConceptReactivation mode', () => {
    expect(src).toContain('functions/v1/resolve-approval-chain');
    expect(src).toContain('forceConceptReactivation: true');
  });

  it('rebuilds the chain BEFORE flipping the lifecycle (no stranding on a failed match)', () => {
    const reactivateAt = src.indexOf('forceConceptReactivation: true');
    const lifecycleAt = src.indexOf('updateLifecycle("concept_under_review")');
    expect(reactivateAt).toBeGreaterThan(0);
    expect(lifecycleAt).toBeGreaterThan(0);
    expect(reactivateAt).toBeLessThan(lifecycleAt);
  });

  it('aborts (does not flip lifecycle) when the resolver rejects', () => {
    expect(src).toContain('reactivation_failed');
    expect(src).toMatch(/!resolverResp\.ok \|\| \(resolverJson as any\)\?\.ok === false/);
  });
});
