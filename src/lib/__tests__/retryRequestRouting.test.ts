import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Regression coverage for audit-finding C2 + Cluster A fix #1/#4 — retry the
// approval-routing path for a request-workflow lease stranded in 'draft'.
//
// SUT: src/lib/retryRequestRouting.ts — retryRequestRouting(supabase, lease,
// workspaceId, userId).
//
// THE CONTRACT CHANGE THIS FILE GUARDS (Cluster A #1/#4):
//   A DB trigger (prevent_unauthorized_lease_workflow_edits) now rejects any
//   authenticated/browser UPDATE that changes leases.lifecycle_status. The
//   draft → X flip AND the status_change activity-log row are written
//   SERVER-SIDE by the resolve-approval-chain edge function on all three
//   branches (fresh chain, legacy fallback, idempotent recovery). The edge
//   response carries the authoritative `finalStatus`.
//
//   So the CLIENT (this SUT) must:
//     1. make NO `leases` UPDATE that sets lifecycle_status  ← the actual bug
//     2. write NO `status_change` activity-log row           ← server does it
//     3. still notify the right approvers + createLeaseNotification
//     4. read finalStatus from the edge response and return it
//
//   The previous version of this SUT performed the client flip and wrote the
//   status_change row in the browser — both silently rejected/inconsistent in
//   production. These tests assert their ABSENCE; that absence is the
//   regression guard for the real defect.
//
// The pure DECISION logic (the four outcomes + the finalStatus precedence) is
// covered in leaseSubmissionDecision.test.ts. THIS file pins the ORCHESTRATION:
// which notifications fire (and which writes DON'T) per branch.
//
// Mocking approach:
//   * The `supabase` ARGUMENT is a hand-rolled PostgREST-ish chainable. We
//     dispatch on table name and record every write. NOTE: we deliberately do
//     NOT register builders for `leases` (UPDATE) or `lease_approval_chain` —
//     the SUT must not touch them anymore. If a future regression reintroduces
//     a client-side lifecycle flip or a direct chain read, `from('leases')` /
//     `from('lease_approval_chain')` throws "unexpected table", failing loudly.
//   * createLeaseNotification imports the SINGLETON supabase from
//     '@/integrations/supabase/client' (NOT the passed client), so we mock that
//     module too — both to stop the real createClient() from running and to
//     observe the lease_notifications insert.
// ─────────────────────────────────────────────────────────────────────────

// --- Singleton-client mock (used only by createLeaseNotification) ----------
const singletonInsertMock = vi.fn((..._a: unknown[]) => Promise.resolve({ error: null }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (_table: string) => ({ insert: (...a: unknown[]) => singletonInsertMock(...a) }),
  },
}));

import { retryRequestRouting, type RetryRoutingLease } from '../retryRequestRouting';
import type { ChainResult } from '../leaseSubmissionDecision';

// --- Chainable supabase argument mock -------------------------------------

const WORKSPACE_ID = 'ws-1';
const USER_ID = 'user-1';

interface WriteRecord {
  table: string;
  op: 'update' | 'insert';
  payload: unknown;
}

interface BuildOpts {
  approvalThreshold: number | null;
  managerApprovers: Array<{ user_id: string }>;
  financialApprovers: Array<{ user_id: string }>;
  chainResult: ChainResult;
  chainError: { message?: string } | null;
}

/**
 * Build the chainable `supabase` argument the SUT (and its notify helpers)
 * drive, plus a `writes` array recording every update/insert across all tables.
 *
 * Read shapes the SUT and helpers issue (post Cluster A #1/#4):
 *   from('workspaces').select(..).eq(..).maybeSingle().then(r => r.data)
 *   from('workspace_roles').select(..).eq(..).eq(..)  [awaited / .then]
 *   from('lease_activity_log').insert(..)             [comment notif rows only]
 *
 * The SUT no longer reads or writes `leases` or `lease_approval_chain`; those
 * tables are intentionally NOT registered (see header) so a regression throws.
 */
