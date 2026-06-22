import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Regression coverage for audit-finding C2 — retry the approval-routing path
// for a request-workflow lease stranded in 'draft'.
//
// SUT: src/lib/retryRequestRouting.ts — retryRequestRouting(supabase, lease,
// workspaceId, userId). It recomputes approval requirements from the stored
// lease, invokes the idempotent resolve-approval-chain edge function, runs the
// pure decideSubmissionOutcome helper, and — only when the decision is
// 'proceed' — flips lifecycle_status, notifies the right approvers, writes the
// status_change activity log, and creates a lease notification.
//
// The pure DECISION logic (the four outcomes) is exhaustively covered in
// leaseSubmissionDecision.test.ts. THIS file pins the ORCHESTRATION the retry
// repeats inline: which writes fire (and which DON'T) per branch, the
// notification targets, and the Lifecycle Transition Convention shape of the
// activity-log row.
//
// Mocking approach (mirrors TransferOwnershipDialog.test.tsx's thenableBuilder
// + FailedLeaseBanner.test.tsx's functions.invoke stub):
//   * The `supabase` ARGUMENT is a hand-rolled PostgREST-ish chainable that is
//     itself thenable. We dispatch on table name and record every write.
//   * createLeaseNotification imports the SINGLETON supabase from
//     '@/integrations/supabase/client' (NOT the passed client), so we mock that
//     module too — both to stop the real createClient() from running and to
//     observe the notification insert.
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
  // Only consulted by the alreadyResolved-recovery path (completeExistingChainRouting):
  // the lease's current lifecycle_status (default 'draft') and the existing chain rows.
  currentLeaseStatus?: string;
  chainRows?: Array<{
    approver_user_id: string | null;
    approver_role: string | null;
    step_order: number;
    stage: string;
    is_required: boolean;
  }>;
}

