import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Notification-rail fanout (follow-on from #111 C6c review). Static guards over
// the trigger that fans lease_activity_log comment+recipient_ids rows into
// per-recipient public.notifications rows (the in-app rail the UI reads).

const root = process.cwd();
const dir = join(root, 'supabase/migrations');
const file = readdirSync(dir)
  .filter((f) => f.includes('fanout_recipient_notifications'))
  .sort()
  .pop()!;
const sql = readFileSync(join(dir, file), 'utf8');

describe('notification fanout trigger migration', () => {
  it('defines a SECURITY DEFINER function owned by postgres with a pinned search_path', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fanout_recipient_notifications()');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_catalog');
    expect(sql).toContain('ALTER FUNCTION public.fanout_recipient_notifications() OWNER TO postgres');
  });

  it('fires AFTER INSERT on lease_activity_log only for comment rows carrying recipient_ids (idempotent)', () => {
    expect(sql).toContain('AFTER INSERT ON public.lease_activity_log');
    expect(sql).toMatch(/WHEN \(NEW\.activity_type = 'comment' AND NEW\.details \? 'recipient_ids'\)/);
    expect(sql).toContain('DROP TRIGGER IF EXISTS fanout_recipient_notifications ON public.lease_activity_log');
  });

  it('fans one notifications row per recipient, resolving workspace_id from the lease', () => {
    expect(sql).toContain('FROM public.leases l');
    expect(sql).toContain('jsonb_array_elements(NEW.details -> \'recipient_ids\')');
    expect(sql).toContain('INSERT INTO public.notifications (workspace_id, user_id, lease_id, alert_type, title, body)');
    // alert_type/title/body are NOT NULL — all defaulted.
    expect(sql).toContain("COALESCE(NULLIF(NEW.details ->> 'notification_type', ''), 'notification')");
    expect(sql).toContain("'You have a new notification'");
  });

  it('is best-effort (never aborts the audit insert) and respects Vault non-live workspaces', () => {
    expect(sql).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(sql).toContain('RAISE WARNING');
    expect(sql).toContain('IF NOT public.is_workspace_live(v_workspace_id) THEN');
    expect(sql).toContain('RETURN NEW;');
  });

  it('guards against a non-array recipient_ids + malformed uuids', () => {
    expect(sql).toContain("jsonb_typeof(NEW.details -> 'recipient_ids') IS DISTINCT FROM 'array'");
    expect(sql).toMatch(/\^\[0-9a-fA-F\]\{8\}-/);
  });

  it('fans only to genuine workspace members (firm-aware), regex-before-cast', () => {
    expect(sql).toContain('public.is_workspace_member(v_workspace_id, v.rid)');
    // The cast lives in the inner subquery, gated by the regex WHERE, so a
    // malformed id is filtered before ::uuid runs.
    expect(sql).toMatch(/SELECT \(elem #>> '\{\}'\)::uuid AS rid[\s\S]*?WHERE \(elem #>> '\{\}'\) ~/);
  });
});
