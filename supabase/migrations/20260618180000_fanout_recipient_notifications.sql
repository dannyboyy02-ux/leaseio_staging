-- Notification-rail fanout (follow-on from KNOWN_ISSUES #111 C6c review).
--
-- THE GAP: ~17 code paths (approval-chain, delegation, counter-signature,
-- execution-owner, escalation, stuck-chain) signal an in-app notification by
-- writing a lease_activity_log row with activity_type='comment', user_id=null,
-- and details.{notification_type, recipient_ids, message}. But NOTHING reads
-- recipient_ids — no fanout, no cron, no UI surface — so every one of those
-- targeted notifications reached no one. (The real in-app rail is the
-- `notifications` table, which Notifications.tsx reads, but only process-alerts
-- ever wrote it.)
--
-- THE FIX (chosen approach B, in-app only): an AFTER INSERT trigger that fans a
-- comment+recipient_ids row out into one `notifications` row per recipient — the
-- exact schema the UI already renders (per-user, per-workspace, read_at). One
-- central fix instead of editing 17 writers (which is how the gap arose).
--
-- Design guarantees:
--   * BEST-EFFORT: the fanout runs in a BEGIN/EXCEPTION block and swallows any
--     error — a notification-fanout failure must NEVER abort the parent
--     lease_activity_log (audit) insert.
--   * SECURITY DEFINER (owner postgres) so it can write `notifications`
--     regardless of the inserting client's RLS; it still RESPECTS the Vault
--     intent by skipping non-live workspaces (is_workspace_live), mirroring the
--     dispatch functions.
--   * Idempotent by construction: fires once per insert (no cron re-sweep).
--   * NOT backfilled: only NEW comment rows fan out; historical dead rows stay
--     as-is (backfilling would spam users with stale notifications).
--
-- Scope notes (filed as follow-ons, NOT addressed here): EMAIL delivery of these
-- notifications (notifications is in-app only); and send-counter-signature-
-- reminder sends no email despite its name.

CREATE OR REPLACE FUNCTION public.fanout_recipient_notifications()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_workspace_id uuid;
  v_alert_type   text;
  v_message      text;
  v_recipient    uuid;
BEGIN
  -- Never let a fanout failure roll back the audit-log insert.
  BEGIN
    -- recipient_ids must be a JSON array; otherwise nothing to fan.
    IF jsonb_typeof(NEW.details -> 'recipient_ids') IS DISTINCT FROM 'array' THEN
      RETURN NEW;
    END IF;

    -- notifications.workspace_id is NOT NULL — resolve it from the lease.
    SELECT l.workspace_id INTO v_workspace_id
    FROM public.leases l
    WHERE l.id = NEW.lease_id;
    IF v_workspace_id IS NULL THEN
      RETURN NEW;
    END IF;

    -- Don't notify into a grace/soft-deleted/vault (non-live) workspace,
    -- matching the dispatch functions' behavior.
    IF NOT public.is_workspace_live(v_workspace_id) THEN
      RETURN NEW;
    END IF;

    v_alert_type := COALESCE(NULLIF(NEW.details ->> 'notification_type', ''), 'notification');
    v_message := NEW.details ->> 'message';

    FOR v_recipient IN
      SELECT DISTINCT (elem #>> '{}')::uuid
      FROM jsonb_array_elements(NEW.details -> 'recipient_ids') AS elem
      WHERE (elem #>> '{}') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    LOOP
      INSERT INTO public.notifications (workspace_id, user_id, lease_id, alert_type, title, body)
      VALUES (
        v_workspace_id,
        v_recipient,
        NEW.lease_id,
        v_alert_type,
        COALESCE(NULLIF(v_message, ''), 'You have a new notification'),
        COALESCE(v_message, '')
      );
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fanout_recipient_notifications failed for lease_activity_log %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fanout_recipient_notifications() OWNER TO postgres;

COMMENT ON FUNCTION public.fanout_recipient_notifications() IS
  'Notification-rail fanout (post-#111-C6c): fans lease_activity_log comment+recipient_ids rows into per-recipient public.notifications rows (in-app rail the UI reads). Best-effort (never aborts the audit insert); skips non-live workspaces; not backfilled. 2026-06-18.';

DROP TRIGGER IF EXISTS fanout_recipient_notifications ON public.lease_activity_log;
CREATE TRIGGER fanout_recipient_notifications
  AFTER INSERT ON public.lease_activity_log
  FOR EACH ROW
  WHEN (NEW.activity_type = 'comment' AND NEW.details ? 'recipient_ids')
  EXECUTE FUNCTION public.fanout_recipient_notifications();