/**
 * Build the chainable `supabase` argument the SUT (and its notify helpers)
 * drive, plus a `writes` array recording every update/insert across all tables.
 *
 * Read shapes the SUT and helpers issue:
 *   from('workspaces').select(..).eq(..).maybeSingle().then(r => r.data)
 *   from('workspace_roles').select(..).eq(..).eq(..)  [awaited / .then]
 *   from('leases').update(..).eq(..)                  [awaited]
 *   from('lease_activity_log').insert(..)             [awaited]
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

  function leasesBuilder() {
    const builder: Record<string, unknown> = {};
    builder.update = vi.fn((payload: unknown) => {
      // The update isn't recorded until .eq resolves the statement, but the
      // SUT always chains .eq(id) immediately; record on update and let .eq be
      // the thenable terminal.
      builder._pendingPayload = payload;
      builder._mode = 'update';
      return builder;
    });
    // Read shape used by the alreadyResolved-recovery path:
    // from('leases').select('lifecycle_status').eq('id', ..).maybeSingle()
    builder.select = vi.fn(() => {
      builder._mode = 'select';
      return builder;
    });
    builder.maybeSingle = vi.fn(() =>
      Promise.resolve({ data: { lifecycle_status: opts.currentLeaseStatus ?? 'draft' }, error: null }),
    );
    builder.eq = vi.fn(() => {
      if (builder._mode === 'select') {
        // Return the builder so .maybeSingle() can terminate the read.
        return builder;
      }
      writes.push({ table: 'leases', op: 'update', payload: builder._pendingPayload });
      return Promise.resolve({ data: null, error: null });
    });
    return builder;
  }

  function leaseApprovalChainBuilder() {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    // from('lease_approval_chain').select(..).eq('lease_id', ..) is awaited directly.
    builder.eq = vi.fn(() => Promise.resolve({ data: opts.chainRows ?? [], error: null }));
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
      case 'leases':
        return leasesBuilder();
      case 'lease_approval_chain':
        return leaseApprovalChainBuilder();
      case 'lease_activity_log':
        return activityLogBuilder();
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
const activityInserts = (writes: WriteRecord[]) =>
  writes.filter((w) => w.table === 'lease_activity_log' && w.op === 'insert');

beforeEach(() => {
  singletonInsertMock.mockClear();
});

// ─── 1. leave_draft outcome — NOTHING is written ──────────────────────────
//
// When resolve-approval-chain returns ok:false (or a network error), the
// decision is 'leave_draft'. The retry must return { ok:false, errorMessage }
// and touch nothing: no lifecycle flip, no notification activity row, no
// status_change log, no lease_notifications insert. Otherwise a failed retry
// could half-transition a lease (the exact half-state the draft contract
// exists to prevent).

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

    // No writes anywhere.
    expect(writes).toHaveLength(0);
    expect(leaseUpdates(writes)).toHaveLength(0);
    expect(activityInserts(writes)).toHaveLength(0);
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

describe('retryRequestRouting — legacy proceed → submitted (manager required)', () => {
  it('flips to submitted, notifies manager_approver, logs convention-shaped status_change, creates notification', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [{ user_id: 'm1' }, { user_id: 'm2' }],
      financialApprovers: [], // no financial approvers → financial not required
      chainResult: { ok: true, legacyFallback: true, message: 'No policies' },
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(res.finalStatus).toBe('submitted');

    // Lifecycle flip carries both lifecycle_status and status_changed_at.
    const updates = leaseUpdates(writes);
    expect(updates).toHaveLength(1);
    const payload = updates[0].payload as Record<string, unknown>;
    expect(payload.lifecycle_status).toBe('submitted');
    expect(typeof payload.status_changed_at).toBe('string');

    // notifyRoleHolders('manager_approver') writes a comment-typed activity row
    // with the two manager recipient ids.
    const inserts = activityInserts(writes);
    const notifyRow = inserts.find(
      (w) => (w.payload as Record<string, unknown>).activity_type === 'comment',
    );
    expect(notifyRow, 'manager notification row').toBeTruthy();
    const notifyDetails = (notifyRow!.payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(notifyDetails.notification_type).toBe('notify_manager_approver');
    expect(notifyDetails.recipient_ids).toEqual(['m1', 'm2']);

    // createLeaseNotification fired on the singleton client.
    expect(singletonInsertMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. legacy proceed → approved (auto-approve, no approvers) ────────────

describe('retryRequestRouting — legacy proceed → approved (auto-approve)', () => {
  it('flips to approved with details.auto_approved:true and NO role-notification row', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [], // no managers
      financialApprovers: [], // no financial approvers → both false → approved
      chainResult: { ok: true, legacyFallback: true, message: 'No policies' },
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');
    expect(res.finalStatus).toBe('approved');

    const updates = leaseUpdates(writes);
    expect(updates).toHaveLength(1);
    expect((updates[0].payload as Record<string, unknown>).lifecycle_status).toBe('approved');

    const inserts = activityInserts(writes);
    // No 'comment' (role-notification) row — nobody to notify on auto-approve.
    expect(inserts.find((w) => (w.payload as Record<string, unknown>).activity_type === 'comment')).toBeUndefined();

    // The single activity insert is the status_change log, and its details
    // mark auto_approved (legacy non-chain branch).
    const statusRow = inserts.find(
      (w) => (w.payload as Record<string, unknown>).activity_type === 'status_change',
    );
    expect(statusRow).toBeTruthy();
    const details = (statusRow!.payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.routing_path).toBe('legacy');
    expect(details.auto_approved).toBe(true);

    expect(singletonInsertMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. chain proceed ─────────────────────────────────────────────────────

describe('retryRequestRouting — chain proceed', () => {
  it('flips to the chain target, notifies chain assignees, logs policy metadata + routing_path:chain', async () => {
    const chainSuccess: ChainResult = {
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
    };
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

    const updates = leaseUpdates(writes);
    expect(updates).toHaveLength(1);
    expect((updates[0].payload as Record<string, unknown>).lifecycle_status).toBe('concept_submitted');

    const inserts = activityInserts(writes);

    // notifyChainAssignees: direct-user assignee → notify_chain_step_users;
    // role assignee → notify_manager_approver (via notifyRoleHolders).
    const directRow = inserts.find(
      (w) => (((w.payload as Record<string, unknown>).details as Record<string, unknown>) || {}).notification_type === 'notify_chain_step_users',
    );
    expect(directRow, 'direct chain-step notification').toBeTruthy();
    expect(
      ((directRow!.payload as Record<string, unknown>).details as Record<string, unknown>).recipient_ids,
    ).toEqual(['assignee-1']);

    const roleRow = inserts.find(
      (w) => (((w.payload as Record<string, unknown>).details as Record<string, unknown>) || {}).notification_type === 'notify_manager_approver',
    );
    expect(roleRow, 'role-based chain assignee notification').toBeTruthy();
    expect(
      ((roleRow!.payload as Record<string, unknown>).details as Record<string, unknown>).recipient_ids,
    ).toEqual(['mgr-A']);

    // status_change log carries the chain policy metadata + routing_path:chain.
    const statusRow = inserts.find(
      (w) => (w.payload as Record<string, unknown>).activity_type === 'status_change',
    );
    expect(statusRow).toBeTruthy();
    const details = (statusRow!.payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(details.routing_path).toBe('chain');
    expect(details.policy_id).toBe('pol-9');
    expect(details.policy_version).toBe(3);
    expect(details.policy_name).toBe('Equipment >$50k');
    expect(details.steps_created).toBe(2);
    // The chain branch does NOT stamp auto_approved.
    expect(details.auto_approved).toBeUndefined();

    expect(singletonInsertMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 5. Lifecycle Transition Convention assertion ─────────────────────────
//
// CLAUDE.md: every status transition writes a status_change row with BOTH the
// top-level from_status/to_status columns AND the equivalent fields in details,
// plus routing_path. The retry adds triggered_by:'routing_retry' so the audit
// trail distinguishes a retried route from a first-pass submission.

describe('retryRequestRouting — Lifecycle Transition Convention', () => {
  it('status_change row mirrors from/to at top level AND in details, with routing_path + triggered_by', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [{ user_id: 'm1' }],
      financialApprovers: [],
      chainResult: { ok: true, legacyFallback: true, message: 'No policies' },
      chainError: null,
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok:true');

    const statusRow = activityInserts(writes).find(
      (w) => (w.payload as Record<string, unknown>).activity_type === 'status_change',
    );
    expect(statusRow, 'a status_change row was written').toBeTruthy();
    const row = statusRow!.payload as Record<string, unknown>;

    // Identity / attribution.
    expect(row.lease_id).toBe(baseLease.id);
    expect(row.user_id).toBe(USER_ID);
    expect(row.activity_type).toBe('status_change');

    // Top-level convention columns.
    expect(row.from_status).toBe('draft');
    expect(row.to_status).toBe('submitted');

    // Mirrored details.
    const details = row.details as Record<string, unknown>;
    expect(details.from_status).toBe('draft');
    expect(details.to_status).toBe('submitted');
    expect(details.routing_path).toBe('legacy');
    expect(details.triggered_by).toBe('routing_retry');
  });
});

// ─── 6. alreadyResolved replay recovery (audit C2 CRITICAL) ───────────────
//
// If a chain was already written on a prior attempt but the lease never left
// 'draft' (the flip was interrupted), resolve-approval-chain short-circuits with
// a bare { ok:true, alreadyResolved:true }. The retry must NOT feed that to the
// normal chain branch (which would fabricate finalStatus:'submitted' and call
// notifyChainAssignees(undefined) → TypeError, mis-statusing + skipping the log).
// It must complete the routing from the EXISTING chain rows: flip to
// 'concept_submitted', notify the real first step, and write a convention-shaped
// status_change log.

describe('retryRequestRouting — alreadyResolved replay recovery', () => {
  const alreadyResolved = { ok: true, alreadyResolved: true, message: 'Chain already exists for this lease' } as unknown as ChainResult;

  it('completes routing from the existing chain (flips to concept_submitted, never fabricates submitted)', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [],
      financialApprovers: [],
      chainResult: alreadyResolved,
      chainError: null,
      currentLeaseStatus: 'draft',
      chainRows: [
        // First step (lowest step_order) is a direct user; a later role step must NOT be treated as first.
        { approver_user_id: 'u-approver', approver_role: null, step_order: 1, stage: 'concept', is_required: true },
        { approver_user_id: null, approver_role: 'manager_approver', step_order: 2, stage: 'concept', is_required: true },
      ],
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    expect('finalStatus' in res ? res.finalStatus : undefined).toBe('concept_submitted');

    // Flips to the chain destination, NOT the fabricated 'submitted'.
    const flips = leaseUpdates(writes);
    expect(flips).toHaveLength(1);
    expect((flips[0].payload as Record<string, unknown>).lifecycle_status).toBe('concept_submitted');

    // Convention-shaped status_change log on the chain path.
    const statusRows = activityInserts(writes).filter(
      (w) => (w.payload as Record<string, unknown>).activity_type === 'status_change',
    );
    expect(statusRows).toHaveLength(1);
    const d = statusRows[0].payload as Record<string, unknown>;
    expect(d.from_status).toBe('draft');
    expect(d.to_status).toBe('concept_submitted');
    const details = d.details as Record<string, unknown>;
    expect(details.from_status).toBe('draft');
    expect(details.to_status).toBe('concept_submitted');
    expect(details.routing_path).toBe('chain');
    expect(details.already_resolved).toBe(true);
    expect(details.triggered_by).toBe('routing_retry');

    // Only the first-step (step_order 1) direct user is notified, via notify_chain_step_users.
    const notifs = activityInserts(writes).filter(
      (w) => (w.payload as Record<string, unknown>).activity_type === 'comment',
    );
    expect(notifs).toHaveLength(1);
    const np = (notifs[0].payload as Record<string, unknown>).details as Record<string, unknown>;
    expect(np.notification_type).toBe('notify_chain_step_users');
    expect(np.recipient_ids).toEqual(['u-approver']);

    // createLeaseNotification fired.
    expect(singletonInsertMock).toHaveBeenCalled();
  });

  it('is a no-op success when a prior attempt already advanced the lease out of draft', async () => {
    const { supabase, writes } = buildSupabase({
      approvalThreshold: null,
      managerApprovers: [],
      financialApprovers: [],
      chainResult: alreadyResolved,
      chainError: null,
      currentLeaseStatus: 'concept_submitted',
    });

    const res = await retryRequestRouting(supabase as never, baseLease, WORKSPACE_ID, USER_ID);

    expect(res.ok).toBe(true);
    expect('finalStatus' in res ? res.finalStatus : undefined).toBe('concept_submitted');
    // Pure no-op: no flip, no notify, no log, no lease_notifications.
    expect(writes).toHaveLength(0);
    expect(singletonInsertMock).not.toHaveBeenCalled();
  });
});
