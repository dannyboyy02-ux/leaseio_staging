import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-source coverage for the Phase 3 ownership-transfer edge function
// (spec §4.2). Deno functions can't run under vitest, so — per repo
// convention (see workspaceLimits.test.ts) — we pin the load-bearing source
// blocks with readFileSync, narrowing the search window to each block's
// declaration before asserting. Full-file toContain is a known false-positive
// trap (a matching string elsewhere in the file would mask a regression).
//
// What we pin:
//   1. Owner-only authorization (caller must equal workspaces.owner_id).
//   2. Target eligibility: accepted member only (user_id AND accepted_at
//      both NOT NULL) — excludes invited-but-unaccepted rows.
//   3. Member-row mutations happen BEFORE the owner_id swap (consistency
//      guarantee documented in the function header).
//   4. The swap carries an owner-guard predicate (.eq("owner_id",
//      ws.owner_id)) so a concurrent transfer can't double-apply.
//   5. The audit row: event_type "owner_transferred" with
//      billing_transferred: false (v1 limitation surfaced in the trail).
//   6. The prior owner is demoted to 'admin' on both paths (update of an
//      existing member row, insert fallback when none exists).

const src = readFileSync(
  join(
    process.cwd(),
    'supabase/functions/transfer-workspace-ownership/index.ts',
  ),
  'utf8',
);

/** Slice the source between two unique markers; fail loudly if either moved. */
function section(start: string, end: string): string {
  const i = src.indexOf(start);
  expect(i, `start marker not found: "${start}"`).toBeGreaterThan(-1);
  const j = src.indexOf(end, i + start.length);
  expect(j, `end marker not found after "${start}": "${end}"`).toBeGreaterThan(i);
  return src.slice(i, j);
}

describe('transfer-workspace-ownership — authorization', () => {
  it('rejects callers who are not the workspace owner (403)', () => {
    const block = section(
      'Authorization: load workspace, verify owner',
      'Validate target: accepted member only',
    );
    expect(block).toContain('ws.owner_id !== user.id');
    expect(block).toMatch(/reason:\s*"not_owner"/);
    expect(block).toMatch(/403/);
  });

  it('rejects transferring to the current owner (already_owner)', () => {
    const block = section(
      'Authorization: load workspace, verify owner',
      'Validate target: accepted member only',
    );
    expect(block).toContain('targetUserId === ws.owner_id');
    expect(block).toMatch(/reason:\s*"already_owner"/);
  });
});

describe('transfer-workspace-ownership — target eligibility', () => {
  it('requires an ACCEPTED member: user_id AND accepted_at both NOT NULL, scoped to the workspace', () => {
    const block = section(
      'Validate target: accepted member only',
      'Rate limit',
    );
    expect(block).toContain('.eq("workspace_id", workspaceId)');
    expect(block).toContain('.eq("user_id", targetUserId)');
    expect(block).toContain('.not("user_id", "is", null)');
    expect(block).toContain('.not("accepted_at", "is", null)');
  });

  it('rejects a non-member / unaccepted target with target_not_accepted_member', () => {
    const block = section(
      'Validate target: accepted member only',
      'Rate limit',
    );
    expect(block).toMatch(/reason:\s*"target_not_accepted_member"/);
  });
});

describe('transfer-workspace-ownership — prior-owner demotion', () => {
  it("demotes the prior owner to 'admin' on the update path AND the insert fallback", () => {
    const block = section('Mandatorily demote prior owner', 'Swap owner_id');
    // Update path (member row exists).
    expect(block).toContain('.update({ role: "admin" })');
    // Insert fallback (prior owner had no member row) — also admin, with an
    // accepted_at so they aren't an "invited" phantom in their own workspace.
    const insertIdx = block.indexOf('.insert({');
    expect(insertIdx, 'insert fallback not found in demotion block').toBeGreaterThan(-1);
    const insertBlock = block.slice(insertIdx, block.indexOf('})', insertIdx));
    expect(insertBlock).toMatch(/role:\s*"admin"/);
    expect(insertBlock).toMatch(/user_id:\s*ws\.owner_id/);
    expect(insertBlock).toContain('accepted_at:');
  });

  it('member-row mutations (promote target, demote prior owner) happen BEFORE the owner_id swap', () => {
    const promoteIdx = src.indexOf("Ensure target's member row is admin");
    const demoteIdx = src.indexOf('Mandatorily demote prior owner');
    const swapIdx = src.indexOf('Swap owner_id');
    expect(promoteIdx).toBeGreaterThan(-1);
    expect(demoteIdx).toBeGreaterThan(promoteIdx);
    expect(swapIdx).toBeGreaterThan(demoteIdx);
  });
});

describe('transfer-workspace-ownership — owner_id swap', () => {
  it('the swap UPDATE is guarded by the prior owner_id (no double-apply under concurrency)', () => {
    const block = section('Swap owner_id', 'Audit row');
    expect(block).toContain('.update({ owner_id: targetUserId })');
    expect(block).toContain('.eq("id", workspaceId)');
    expect(block).toContain('.eq("owner_id", ws.owner_id)');
  });
});

describe('transfer-workspace-ownership — audit row', () => {
  it('logs owner_transferred with from/to and billing_transferred: false (v1 limitation surfaced)', () => {
    const block = section('Audit row', 'ok: true');
    expect(block).toContain('workspace_activity_log');
    expect(block).toMatch(/event_type:\s*"owner_transferred"/);
    expect(block).toMatch(/from:\s*ws\.owner_id/);
    expect(block).toMatch(/to:\s*targetUserId/);
    expect(block).toMatch(/billing_transferred:\s*false/);
    expect(block).toMatch(/prior_owner_new_role:\s*"admin"/);
  });

  it('the success response also surfaces billingTransferred: false so the UI can tell the prior owner', () => {
    const block = src.slice(src.indexOf('ok: true'));
    expect(block).toMatch(/billingTransferred:\s*false/);
    expect(block).toMatch(/priorOwnerNewRole:\s*"admin"/);
  });
});

describe('transfer-workspace-ownership — rate limit', () => {
  it('enforces the shared workspace rate limit with a low ceiling', () => {
    const block = section('Rate limit', "Ensure target's member row is admin");
    expect(block).toContain('enforceWorkspaceRateLimit');
    expect(block).toContain('"transfer-workspace-ownership"');
  });
});
