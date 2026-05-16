-- Storage RLS policies for LeaseIO buckets.
--
-- Baseline-companion migration (P1-10 remediation, 2026-05-16).
-- The baseline at 20260516120000_baseline_schema.sql captures the public schema
-- only. The storage schema is platform-owned by Supabase and cannot be modified
-- by the migration runner role. The only storage things this app owns are the
-- RLS policies below, which gate the four LeaseIO buckets:
--   - leases             (raw lease document uploads, owned by uploader)
--   - executed-leases    (signed PDFs)
--   - lease-documents    (workspace-shared documents, admin-managed)
--   - lease-reports      (generated ASC 842 disclosure exports)
--
-- DROP POLICY IF EXISTS is paired with each CREATE POLICY so the file is
-- idempotent against environments that already have these policies installed
-- (production, where the legacy migrations created them; local stacks that
-- have been reset; CI).

-- ---------- bucket: leases ----------

DROP POLICY IF EXISTS "Users and workspace members can view lease files" ON "storage"."objects";
CREATE POLICY "Users and workspace members can view lease files" ON "storage"."objects" FOR SELECT USING ((("bucket_id" = 'leases'::"text") AND ((("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text") OR (EXISTS ( SELECT 1
   FROM "public"."leases"
  WHERE (("leases"."storage_path" = "objects"."name") AND ("leases"."workspace_id" IS NOT NULL) AND "public"."is_workspace_member"("leases"."workspace_id", "auth"."uid"())))))));

DROP POLICY IF EXISTS "Users can delete own lease files" ON "storage"."objects";
CREATE POLICY "Users can delete own lease files" ON "storage"."objects" FOR DELETE USING ((("bucket_id" = 'leases'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));

DROP POLICY IF EXISTS "Users can update own lease files" ON "storage"."objects";
CREATE POLICY "Users can update own lease files" ON "storage"."objects" FOR UPDATE USING ((("bucket_id" = 'leases'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));

DROP POLICY IF EXISTS "Users can upload own lease files" ON "storage"."objects";
CREATE POLICY "Users can upload own lease files" ON "storage"."objects" FOR INSERT WITH CHECK ((("bucket_id" = 'leases'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));

-- ---------- bucket: lease-documents ----------

DROP POLICY IF EXISTS "admins delete from lease-documents" ON "storage"."objects";
CREATE POLICY "admins delete from lease-documents" ON "storage"."objects" FOR DELETE USING ((("bucket_id" = 'lease-documents'::"text") AND ((("storage"."foldername"("name"))[1])::"uuid" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role"))))));

DROP POLICY IF EXISTS "workspace members read lease-documents" ON "storage"."objects";
CREATE POLICY "workspace members read lease-documents" ON "storage"."objects" FOR SELECT USING ((("bucket_id" = 'lease-documents'::"text") AND ((("storage"."foldername"("name"))[1])::"uuid" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())))));

DROP POLICY IF EXISTS "workspace members upload to lease-documents" ON "storage"."objects";
CREATE POLICY "workspace members upload to lease-documents" ON "storage"."objects" FOR INSERT WITH CHECK ((("bucket_id" = 'lease-documents'::"text") AND ("owner" = "auth"."uid"()) AND ((("storage"."foldername"("name"))[1])::"uuid" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = ANY (ARRAY['admin'::"public"."workspace_role", 'editor'::"public"."workspace_role"])))
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())))));

-- ---------- bucket: executed-leases ----------

DROP POLICY IF EXISTS "executed_leases_delete" ON "storage"."objects";
CREATE POLICY "executed_leases_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'executed-leases'::"text") AND ((("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text") OR (EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."executed_storage_path" = "objects"."name") AND "public"."has_workspace_permission"("l"."workspace_id", "auth"."uid"(), 'admin'::"public"."workspace_role")))))));

DROP POLICY IF EXISTS "executed_leases_insert" ON "storage"."objects";
CREATE POLICY "executed_leases_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'executed-leases'::"text") AND ((("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text") OR (EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."executed_storage_path" = "objects"."name") AND "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"())))))));

DROP POLICY IF EXISTS "executed_leases_select" ON "storage"."objects";
CREATE POLICY "executed_leases_select" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'executed-leases'::"text") AND ((("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text") OR (EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."executed_storage_path" = "objects"."name") AND "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"())))))));

