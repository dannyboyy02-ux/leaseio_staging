import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #109 — approval-notification delivery (the dead nudge + the
// whole write-only notification system). Edge functions are Deno (not
// vitest-runnable), so these are static guards on the load-bearing invariants.

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('#109 migration — notification_deliveries', () => {
  const dir = join(root, 'supabase/migrations');
  const file = readdirSync(dir).filter((f) => f.includes('notification_deliveries')).sort().pop()!;
  const sql = readFileSync(join(dir, file), 'utf8');
  it('creates the delivery/idempotency table keyed on (row, recipient, channel)', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.notification_deliveries');
    expect(sql).toContain('UNIQUE (activity_log_id, recipient_user_id, channel)');
  });
  it('enables RLS with no client policy (service-role-only, deny-all)', () => {
    expect(sql).toContain('ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY');
    expect(sql).not.toContain('CREATE POLICY');
  });
});

describe('_shared/notify_dispatch.ts — idempotent, failure-recorded delivery', () => {
  const src = fn('supabase/functions/_shared/notify_dispatch.ts');
  it('skips a recipient already delivered (prior status sent)', () => {
    expect(src).toContain('notification_deliveries');
    expect(src).toContain('=== "sent"');
    expect(src).toContain('out.skipped++');
  });
  it('records failures + upserts on the unique key (rule #9, retry-safe)', () => {
    expect(src).toContain('status = "failed"');
    expect(src).toContain('onConflict: "activity_log_id,recipient_user_id,channel"');
  });
  it('gates on workspace liveness (never emails for canceled/vault workspaces)', () => {
    expect(src).toContain('checkWorkspaceLive');
    expect(src).toContain('if (!liveness.live) return out');
  });
  it('gives counter-sig + delegation/execution/signator types specific email copy (not the generic "Lease update")', () => {
    // Non-notify_ types previously fell to the "Lease update — LeaseIO" default.
    expect(src).toContain('case "counter_signature_reminder":');
    expect(src).toContain('a lease is awaiting counter-signature');
    expect(src).toContain('case "signator_review_required":');
    expect(src).toContain('case "execution_owner_assigned":');
    expect(src).toContain('case "voluntary_delegation_received":');
    expect(src).toContain('case "stuck_chain_detected":');
  });

  // Phase B: a rejected governed change set notifies the SUBMITTER. Its copy
  // must report the decline outcome, not fall through to the generic
  // "notify_*" → "awaiting your approval" approver prompt. copyForType is a
  // module-private Deno function (not exported, imports Deno-only deps), so
  // this is a static guard scoped to the case block — same convention as the
  // copy assertions above. The narrowed window avoids false positives from
  // the generic fallback string elsewhere in the switch.
  it('gives notify_change_set_rejected the decline copy, NOT the generic approval-prompt fallback', () => {
    const caseStart = src.indexOf('case "notify_change_set_rejected":');
    expect(caseStart).toBeGreaterThan(-1);
    // Window = this case's return line only (up to the next case/blank line).
    const block = src.slice(caseStart, src.indexOf('\n', src.indexOf('return', caseStart)) + 1);
    expect(block).toContain('Your proposed lease changes were declined'); // subject
    expect(block).toContain('Your proposed changes were declined'); // heading
    // It must NOT resolve to the generic approver fallback.
    expect(block).not.toContain('A lease is awaiting your approval');
    expect(block).not.toContain('A lease needs your approval');
  });
});

describe('dispatch-notifications cron', () => {
  const src = fn('supabase/functions/dispatch-notifications/index.ts');
  it('is x-cron-secret gated, fail-closed', () => {
    expect(src).toContain('NOTIFICATION_DISPATCH_CRON_SECRET');
    expect(src).toContain('x-cron-secret');
    expect(src).toContain('status: 401');
  });
  it('sweeps recent comment rows with recipient_ids and dispatches them', () => {
    expect(src).toContain('.eq("activity_type", "comment")');
    expect(src).toContain('recipient_ids');
    expect(src).toContain('dispatchNotificationRow');
  });
});

describe('send-nudge edge fn', () => {
  const src = fn('supabase/functions/send-nudge/index.ts');
  it('requires Bearer auth + submitter-or-admin authorization', () => {
    expect(src).toContain('auth.getUser(token)');
    expect(src).toContain('not_authorized');
  });
  it('enforces a server-side cooldown', () => {
    expect(src).toContain('COOLDOWN_MINUTES');
    expect(src).toContain('reason: "cooldown"');
    expect(src).toContain('retryAfterSeconds');
  });
  it('resolves pending approvers (chain + role fallback) and never nudges self', () => {
    expect(src).toContain('.eq("status", "pending")');
    expect(src).toContain('.eq("is_required", true)');
    expect(src).toContain('effective_assignee_user_id');
    expect(src).toContain('workspace_roles');
    expect(src).toContain('recipientSet.delete(user.id)');
  });
  it('records the notification + nudge + last_nudged_at and dispatches immediately', () => {
    expect(src).toContain('activity_type: "comment"');
    expect(src).toContain('notification_type: "approver_nudge"');
    expect(src).toContain('lease_nudges');
    expect(src).toContain('last_nudged_at');
    expect(src).toContain('dispatchNotificationRow');
  });
});

describe('#109 function registration (config.toml)', () => {
  const toml = fn('supabase/config.toml');
  it('registers send-nudge (JWT) + dispatch-notifications (cron, no JWT)', () => {
    expect(toml).toContain('[functions.send-nudge]');
    expect(toml).toContain('[functions.dispatch-notifications]');
    // The cron dispatcher MUST be verify_jwt=false to accept the cron-secret header.
    const block = toml.slice(toml.indexOf('[functions.dispatch-notifications]'), toml.indexOf('[functions.dispatch-notifications]') + 90);
    expect(block).toContain('verify_jwt = false');
  });
});
