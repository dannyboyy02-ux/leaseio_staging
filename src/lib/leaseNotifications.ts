import { supabase } from '@/integrations/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';

type LeaseNotificationEventType =
  | 'new_request'
  | 'status_changed'
  | 'document_uploaded'
  | 'expiration'
  | 'escalation'
  | 'renewal_window'
  | 'commencement'
  | 'custom';

interface CreateLeaseNotificationInput {
  leaseId: string;
  eventType: LeaseNotificationEventType;
  description: string;
  eventDate?: string;
}

export async function createLeaseNotification({
  leaseId,
  eventType,
  description,
  eventDate,
}: CreateLeaseNotificationInput) {
  const date = eventDate || new Date().toISOString().slice(0, 10);

  const { error } = await supabase.from('lease_notifications').insert({
    lease_id: leaseId,
    event_type: eventType,
    event_date: date,
    event_description: description,
    notify_days_before: [0],
    notify_email: true,
    is_confirmed: true,
  });

  if (error) {
    console.error('Failed to create lease notification:', error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Approval-routing notifications (Phase 2)
//
// `notifyRoleHolders` was previously an inline closure inside
// LeaseRequestForm.tsx (~line 213). Lifted here so both the legacy
// fallback path and the new chain-driven path can share it. Behavior
// unchanged from the original.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Look up everyone in `workspace_roles` with the given functional role
 * for the workspace, then write a `comment`-typed activity-log entry
 * with the recipient ids embedded in `details`. The downstream
 * notification fanout reads from `lease_activity_log` and dispatches.
 *
 * No-op when:
 *   - workspaceId is falsy
 *   - no users hold the requested role in this workspace
 */
export async function notifyRoleHolders(
  client: SupabaseClient,
  leaseId: string,
  workspaceId: string | null | undefined,
  role: string,
  message: string,
): Promise<void> {
  if (!workspaceId) return;
  const { data: roleRows } = await (client as any)
    .from('workspace_roles')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', role);
  const recipientIds = ((roleRows ?? []) as Array<{ user_id: string | null }>)
    .map((r) => r.user_id)
    .filter((id): id is string => Boolean(id));
  if (recipientIds.length === 0) return;
  await client.from('lease_activity_log').insert({
    lease_id: leaseId,
    user_id: null,
    activity_type: 'comment',
    details: {
      notification_type: `notify_${role}`,
      recipient_ids: recipientIds,
      message,
    },
  } as any);
}

/**
 * Phase 2 chain-driven notification. Walks the assignee list returned by
 * the resolve-approval-chain edge function and notifies each one — direct
 * users get a single per-step notification entry, role-based assignees
 * fan out via `notifyRoleHolders`.
 *
 * The shape of `assignees` matches resolve-approval-chain's
 * `firstStepAssignees` field: each entry has either a userId or a role,
 * not both.
 */
export async function notifyChainAssignees(
  client: SupabaseClient,
  leaseId: string,
  workspaceId: string | null | undefined,
  assignees: Array<{ userId: string | null; role: string | null }>,
  message: string,
): Promise<void> {
  if (!workspaceId || assignees.length === 0) return;

  // Direct-user assignees: collect ids, single activity-log entry.
  const directUserIds = assignees
    .map((a) => a.userId)
    .filter((id): id is string => Boolean(id));
  if (directUserIds.length > 0) {
    await client.from('lease_activity_log').insert({
      lease_id: leaseId,
      user_id: null,
      activity_type: 'comment',
      details: {
        notification_type: 'notify_chain_step_users',
        recipient_ids: directUserIds,
        message,
      },
    } as any);
  }

  // Role-based assignees: notifyRoleHolders for each unique role.
  const roles = Array.from(
    new Set(
      assignees
        .map((a) => a.role)
        .filter((r): r is string => Boolean(r)),
    ),
  );
  for (const role of roles) {
    await notifyRoleHolders(client, leaseId, workspaceId, role, message);
  }
}