-- ---------- bucket: lease-reports ----------

DROP POLICY IF EXISTS "report owners insert lease-reports" ON "storage"."objects";
CREATE POLICY "report owners insert lease-reports" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'lease-reports'::"text") AND (EXISTS ( SELECT 1
   FROM (("public"."lease_reports" "lr"
     LEFT JOIN "public"."workspaces" "w" ON (("w"."id" = "lr"."workspace_id")))
     LEFT JOIN "public"."workspace_members" "wm" ON ((("wm"."workspace_id" = "lr"."workspace_id") AND ("wm"."user_id" = "auth"."uid"()))))
  WHERE ((("lr"."id")::"text" = ("storage"."foldername"("w"."name"))[2]) AND (("lr"."workspace_id")::"text" = ("storage"."foldername"("w"."name"))[1]) AND ("lr"."pdf_storage_path" IS NULL) AND (("lr"."generated_by" = "auth"."uid"()) OR ("w"."owner_id" = "auth"."uid"()) OR ("wm"."role" = 'admin'::"public"."workspace_role")))))));

DROP POLICY IF EXISTS "report owners update lease-reports" ON "storage"."objects";
CREATE POLICY "report owners update lease-reports" ON "storage"."objects" FOR UPDATE TO "authenticated" USING ((("bucket_id" = 'lease-reports'::"text") AND (EXISTS ( SELECT 1
   FROM (("public"."lease_reports" "lr"
     LEFT JOIN "public"."workspaces" "w" ON (("w"."id" = "lr"."workspace_id")))
     LEFT JOIN "public"."workspace_members" "wm" ON ((("wm"."workspace_id" = "lr"."workspace_id") AND ("wm"."user_id" = "auth"."uid"()))))
  WHERE ((("lr"."id")::"text" = ("storage"."foldername"("w"."name"))[2]) AND (("lr"."workspace_id")::"text" = ("storage"."foldername"("w"."name"))[1]) AND ("lr"."pdf_storage_path" IS NULL) AND (("lr"."generated_by" = "auth"."uid"()) OR ("w"."owner_id" = "auth"."uid"()) OR ("wm"."role" = 'admin'::"public"."workspace_role"))))))) WITH CHECK ((("bucket_id" = 'lease-reports'::"text") AND (EXISTS ( SELECT 1
   FROM (("public"."lease_reports" "lr"
     LEFT JOIN "public"."workspaces" "w" ON (("w"."id" = "lr"."workspace_id")))
     LEFT JOIN "public"."workspace_members" "wm" ON ((("wm"."workspace_id" = "lr"."workspace_id") AND ("wm"."user_id" = "auth"."uid"()))))
  WHERE ((("lr"."id")::"text" = ("storage"."foldername"("w"."name"))[2]) AND (("lr"."workspace_id")::"text" = ("storage"."foldername"("w"."name"))[1]) AND ("lr"."pdf_storage_path" IS NULL) AND (("lr"."generated_by" = "auth"."uid"()) OR ("w"."owner_id" = "auth"."uid"()) OR ("wm"."role" = 'admin'::"public"."workspace_role")))))));

DROP POLICY IF EXISTS "workspace members read lease-reports" ON "storage"."objects";
CREATE POLICY "workspace members read lease-reports" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'lease-reports'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."lease_reports" "lr"
  WHERE ((("lr"."pdf_storage_path" = "objects"."name") OR ("lr"."json_storage_path" = "objects"."name")) AND ("lr"."status" <> 'expired'::"text") AND (("lr"."expires_at" IS NULL) OR ("lr"."expires_at" > "now"())) AND (("lr"."workspace_id" IN ( SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE ("workspace_members"."user_id" = "auth"."uid"()))) OR ("lr"."workspace_id" IN ( SELECT "workspaces"."id"
           FROM "public"."workspaces"
          WHERE ("workspaces"."owner_id" = "auth"."uid"())))))))));
