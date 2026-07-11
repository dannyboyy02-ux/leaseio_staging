import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-source coverage for cancel-subscription — the in-app cancel/resume of
// the workspace plan subscription (2026-07-11). It replaces the old "confirm
// dialog → Stripe portal → cancel AGAIN" double-cancel. It is security-critical
// (it mutates a paid subscription), so the auth/gating contract must mirror
// customer-portal exactly: owner-OR-admin, workspace-scoped, firm-bound rejected
// fail-closed, no-subscription 409. Deno fns can't run under vitest, so we pin
// the load-bearing blocks with readFileSync (repo convention; full-file
// toContain is a known false-positive trap — narrow the window first).

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const src = read('supabase/functions/cancel-subscription/index.ts');

function section(s: string, start: string, end: string): string {
  const i = s.indexOf(start);
  expect(i, `start marker not found: "${start}"`).toBeGreaterThan(-1);
  const j = s.indexOf(end, i + start.length);
  expect(j, `end marker not found after "${start}": "${end}"`).toBeGreaterThan(i);
  return s.slice(i, j + end.length);
}

describe('cancel-subscription — auth & request validation', () => {
  it('requires an Authorization header and 401s when absent', () => {
    const block = section(src, 'const authHeader', 'const body =');
    expect(block).toContain('req.headers.get("Authorization")');
    expect(block).toContain('if (!authHeader)');
    expect(block).toMatch(/reason:\s*"no_auth"/);
    expect(block).toContain('401');
  });

  it('verifies the bearer token via auth.getUser and 401s an invalid session', () => {
    const block = section(src, 'const token = authHeader', 'const body =');
    expect(block).toContain('supabaseAdmin.auth.getUser(token)');
    expect(block).toContain('if (userError || !userData?.user?.id)');
    expect(block).toMatch(/reason:\s*"invalid_auth"/);
  });

  it('validates workspaceId before any DB read', () => {
    const block = section(src, 'const workspaceId =', 'const { data: workspace');
    expect(block).toContain('if (!workspaceId || typeof workspaceId !== "string")');
    expect(block).toMatch(/reason:\s*"bad_request"/);
    expect(block).toContain('400');
  });
});

describe('cancel-subscription — gating (mirrors customer-portal)', () => {
  it('rejects firm-bound workspaces fail-closed (403 firm_managed) before any Stripe call', () => {
    const block = section(src, 'if ((workspace as { firm_id', '403,\n      );');
    expect(block).toMatch(/reason:\s*"firm_managed"/);
    const firmIdx = src.indexOf('"firm_managed"');
    const stripeIdx = src.indexOf('new Stripe(stripeKey');
    expect(firmIdx).toBeGreaterThan(-1);
    expect(stripeIdx).toBeGreaterThan(firmIdx);
  });

  it('allows the owner, else requires a workspace_members row with role=admin', () => {
    const block = section(src, 'let canManageBilling', 'canManageBilling = Boolean(membership);');
    expect(block).toContain('owner_id === user.id');
    expect(block).toContain('.from("workspace_members")');
    expect(block).toContain('.eq("workspace_id", workspaceId)');
    expect(block).toContain('.eq("user_id", user.id)');
    expect(block).toContain('.eq("role", "admin")');
  });

  it('403s a non-owner non-admin (a member can never cancel the subscription)', () => {
    const block = section(src, 'Only workspace owners or admins can change', '403,\n      );');
    expect(block).toMatch(/reason:\s*"not_authorized"/);
  });

  it('409s when the workspace has no subscription to change', () => {
    const block = section(src, 'const subscriptionId =', '409,\n      );');
    expect(block).toContain('stripe_subscription_id');
    expect(block).toMatch(/reason:\s*"no_subscription"/);
  });

  it('the authz gate runs BEFORE any Stripe mutation', () => {
    const gateIdx = src.indexOf('"not_authorized"');
    const updateIdx = src.indexOf('stripe.subscriptions.update');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(gateIdx);
  });
});

describe('cancel-subscription — cancel vs resume + period-end (no immediate cancel)', () => {
  it('sets cancel_at_period_end from the resume flag (never an immediate cancel)', () => {
    // resume=false → cancel_at_period_end:true (schedule); resume=true → false (undo).
    // Access is always kept until period end — mirrors the pack/firm pattern.
    const block = section(src, 'const updated = await stripe.subscriptions.update', 'current_period_end');
    expect(block).toContain('cancel_at_period_end: !resume');
    expect(src).toContain('const resume = (body as { resume?: boolean }).resume === true');
  });

  it('returns the resulting cancelAtPeriodEnd + currentPeriodEnd + status', () => {
    const block = section(src, 'ok: true,', '200,\n      );');
    expect(block).toContain('cancelAtPeriodEnd: Boolean(updated.cancel_at_period_end)');
    expect(block).toContain('currentPeriodEnd');
    expect(block).toContain('status: updated.status');
  });

  it('audits the change to workspace_activity_log, best-effort (never fails the action)', () => {
    const block = section(src, 'workspace_activity_log', 'source: "cancel-subscription"');
    expect(block).toContain('resume ? "subscription_cancel_reverted" : "subscription_cancel_scheduled"');
    expect(block).toContain('cancel_at_period_end: !resume');
    // Audit is inside its own try/catch so a logging hiccup can't fail the user.
    expect(src).toContain('audit insert failed (Stripe update already committed)');
  });

  it('maps Stripe failures to 502 (reason:"stripe_error"), not a thrown 500', () => {
    const block = section(src, 'catch (stripeErr)', '502);');
    expect(block).toMatch(/reason:\s*"stripe_error"/);
  });
});
