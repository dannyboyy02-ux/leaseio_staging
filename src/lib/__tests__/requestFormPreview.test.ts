import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1-7 (END_TO_END_REVIEW / notifications + j3-requestor) — a truthful request
// form. Two lies: (a) the route preview read only workspace_roles and showed the
// legacy manager/financial flow even when approval POLICIES exist (actual
// submission routes through the policy chain); (b) optional term fields were
// labeled "AI will extract them from the uploaded document" — but there is no
// document at request time and AI abstraction runs only later (at finalize), so
// a requestor leaving routing-critical fields blank got neither.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P1-7 — truthful approval-route preview', () => {
  const frm = read('src/components/workflow/LeaseRequestForm.tsx');
  it('calls the real resolver (preview_policy_resolution) when policies exist', () => {
    expect(frm).toContain('hasActivePolicies');
    expect(frm).toContain("'preview_policy_resolution'");
    // Gated on active policies existing.
    expect(frm).toMatch(/from\('approval_policies'\)[\s\S]{0,120}is_active', true/);
  });
  it('renders the policy route (or a no-match warning) instead of the legacy heuristic', () => {
    expect(frm).toContain('route_via_policy');
    expect(frm).toContain('no_matching_policy');
    // Legacy role preview retained only for the no-policy case.
    expect(frm).toContain('approvalPreview.requiresManagerApproval');
  });
  it('reads the resolver result under `chain` (NOT `steps` — the real key)', () => {
    // preview_policy_resolution returns the steps under `chain`; the earlier
    // `.steps` read was undefined → crashed the whole SPA on the matched path.
    expect(frm).toMatch(/policyResolution\.chain\.some/);
    expect(frm).not.toMatch(/policyResolution\.steps/);
  });
  it('never flashes the legacy preview and does not alarm an empty form', () => {
    // Tri-state: null while the policy check loads (neutral, not legacy badges);
    // the no-match warning waits for real routing input.
    expect(frm).toMatch(/hasActivePolicies === null \?/);
    expect(frm).toMatch(/requestingDepartment \|\| Number\(monthlyPayment\) > 0/);
    // The contradictory legacy "no approvers" banner is suppressed under policies.
    expect(frm).toMatch(/hasApprovers === false && hasActivePolicies === false/);
  });
});

describe('P1-7 — no false AI-extract labels', () => {
  it('the request-form field hints no longer claim AI will extract them', () => {
    for (const p of ['src/locales/en/common.json', 'src/locales/es/common.json']) {
      const loc = read(p);
      const i = loc.indexOf('"ai_extract_full"');
      expect(i).toBeGreaterThan(-1);
      const block = loc.slice(i, i + 200);
      expect(block).not.toMatch(/AI will extract|La IA lo extraerá/);
    }
  });
  it('the schema comment no longer claims request-time AI extraction', () => {
    const frm = read('src/components/workflow/LeaseRequestForm.tsx');
    expect(frm).not.toMatch(/AI will extract them from the uploaded document/);
    expect(frm).toMatch(/AI abstraction runs later/);
  });
});