function buildSupabase(opts: BuildOpts) {
  const writes: WriteRecord[] = [];
  const invokeMock = vi.fn(() =>
    Promise.resolve({ data: opts.chainResult, error: opts.chainError }),
  );

  // workspace_roles is queried by BOTH the SUT (for hasManager/hasFinancial
  // counts) and by notifyRoleHolders (for recipient ids). The query carries an
  // .eq('role', <role>); we capture it so the builder can return the right rows.
  function workspaceRolesBuilder() {
    let role: string | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn((col: string, val: string) => {
      if (col === 'role') role = val;
      return builder;
    });
    const resolve = () => {
      const data =
        role === 'manager_approver'
          ? opts.managerApprovers
          : role === 'financial_approver'
            ? opts.financialApprovers
            : [];
      return { data, error: null };
    };
    (builder as { then: unknown }).then = (
      res: (v: unknown) => unknown,
      rej?: (e: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(res, rej);
    return builder;
  }

  function workspacesBuilder() {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve({ data: { approval_threshold: opts.approvalThreshold }, error: null }),
    );
    return builder;
  }

  function activityLogBuilder() {
    const builder: Record<string, unknown> = {};
    builder.insert = vi.fn((payload: unknown) => {
      writes.push({ table: 'lease_activity_log', op: 'insert', payload });
      return Promise.resolve({ data: null, error: null });
    });
    return builder;
  }

  const from = vi.fn((table: string) => {
    switch (table) {
      case 'workspaces':
        return workspacesBuilder();
      case 'workspace_roles':
        return workspaceRolesBuilder();
      case 'lease_activity_log':
        return activityLogBuilder();
      // 'leases' and 'lease_approval_chain' are intentionally absent — the
      // client no longer flips lifecycle_status or reads the chain directly.
      default:
        throw new Error(`unexpected table in test: ${table}`);
    }
  });

  const supabase = { from, functions: { invoke: invokeMock } };
  return { supabase, writes, invokeMock };
}

const baseLease: RetryRoutingLease = {
  id: 'lease-c2',
  calc_total_commitment: 100_000,
  covenant_flagged: false,
  request_title: 'Forklift lease',
};

// Helpers to pull recorded writes by kind.
const leaseUpdates = (writes: WriteRecord[]) =>
  writes.filter((w) => w.table === 'leases' && w.op === 'update');
const statusChangeInserts = (writes: WriteRecord[]) =>
  writes.filter(
    (w) =>
      w.table === 'lease_activity_log' &&
      w.op === 'insert' &&
      (w.payload as Record<string, unknown>).activity_type === 'status_change',
  );
const commentInserts = (writes: WriteRecord[]) =>
  writes.filter(
    (w) =>
      w.table === 'lease_activity_log' &&
      w.op === 'insert' &&
      (w.payload as Record<string, unknown>).activity_type === 'comment',
  );

beforeEach(() => {
  singletonInsertMock.mockClear();
});

// ─── 1. leave_draft outcome — NOTHING is written ──────────────────────────
//
// When resolve-approval-chain returns ok:false (or a network error), the
// decision is 'leave_draft'. The retry returns { ok:false, errorMessage } and
// touches nothing: no notifications, no lease_notifications insert. (It never
// could flip lifecycle anyway — that's server-side now — but a failed retry
// must also not fire spurious notifications.)

describe('retryRequestRouting — leave_draft (resolver failure)', () => {
  it('returns ok:false with the resolver error and fires NO writes', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [{ user_id: 'm1' }],
      financialApprovers: [],
      chainResult: {
        ok: false,
        error: 'Multiple policies tied at top priority. Ask an admin to disambiguate.',
        reason: 'ambiguous_match',
      },
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(false);
    // strictNullChecks is off in this project, so a boolean discriminant doesn't
    // narrow — use the `in` operator (works regardless of strict mode).
    expect('errorMessage' in res ? res.errorMessage : undefined).toContain('Multiple policies');

    // No writes anywhere — and crucially no client lifecycle flip.
    expect(writes).toHaveLength(0);
    expect(leaseUpdates(writes)).toHaveLength(0);
    expect(statusChangeInserts(writes)).toHaveLength(0);
    expect(singletonInsertMock).not.toHaveBeenCalled();
  });

  it('also leaves the lease untouched on a network error (null result + chainError)', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [{ user_id: 'm1' }],
      financialApprovers: [],
      chainResult: null,
      chainError: { message: 'Failed to fetch' },
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(false);
    expect('errorMessage' in res ? res.errorMessage : undefined).toBe('Failed to fetch');
    expect(writes).toHaveLength(0);
    expect(singletonInsertMock).not.toHaveBeenCalled();
  });
});

