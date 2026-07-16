-- #18 — capture the lease-reports storage-RLS fix into the repo (2026-07-16).
--
-- The original 20260516120001_storage_policies.sql wrote the lease-reports
-- INSERT/UPDATE/SELECT policies parsing `storage.foldername(w.name)` — the
-- WORKSPACE DISPLAY NAME — instead of the storage object's PATH. foldername()
-- of a name with no slash returns a 1-element array, so `[2]` is NULL and the
-- predicate is never true → effectively WITH CHECK(false): report PDF upload was
-- blocked for every user, so the PDF download button stayed permanently disabled.
--
-- The correct policies (parsing `storage.foldername(objects.name)` on the OBJECT PATH,
-- which is `{workspace_id}/{report_id}/...`) were applied to the live DB
-- out-of-band and never captured in a migration — the repo drifted and could not
-- reproduce live schema (a Schema Change Rule violation). This migration makes
-- the repo faithful: it reproduces the LIVE policy definitions verbatim,
-- idempotently (DROP IF EXISTS + CREATE, atomic within the migration txn).
--
-- On a clean replay this runs AFTER 20260516120001 (broken) and leaves the
-- correct policies in place. On the live DB it recreates the already-correct
-- policies identically (no behavior change).

-- ── INSERT: report owners can upload the PDF into {workspace_id}/{report_id}/ ──
DROP POLICY IF EXISTS "report owners insert lease-reports" ON "storage"."objects";
CREATE POLICY "report owners insert lease-reports"
  ON "storage"."objects" FOR INSERT TO "authenticated"
  WITH CHECK (
    (bucket_id = 'lease-reports'::text) AND (EXISTS (
      SELECT 1
      FROM ((lease_reports lr
        LEFT JOIN workspaces w ON ((w.id = lr.workspace_id)))
        LEFT JOIN workspace_members wm ON (((wm.workspace_id = lr.workspace_id) AND (wm.user_id = auth.uid()))))
      WHERE (
        ((lr.id)::text = (storage.foldername(objects.name))[2])
        AND ((lr.workspace_id)::text = (storage.foldername(objects.name))[1])
        AND (lr.pdf_storage_path IS NULL)
        AND ((lr.generated_by = auth.uid()) OR (w.owner_id = auth.uid()) OR (wm.role = 'admin'::workspace_role))
      )
    ))
  );

-- ── UPDATE: same predicate on USING + WITH CHECK ──
DROP POLICY IF EXISTS "report owners update lease-reports" ON "storage"."objects";
CREATE POLICY "report owners update lease-reports"
  ON "storage"."objects" FOR UPDATE TO "authenticated"
  USING (
    (bucket_id = 'lease-reports'::text) AND (EXISTS (
      SELECT 1
      FROM ((lease_reports lr
        LEFT JOIN workspaces w ON ((w.id = lr.workspace_id)))
        LEFT JOIN workspace_members wm ON (((wm.workspace_id = lr.workspace_id) AND (wm.user_id = auth.uid()))))
      WHERE (
        ((lr.id)::text = (storage.foldername(objects.name))[2])
        AND ((lr.workspace_id)::text = (storage.foldername(objects.name))[1])
        AND (lr.pdf_storage_path IS NULL)
        AND ((lr.generated_by = auth.uid()) OR (w.owner_id = auth.uid()) OR (wm.role = 'admin'::workspace_role))
      )
    ))
  )
  WITH CHECK (
    (bucket_id = 'lease-reports'::text) AND (EXISTS (
      SELECT 1
      FROM ((lease_reports lr
        LEFT JOIN workspaces w ON ((w.id = lr.workspace_id)))
        LEFT JOIN workspace_members wm ON (((wm.workspace_id = lr.workspace_id) AND (wm.user_id = auth.uid()))))
      WHERE (
        ((lr.id)::text = (storage.foldername(objects.name))[2])
        AND ((lr.workspace_id)::text = (storage.foldername(objects.name))[1])
        AND (lr.pdf_storage_path IS NULL)
        AND ((lr.generated_by = auth.uid()) OR (w.owner_id = auth.uid()) OR (wm.role = 'admin'::workspace_role))
      )
    ))
  );

-- ── SELECT: workspace members / owners can read their reports' resolved paths ──
DROP POLICY IF EXISTS "workspace members read lease-reports" ON "storage"."objects";
CREATE POLICY "workspace members read lease-reports"
  ON "storage"."objects" FOR SELECT TO "authenticated"
  USING (
    (bucket_id = 'lease-reports'::text) AND (EXISTS (
      SELECT 1
      FROM lease_reports lr
      WHERE (
        ((lr.pdf_storage_path = objects.name) OR (lr.json_storage_path = objects.name))
        AND (lr.status <> 'expired'::text)
        AND ((lr.expires_at IS NULL) OR (lr.expires_at > now()))
        AND (
          (lr.workspace_id IN (SELECT workspace_members.workspace_id FROM workspace_members WHERE (workspace_members.user_id = auth.uid())))
          OR (lr.workspace_id IN (SELECT workspaces.id FROM workspaces WHERE (workspaces.owner_id = auth.uid())))
        )
      )
    ))
  );