// ─── 2. legacy proceed → submitted (manager required) ─────────────────────
//
// The edge function applied the flip server-side and returned finalStatus +
// requiresManagerApproval. The CLIENT must:
//   - make NO leases UPDATE (the flip is server-side)              ← regression guard
//   - write NO status_change row (the server wrote it)            ← regression guard
//   - notify manager_approver (because finalStatus==='submitted' and manager required)
//   - createLeaseNotification
//   - return finalStatus from the edge response

describe('retryRequestRouting — legacy proceed → submitted (manager required)', () => {
  it('notifies manager_approver, makes NO client lifecycle flip, writes NO status_change row', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [{ user_id: 'm1' }, { user_id: 'm2' }],
      financialApprovers: [], // no financial approvers → financial not required
      chainResult: {
        ok: true,
        legacyFallback: true,
        message: 'No policies',
        finalStatus: 'submitted',
        requiresManagerApproval: true,
        requiresFinancialApproval: false,
      } as unknown as ChainResult,
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    // finalStatus is read from the edge response, not computed by the client.
    expect(res.finalStatus).toBe('submitted');

    // REGRESSION GUARD: client makes no leases UPDATE and writes no status_change row.
    expect(leaseUpdates(writes)).toHaveLength(0);
    expect(statusChangeInserts(writes)).toHaveLength(0);

    // notifyRoleHolders('manager_approver') writes a comment-typed activity row
    // with the two manager recipient ids.
    const notifyRow = commentInserts(writes).find(
      (w) =>
        ((w.payload as Record<string, unknown>).details as Record<string, unknown>)
          .notification_type === 'notify_manager_approver',
    );
    expect(notifyRow, 'manager notification row').toBeTruthy();
    const notifyDetails = (notifyRow!.payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(notifyDetails.recipient_ids).toEqual(['m1', 'm2']);

    // createLeaseNotification fired on the singleton client.
    expect(singletonInsertMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. legacy proceed → approved (auto-approve, no approvers) ────────────
//
// finalStatus==='approved' (server auto-approved). No role to notify; the
// only side effect the client has is createLeaseNotification. No flip, no
// status_change row.

describe('retryRequestRouting — legacy proceed → approved (auto-approve)', () => {
  it('makes no flip, writes no status_change row, fires NO role-notification, still createLeaseNotification', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [], // no managers
      financialApprovers: [], // no financial approvers → both false → approved
      chainResult: {
        ok: true,
        legacyFallback: true,
        message: 'No policies',
        finalStatus: 'approved',
        requiresManagerApproval: false,
        requiresFinancialApproval: false,
      } as unknown as ChainResult,
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(res.finalStatus).toBe('approved');

    // REGRESSION GUARD: no client lifecycle write, no status_change row.
    expect(leaseUpdates(writes)).toHaveLength(0);
    expect(statusChangeInserts(writes)).toHaveLength(0);

    // No 'comment' (role-notification) row — nobody to notify on auto-approve.
    expect(commentInserts(writes)).toHaveLength(0);

    // The lease-level notification still fires.
    expect(singletonInsertMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. chain proceed ─────────────────────────────────────────────────────
//
// Policy matched. Edge function created the chain, flipped to
// concept_submitted server-side, and returned targetLifecycleStatus +
// finalStatus + firstStepAssignees. The CLIENT only notifies the first-step
// assignees and createLeaseNotification — NO flip, NO status_change row.

describe('retryRequestRouting — chain proceed', () => {
  it('reads finalStatus from the edge response, notifies chain assignees, makes NO client flip/log', async () => {
    const chainSuccess = {
      ok: true,
      legacyFallback: false,
      policyId: 'pol-9',
      policyVersion: 3,
      policyName: 'Equipment >$50k',
      stepsCreated: 2,
      firstStepAssignees: [
        { userId: 'assignee-1', role: null },
        { userId: null, role: 'manager_approver' },
      ],
      targetLifecycleStatus: 'concept_submitted',
      finalStatus: 'concept_submitted',
    } as unknown as ChainResult;
    const { supabase, writes } = buildSupabase({
      approvalThreshold: 50_000,
      managerApprovers: [{ user_id: 'mgr-A' }],
      financialApprovers: [{ user_id: 'fin-A' }],
      chainResult: chainSuccess,
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(res.finalStatus).toBe('concept_submitted');

    // REGRESSION GUARD: no client lifecycle write, no status_change row.
    expect(leaseUpdates(writes)).toHaveLength(0);
    expect(statusChangeInserts(writes)).toHaveLength(0);

    // notifyChainAssignees: direct-user assignee → notify_chain_step_users;
    // role assignee → notify_manager_approver (via notifyRoleHolders).
    const directRow = commentInserts(writes).find(
      (w) =>
        ((w.payload as Record<string, unknown>).details as Record<string, unknown>)
          .notification_type === 'notify_chain_step_users',
    );
    expect(directRow, 'direct chain-step notification').toBeTruthy();
    expect(
      ((directRow!.payload as Record<string, unknown>).details as Record<string, unknown>).recipient_ids,
    ).toEqual(['assignee-1']);

    const roleRow = commentInserts(writes).find(
      (w) =>
        ((w.payload as Record<string, unknown>).details as Record<string, unknown>)
          .notification_type === 'notify_manager_approver',
    );
    expect(roleRow, 'role-based chain assignee notification').toBeTruthy();
    expect(
      ((roleRow!.payload as Record<string, unknown>).details as Record<string, unknown>).recipient_ids,
    ).toEqual(['mgr-A']);

    // createLeaseNotification fired.
    expect(singletonInsertMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 5. alreadyResolved replay recovery (audit C2 CRITICAL / Cluster A #1/#4)
//
// If a chain was already written on a prior attempt but the lease never left
// 'draft' (the original browser flip was rejected by the governance trigger or
// interrupted), resolve-approval-chain's idempotent branch now performs the
// draft → concept_submitted flip AND its status_change log SERVER-SIDE, and
// returns { alreadyResolved:true, recovered, finalStatus, firstStepAssignees }.
//
// The client must:
//   - make NO leases UPDATE (server already flipped)               ← regression guard
//   - notify firstStepAssignees + createLeaseNotification, but ONLY when this
//     call actually advanced the lease (recovered:true)
//   - on recovered:false (a prior call already advanced it): a clean no-op
//     success — no notifications, no lease_notifications — so a repeated manual
//     retry doesn't duplicate notifications.
//   - return finalStatus from the response.

describe('retryRequestRouting — alreadyResolved replay recovery', () => {
  it('recovered:true → notifies firstStepAssignees, makes NO client flip, returns finalStatus', async () => {
    const alreadyResolved = {
      ok: true,
      alreadyResolved: true,
      recovered: true,
      finalStatus: 'concept_submitted',
      firstStepAssignees: [{ userId: 'u-approver', role: null }],
      message: 'Chain already exists for this lease',
    } as unknown as ChainResult;

    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [],
      financialApprovers: [],
      chainResult: alreadyResolved,
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    expect('finalStatus' in res ? res.finalStatus : undefined).toBe('concept_submitted');

    // REGRESSION GUARD: client never flips lifecycle and never writes status_change.
    expect(leaseUpdates(writes)).toHaveLength(0);
    expect(statusChangeInserts(writes)).toHaveLength(0);

    // The first-step direct user is notified, via notify_chain_step_users.
    const notifs = commentInserts(writes);
    expect(notifs).toHaveLength(1);
    const np = (notifs[0].payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(np.notification_type).toBe('notify_chain_step_users');
    expect(np.recipient_ids).toEqual(['u-approver']);

    // createLeaseNotification fired.
    expect(singletonInsertMock).toHaveBeenCalledTimes(1);
  });

  it('recovered:false → clean no-op success (a prior call already advanced the lease)', async () => {
    const alreadyResolvedNoOp = {
      ok: true,
      alreadyResolved: true,
      recovered: false,
      finalStatus: 'concept_submitted',
      firstStepAssignees: [{ userId: 'u-approver', role: null }],
      message: 'Chain already exists for this lease',
    } as unknown as ChainResult;

    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [],
      financialApprovers: [],
      chainResult: alreadyResolvedNoOp,
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    expect('finalStatus' in res ? res.finalStatus : undefined).toBe('concept_submitted');
    // Pure no-op: no flip, no notify, no log, no lease_notifications.
    expect(writes).toHaveLength(0);
    expect(singletonInsertMock).not.toHaveBeenCalled();
  });
});
