


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


-- Baseline pre-patch (P1-10 remediation, 2026-05-16):
-- Declare extensions the historical migration chain depended on (pg_cron + pg_net
-- were declared in 20260106052646, 20260507210000, 20260507220000; pgcrypto is
-- defensive for crypt()/digest(); uuid-ossp covers any uuid_generate_v4() calls
-- even though gen_random_uuid() is built into PG13+). All IF NOT EXISTS so this
-- is a no-op when Supabase platform has pre-installed them.
CREATE EXTENSION IF NOT EXISTS "pg_cron";
CREATE EXTENSION IF NOT EXISTS "pg_net";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."subscription_plan" AS ENUM (
    'free',
    'starter',
    'pro',
    'business'
);


ALTER TYPE "public"."subscription_plan" OWNER TO "postgres";


CREATE TYPE "public"."workspace_role" AS ENUM (
    'admin',
    'editor',
    'viewer'
);


ALTER TYPE "public"."workspace_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."am_i_ops_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT public.is_ops_admin(auth.uid());
$$;


ALTER FUNCTION "public"."am_i_ops_admin"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."am_i_ops_admin"() IS 'SECURITY DEFINER wrapper around is_ops_admin(auth.uid()). Callable by authenticated users for frontend route gating. Returns false for unauthenticated.';



CREATE OR REPLACE FUNCTION "public"."apply_policy_steps"("p_policy_id" "uuid", "p_steps" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Auth check: caller must be admin/owner of the policy's workspace
  IF NOT EXISTS (
    SELECT 1 FROM public.approval_policies p
    WHERE p.id = p_policy_id
      AND (
        p.workspace_id IN (SELECT id FROM public.workspaces WHERE owner_id = auth.uid())
        OR p.workspace_id IN (
          SELECT workspace_id FROM public.workspace_members
          WHERE user_id = auth.uid() AND role = 'admin'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  DELETE FROM public.approval_chain_steps WHERE policy_id = p_policy_id;

  INSERT INTO public.approval_chain_steps (
    policy_id, stage, step_order, parallel_group,
    approver_user_id, approver_role, delegate_user_id, delegate_after_days, is_required
  )
  SELECT
    p_policy_id,
    (s->>'stage')::text,
    (s->>'step_order')::integer,
    COALESCE((s->>'parallel_group')::integer, 1),
    NULLIF(s->>'approver_user_id', '')::uuid,
    NULLIF(s->>'approver_role', ''),
    NULLIF(s->>'delegate_user_id', '')::uuid,
    NULLIF(s->>'delegate_after_days', '')::integer,
    COALESCE((s->>'is_required')::boolean, true)
  FROM jsonb_array_elements(p_steps) AS s;
END;
$$;


ALTER FUNCTION "public"."apply_policy_steps"("p_policy_id" "uuid", "p_steps" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_field"("p_lease_id" "uuid", "p_field_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Verify caller owns or is a workspace member of this lease
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE leases
  SET
    confirmed_sections = array_append(
      array_remove(confirmed_sections, p_field_name),
      p_field_name
    ),
    audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
      'action',     'field_approved',
      'timestamp',  NOW(),
      'user_id',    auth.uid(),
      'field_name', p_field_name
    )
  WHERE id = p_lease_id;

  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."approve_field"("p_lease_id" "uuid", "p_field_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."detect_lease_attribute_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lease_approval_chain WHERE lease_id = NEW.id LIMIT 1
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_status IN ('rejected', 'cancelled', 'expired') THEN
    RETURN NEW;
  END IF;

  IF OLD.asset_type IS DISTINCT FROM NEW.asset_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('asset_type',
      jsonb_build_object('from', OLD.asset_type, 'to', NEW.asset_type));
  END IF;
  IF OLD.lease_type IS DISTINCT FROM NEW.lease_type THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('lease_type',
      jsonb_build_object('from', OLD.lease_type, 'to', NEW.lease_type));
  END IF;
  IF OLD.requesting_department IS DISTINCT FROM NEW.requesting_department THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('requesting_department',
      jsonb_build_object('from', OLD.requesting_department, 'to', NEW.requesting_department));
  END IF;
  IF OLD.region IS DISTINCT FROM NEW.region THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('region',
      jsonb_build_object('from', OLD.region, 'to', NEW.region));
  END IF;
  IF OLD.monthly_payment IS DISTINCT FROM NEW.monthly_payment THEN
    v_changed := true;
    v_changes := v_changes || jsonb_build_object('monthly_payment',
      jsonb_build_object('from', OLD.monthly_payment, 'to', NEW.monthly_payment));
  END IF;

  IF v_changed THEN
    INSERT INTO public.lease_activity_log (
      lease_id, user_id, activity_type, from_status, to_status, details
    ) VALUES (
      NEW.id,
      NULL,
      'attribute_change_detected',
      NEW.lifecycle_status,
      NEW.lifecycle_status,
      jsonb_build_object(
        'changed_attributes', v_changes,
        'reroute_pending', true
      )
    );
    NEW.reroute_evaluation_pending = true;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."detect_lease_attribute_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finalize_lease_approval"("p_lease_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_confirmed_sections TEXT[];
BEGIN
  -- Verify caller is a financial_approver or admin in the lease's workspace,
  -- or is the lease owner.
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (
        l.user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM workspace_roles wr
          WHERE wr.workspace_id = l.workspace_id
            AND wr.user_id = auth.uid()
            AND wr.role IN ('financial_approver', 'admin')
        )
      )
  ) THEN
    RAISE EXCEPTION 'Unauthorized: financial_approver or admin role required';
  END IF;

  SELECT confirmed_sections
  INTO v_confirmed_sections
  FROM leases
  WHERE id = p_lease_id;

  UPDATE leases
  SET
    status           = 'Ready',
    lifecycle_status = 'approved',
    audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
      'action',            'lease_approved',
      'timestamp',         NOW(),
      'user_id',           auth.uid(),
      'fields_confirmed',  v_confirmed_sections
    )
  WHERE id = p_lease_id;

  INSERT INTO lease_approval_actions (lease_id, action, performed_by, performed_at)
  VALUES (p_lease_id, 'final_approval', auth.uid(), NOW())
  ON CONFLICT DO NOTHING;

  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."finalize_lease_approval"("p_lease_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_audit_user_id"("p_email" "text") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  SELECT id FROM auth.users WHERE email = lower(p_email) LIMIT 1;
$$;


ALTER FUNCTION "public"."get_audit_user_id"("p_email" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_audit_user_id"("p_email" "text") IS 'Returns the auth.users.id for a given email. Used server-side by audit-session edge function. Not callable by anon or authenticated roles.';



CREATE OR REPLACE FUNCTION "public"."get_workspace_role"("_workspace_id" "uuid", "_user_id" "uuid") RETURNS "public"."workspace_role"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT role
  FROM public.workspace_members
  WHERE workspace_id = _workspace_id
    AND user_id = _user_id
$$;


ALTER FUNCTION "public"."get_workspace_role"("_workspace_id" "uuid", "_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_workspace_permission"("_workspace_id" "uuid", "_user_id" "uuid", "_min_role" "public"."workspace_role") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = _workspace_id
      AND user_id = _user_id
      AND (
        CASE role
          WHEN 'admin' THEN 3
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1
        END >= CASE _min_role
          WHEN 'admin' THEN 3
          WHEN 'editor' THEN 2
          WHEN 'viewer' THEN 1
        END
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$$;


ALTER FUNCTION "public"."has_workspace_permission"("_workspace_id" "uuid", "_user_id" "uuid", "_min_role" "public"."workspace_role") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_policy_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."increment_policy_version"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_ops_admin"("_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ops_admins WHERE user_id = _user_id
  );
$$;


ALTER FUNCTION "public"."is_ops_admin"("_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_ops_admin"("_user_id" "uuid") IS 'Returns true when the user is in public.ops_admins. Replaced the workspace-UUID-hardcoded version on 2026-05-15 (P2-02).';



CREATE OR REPLACE FUNCTION "public"."is_workspace_member"("_workspace_id" "uuid", "_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_members
    WHERE workspace_id = _workspace_id
      AND user_id = _user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$$;


ALTER FUNCTION "public"."is_workspace_member"("_workspace_id" "uuid", "_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_workspace_owner"("_workspace_id" "uuid", "_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE id = _workspace_id
      AND owner_id = _user_id
  )
$$;


ALTER FUNCTION "public"."is_workspace_owner"("_workspace_id" "uuid", "_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lease_asc842_inputs_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.last_updated_at := now(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."lease_asc842_inputs_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_lease_state_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF (OLD.status IS DISTINCT FROM NEW.status) OR 
     (OLD.lifecycle_status IS DISTINCT FROM NEW.lifecycle_status) THEN
    
    INSERT INTO public.lease_state_transitions (
      lease_id,
      from_status,
      to_status,
      from_lifecycle,
      to_lifecycle,
      transitioned_by,
      transition_reason,
      metadata
    ) VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      OLD.lifecycle_status,
      NEW.lifecycle_status,
      auth.uid(),
      NEW.rejection_reason,
      jsonb_build_object(
        'approver', NEW.approver_email,
        'submitted_at', NEW.submitted_for_approval_at,
        'internal_approved_at', NEW.internal_approved_at,
        'execution_approved_at', NEW.execution_approved_at
      )
    );
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."log_lease_state_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."maintain_lease_document_latest_flag"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.lease_documents
     SET is_current_latest = false,
         superseded_by = NEW.id,
         superseded_at = now()
   WHERE lease_id = NEW.lease_id
     AND id <> NEW.id
     AND is_current_latest = true;

  UPDATE public.lease_documents
     SET is_current_latest = true
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."maintain_lease_document_latest_flag"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_field_as_corrected"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.lease_field_confidence SET was_corrected = true, corrected_at = NEW.corrected_at
  WHERE lease_id = NEW.lease_id AND field_name = NEW.field_name;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."mark_field_as_corrected"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pg_database_size_postgres"() RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
  SELECT pg_database_size('postgres');
$$;


ALTER FUNCTION "public"."pg_database_size_postgres"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_locked_lease_edits"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
DECLARE
  old_client_state jsonb;
  new_client_state jsonb;
  ignored_keys text[] := ARRAY[
    'updated_at',
    'vendor_name',
    'vendor_phone',
    'vendor_address_line1',
    'vendor_address_line2',
    'vendor_city',
    'vendor_state',
    'vendor_zip',
    'archived',
    'archived_at',
    'archived_by'
  ];
BEGIN
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.summary_share_token IS DISTINCT FROM OLD.summary_share_token
    OR NEW.summary_shared_at IS DISTINCT FROM OLD.summary_shared_at
    OR NEW.summary_last_viewed_at IS DISTINCT FROM OLD.summary_last_viewed_at
  THEN
    RAISE EXCEPTION 'Financial summary sharing fields are managed by the summary publishing workflow';
  END IF;

  IF OLD.model_locked IS TRUE THEN
    old_client_state := to_jsonb(OLD) - ignored_keys;
    new_client_state := to_jsonb(NEW) - ignored_keys;

    IF new_client_state IS DISTINCT FROM old_client_state THEN
      RAISE EXCEPTION 'Cannot modify a locked lease except through the governance workflow';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_locked_lease_edits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_unauthorized_lease_workflow_edits"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
BEGIN
  -- Service role: trusted server-side path. Bypass.
  IF COALESCE(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status
    OR NEW.manager_approved_by IS DISTINCT FROM OLD.manager_approved_by
    OR NEW.manager_approved_at IS DISTINCT FROM OLD.manager_approved_at
    OR NEW.manager_rejection_reason IS DISTINCT FROM OLD.manager_rejection_reason
    OR NEW.financial_approved_by IS DISTINCT FROM OLD.financial_approved_by
    OR NEW.financial_approved_at IS DISTINCT FROM OLD.financial_approved_at
    OR NEW.financial_returned_to_submitter IS DISTINCT FROM OLD.financial_returned_to_submitter
    OR NEW.financial_rejection_reason IS DISTINCT FROM OLD.financial_rejection_reason
    OR NEW.model_locked IS DISTINCT FROM OLD.model_locked
    OR NEW.model_locked_at IS DISTINCT FROM OLD.model_locked_at
    OR NEW.model_locked_by IS DISTINCT FROM OLD.model_locked_by
    OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
  THEN
    RAISE EXCEPTION 'Lease workflow fields can only be changed through the governance edge functions (legacy-lease-action or act-on-chain-step). Direct authenticated updates are not permitted.';
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_unauthorized_lease_workflow_edits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preview_policy_resolution"("p_workspace_id" "uuid", "p_asset_type" "text", "p_department" "text", "p_annual_cost" numeric, "p_region" "text", "p_lease_type" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_policy public.approval_policies;
  v_chain jsonb;
  v_warnings text[] := ARRAY[]::text[];
BEGIN
  -- Caller must have membership/ownership in the workspace being queried.
  -- Belt-and-suspenders since the function is SECURITY DEFINER.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspaces WHERE id = p_workspace_id AND owner_id = auth.uid()
    UNION
    SELECT 1 FROM public.workspace_members WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  -- Find matching policies, sorted by priority descending
  SELECT * INTO v_policy
  FROM public.approval_policies p
  WHERE p.workspace_id = p_workspace_id
    AND p.is_active = true
    AND (cardinality(p.match_asset_types) = 0 OR p_asset_type = ANY(p.match_asset_types))
    AND (cardinality(p.match_departments) = 0 OR p_department = ANY(p.match_departments))
    AND (p.match_min_annual_cost IS NULL OR p_annual_cost >= p.match_min_annual_cost)
    AND (p.match_max_annual_cost IS NULL OR p_annual_cost <= p.match_max_annual_cost)
    AND (cardinality(p.match_regions) = 0 OR p_region = ANY(p.match_regions))
    AND (cardinality(p.match_lease_types) = 0 OR p_lease_type = ANY(p.match_lease_types))
  ORDER BY p.priority DESC, p.created_at ASC
  LIMIT 1;

  -- Fall back to default policy if none matched
  IF v_policy.id IS NULL THEN
    SELECT * INTO v_policy
    FROM public.approval_policies p
    WHERE p.workspace_id = p_workspace_id
      AND p.is_active = true
      AND p.is_default_fallback = true
    LIMIT 1;

    IF v_policy.id IS NULL THEN
      RETURN jsonb_build_object(
        'matched', false,
        'error', 'No matching policy and no default fallback configured.'
      );
    END IF;

    v_warnings := array_append(v_warnings, 'No specific match; using default fallback policy.');
  END IF;

  -- Build resolved chain
  SELECT jsonb_agg(
    jsonb_build_object(
      'stage', s.stage,
      'step_order', s.step_order,
      'parallel_group', s.parallel_group,
      'approver_user_id', s.approver_user_id,
      'approver_role', s.approver_role,
      'delegate_user_id', s.delegate_user_id,
      'is_required', s.is_required
    )
    ORDER BY s.stage, s.step_order, s.parallel_group
  ) INTO v_chain
  FROM public.approval_chain_steps s
  WHERE s.policy_id = v_policy.id;

  RETURN jsonb_build_object(
    'matched', true,
    'policy_id', v_policy.id,
    'policy_name', v_policy.name,
    'policy_priority', v_policy.priority,
    'policy_version', v_policy.version,
    'separation_override', v_policy.separation_of_duties_override,
    'chain', COALESCE(v_chain, '[]'::jsonb),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;


ALTER FUNCTION "public"."preview_policy_resolution"("p_workspace_id" "uuid", "p_asset_type" "text", "p_department" "text", "p_annual_cost" numeric, "p_region" "text", "p_lease_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_field_correction"("p_lease_id" "uuid", "p_field_name" "text", "p_original_value" "text", "p_corrected_value" "text", "p_correction_type" "text" DEFAULT 'manual'::"text", "p_user_notes" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_correction_id uuid;
  v_ai_confidence numeric;
BEGIN
  -- Verify caller can edit this lease
  IF NOT EXISTS (
    SELECT 1 FROM leases l
    WHERE l.id = p_lease_id
      AND (l.user_id = auth.uid() OR is_workspace_member(l.workspace_id, auth.uid()))
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT confidence_score INTO v_ai_confidence
  FROM lease_field_confidence
  WHERE lease_id = p_lease_id AND field_name = p_field_name;

  INSERT INTO field_corrections (
    lease_id, field_name, original_value, corrected_value,
    ai_confidence, corrected_by, corrected_at, correction_type, user_notes
  ) VALUES (
    p_lease_id, p_field_name, p_original_value, p_corrected_value,
    v_ai_confidence, auth.uid(), NOW(), p_correction_type, p_user_notes
  )
  RETURNING id INTO v_correction_id;

  UPDATE lease_field_confidence
  SET was_corrected = TRUE, corrected_at = NOW()
  WHERE lease_id = p_lease_id AND field_name = p_field_name;

  UPDATE leases
  SET audit_log = COALESCE(audit_log, '[]'::jsonb) || jsonb_build_object(
    'action',        'field_corrected',
    'timestamp',     NOW(),
    'user_id',       auth.uid(),
    'field_name',    p_field_name,
    'correction_id', v_correction_id
  )
  WHERE id = p_lease_id;

  RETURN v_correction_id;
END;
$$;


ALTER FUNCTION "public"."record_field_correction"("p_lease_id" "uuid", "p_field_name" "text", "p_original_value" "text", "p_corrected_value" "text", "p_correction_type" "text", "p_user_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."storage_total_bytes"() RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'storage', 'pg_catalog'
    AS $$ SELECT COALESCE(SUM((metadata->>'size')::bigint), 0)::bigint FROM storage.objects WHERE metadata ? 'size'; $$;


ALTER FUNCTION "public"."storage_total_bytes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_lease_avg_confidence"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  UPDATE public.leases 
  SET avg_confidence_score = (
    SELECT AVG(confidence_score) 
    FROM public.lease_field_confidence 
    WHERE lease_id = NEW.lease_id
  ) 
  WHERE id = NEW.lease_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_lease_avg_confidence"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."alert_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "alert_type" "text" NOT NULL,
    "threshold_days" integer,
    "threshold_value" numeric,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."alert_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."approval_chain_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "policy_id" "uuid" NOT NULL,
    "stage" "text" NOT NULL,
    "step_order" integer NOT NULL,
    "parallel_group" integer DEFAULT 1 NOT NULL,
    "approver_user_id" "uuid",
    "approver_role" "text",
    "delegate_user_id" "uuid",
    "delegate_after_days" integer,
    "is_required" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "approval_chain_steps_approver_role_check" CHECK (("approver_role" = ANY (ARRAY['submitter'::"text", 'manager_approver'::"text", 'financial_approver'::"text", 'signator'::"text", 'admin'::"text"]))),
    CONSTRAINT "approval_chain_steps_delegate_after_days_check" CHECK ((("delegate_after_days" IS NULL) OR ("delegate_after_days" > 0))),
    CONSTRAINT "approval_chain_steps_stage_check" CHECK (("stage" = ANY (ARRAY['concept'::"text", 'signator'::"text"]))),
    CONSTRAINT "one_assignee_method" CHECK (((("approver_user_id" IS NOT NULL) AND ("approver_role" IS NULL)) OR (("approver_user_id" IS NULL) AND ("approver_role" IS NOT NULL))))
);


ALTER TABLE "public"."approval_chain_steps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."approval_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "priority" integer DEFAULT 100 NOT NULL,
    "match_asset_types" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "match_departments" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "match_min_annual_cost" numeric,
    "match_max_annual_cost" numeric,
    "match_regions" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "match_lease_types" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "separation_of_duties_override" boolean,
    "is_default_fallback" boolean DEFAULT false NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "updated_by" "uuid" NOT NULL,
    CONSTRAINT "cost_range_valid" CHECK ((("match_min_annual_cost" IS NULL) OR ("match_max_annual_cost" IS NULL) OR ("match_min_annual_cost" <= "match_max_annual_cost")))
);


ALTER TABLE "public"."approval_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chain_step_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "chain_step_id" "uuid" NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "override_action" "text" NOT NULL,
    "override_by" "uuid" NOT NULL,
    "override_reason" "text" NOT NULL,
    "override_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reassigned_to_user_id" "uuid",
    "prior_assignee_user_id" "uuid",
    "prior_assignee_role" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chain_step_overrides_override_action_check" CHECK (("override_action" = ANY (ARRAY['approve'::"text", 'reject'::"text", 'send_back'::"text", 'reassign'::"text", 'cancel_step'::"text"]))),
    CONSTRAINT "chain_step_overrides_override_reason_check" CHECK (("length"(TRIM(BOTH FROM "override_reason")) >= 20))
);


ALTER TABLE "public"."chain_step_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chain_step_voluntary_delegations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "chain_step_id" "uuid" NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "delegated_by" "uuid" NOT NULL,
    "delegated_to" "uuid" NOT NULL,
    "delegated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reason" "text",
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    CONSTRAINT "vd_no_self_delegation" CHECK (("delegated_by" <> "delegated_to"))
);


ALTER TABLE "public"."chain_step_voluntary_delegations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."classification_corrections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "lease_id" "uuid",
    "original_classification" "jsonb" NOT NULL,
    "corrected_classification" "jsonb" NOT NULL,
    "correction_type" "text" NOT NULL,
    "user_note" "text",
    "document_summary" "text",
    "corrected_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "classification_corrections_correction_type_check" CHECK (("correction_type" = ANY (ARRAY['is_lease_override'::"text", 'asset_type_changed'::"text", 'lease_type_changed'::"text", 'parent_lease_changed'::"text", 'general_correction'::"text"])))
);


ALTER TABLE "public"."classification_corrections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deleted_workspaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "original_workspace_id" "uuid" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "workspace_name" "text",
    "workspace_plan" "text",
    "lease_count_at_deletion" integer,
    "member_count_at_deletion" integer,
    "storage_objects_purged" integer,
    "deleted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_by" "uuid"
);


ALTER TABLE "public"."deleted_workspaces" OWNER TO "postgres";


COMMENT ON TABLE "public"."deleted_workspaces" IS 'Forensic audit trail of workspace deletions. Written by the delete-workspace edge function; immutable thereafter. Survives the original workspaces row.';



CREATE TABLE IF NOT EXISTS "public"."dismissed_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "event_key" "text" NOT NULL,
    "dismissed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dismissed_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."executed_term_edits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "field_name" "text" NOT NULL,
    "original_value" "text",
    "edited_value" "text",
    "edited_by" "uuid" NOT NULL,
    "edited_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reason" "text"
);


ALTER TABLE "public"."executed_term_edits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."field_corrections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "field_name" "text" NOT NULL,
    "original_value" "text",
    "corrected_value" "text",
    "ai_confidence" numeric(3,2),
    "corrected_by" "uuid",
    "corrected_at" timestamp with time zone DEFAULT "now"(),
    "correction_type" "text",
    "user_notes" "text",
    CONSTRAINT "field_corrections_correction_type_check" CHECK (("correction_type" = ANY (ARRAY['edit'::"text", 'add_missing'::"text", 'delete_wrong'::"text"])))
);


ALTER TABLE "public"."field_corrections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invite_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "public"."workspace_role" DEFAULT 'viewer'::"public"."workspace_role" NOT NULL,
    "token" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(32), 'hex'::"text") NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval) NOT NULL,
    "accepted_at" timestamp with time zone,
    "first_name" "text",
    "last_name" "text"
);


ALTER TABLE "public"."invite_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_activity_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "activity_type" "text" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_activity_log_activity_type_check" CHECK (("activity_type" = ANY (ARRAY['status_change'::"text", 'approval'::"text", 'rejection'::"text", 'send_back'::"text", 'pause'::"text", 'nudge_sent'::"text", 'document_upload'::"text", 'created'::"text", 'comment'::"text", 'executed_uploaded'::"text", 'executed_terms_extracted'::"text", 'unlock_approved'::"text", 'unlock_requested'::"text", 'change_canceled'::"text", 'change_set_submitted'::"text", 'change_set_approved'::"text", 'change_set_rejected'::"text", 'change_set_self_approved'::"text", 'risk_dismissed'::"text", 'risk_restored'::"text", 'risk_added'::"text", 'change_submitted'::"text", 'change_approved'::"text", 'change_rejected'::"text", 'chain_resolved'::"text", 'chain_step_approved'::"text", 'chain_step_rejected'::"text", 'chain_step_sent_back'::"text", 'chain_stage_completed'::"text", 'chain_resolution_failed'::"text", 'concept_stage_entered'::"text", 'concept_stage_completed'::"text", 'negotiation_stage_entered'::"text", 'final_review_stage_entered'::"text", 'pending_counter_signature_started'::"text", 'fully_executed_recorded'::"text", 'concept_approver_escalation_requested'::"text", 'final_review_advanced'::"text", 'document_uploaded_with_metadata'::"text", 'document_iteration_started'::"text", 'document_version_bumped'::"text", 'signator_attestation_recorded'::"text", 'execution_owner_assigned'::"text", 'counter_signature_recorded'::"text", 'counter_signature_reminder_sent'::"text", 'counter_signature_overdue_recorded'::"text", 'signator_review_decline'::"text", 'execution_owner_reassigned'::"text", 'attribute_change_detected'::"text", 'chain_rerouted'::"text", 'chain_reroute_skipped_no_match'::"text", 'chain_violation_entered'::"text", 'chain_violation_resolved'::"text", 'reroute_audit_run'::"text", 'manual_reroute_requested'::"text", 'manual_reroute_approved'::"text", 'manual_reroute_rejected'::"text", 'voluntary_delegation_set'::"text", 'voluntary_delegation_revoked'::"text", 'admin_override_executed'::"text", 'out_of_office_declared'::"text", 'out_of_office_revoked'::"text", 'delegate_timer_activated'::"text", 'delegate_timer_started'::"text", 'step_pending_started'::"text", 'stuck_chain_detected'::"text", 'stuck_chain_resolved'::"text", 'deactivated_approver_handled'::"text", 'chain_step_overridden'::"text", 'chain_step_admin_reassigned'::"text", 'report_generation_requested'::"text", 'report_generation_completed'::"text", 'report_generation_failed'::"text", 'report_downloaded'::"text", 'report_expired'::"text", 'report_deleted'::"text", 'discount_rate_set'::"text", 'discount_rate_cleared'::"text", 'asc842_inputs_updated'::"text", 'tier2_classification_passed'::"text", 'tier2_classification_rejected'::"text", 'tier2_classification_overridden'::"text", 'tier2_correction_recorded'::"text", 'lease_insights_generated'::"text"])))
);


ALTER TABLE "public"."lease_activity_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_approval_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "approver_id" "uuid" NOT NULL,
    "approval_type" "text" NOT NULL,
    "action" "text" NOT NULL,
    "comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_approval_actions_action_check" CHECK (("action" = ANY (ARRAY['approve'::"text", 'send_back'::"text", 'reject'::"text", 'pause'::"text"]))),
    CONSTRAINT "lease_approval_actions_approval_type_check" CHECK (("approval_type" = ANY (ARRAY['internal'::"text", 'execution'::"text"])))
);


ALTER TABLE "public"."lease_approval_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_approval_chain" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "policy_id" "uuid",
    "policy_version" integer,
    "stage" "text" NOT NULL,
    "step_order" integer NOT NULL,
    "parallel_group" integer DEFAULT 1 NOT NULL,
    "approver_user_id" "uuid",
    "approver_role" "text",
    "delegate_user_id" "uuid",
    "delegate_after_days" integer,
    "is_required" boolean DEFAULT true NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "action_at" timestamp with time zone,
    "action_by" "uuid",
    "comment" "text",
    "rerouted_from_chain_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pending_since" timestamp with time zone,
    "delegate_activated_at" timestamp with time zone,
    "effective_assignee_user_id" "uuid",
    "assignee_resolution_source" "text",
    CONSTRAINT "chain_assignee_present" CHECK ((("approver_user_id" IS NOT NULL) OR ("approver_role" IS NOT NULL))),
    CONSTRAINT "lease_approval_chain_assignee_source_check" CHECK ((("assignee_resolution_source" IS NULL) OR ("assignee_resolution_source" = ANY (ARRAY['policy_user'::"text", 'policy_role'::"text", 'policy_delegate'::"text", 'ooo_delegate'::"text", 'voluntary_delegate'::"text", 'admin_reassign'::"text"])))),
    CONSTRAINT "lease_approval_chain_stage_check" CHECK (("stage" = ANY (ARRAY['concept'::"text", 'signator'::"text"]))),
    CONSTRAINT "lease_approval_chain_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'sent_back'::"text", 'superseded'::"text", 'delegated'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."lease_approval_chain" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_approvers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "approver_id" "uuid" NOT NULL,
    "approval_type" "text" NOT NULL,
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_approvers_approval_type_check" CHECK (("approval_type" = ANY (ARRAY['internal'::"text", 'execution'::"text"])))
);


ALTER TABLE "public"."lease_approvers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_asc842_inputs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "tenant_improvement_allowance" numeric(14,2),
    "tenant_improvement_allowance_basis" "text",
    "initial_direct_costs" numeric(14,2),
    "initial_direct_costs_basis" "text",
    "prepaid_rent" numeric(14,2),
    "prepaid_rent_basis" "text",
    "lease_incentives_received" numeric(14,2),
    "lease_incentives_received_basis" "text",
    "residual_value_guarantee" numeric(14,2),
    "residual_value_guarantee_basis" "text",
    "purchase_option_present" boolean,
    "purchase_option_price" numeric(14,2),
    "purchase_option_reasonably_certain" boolean,
    "purchase_option_basis" "text",
    "termination_penalty_amount" numeric(14,2),
    "termination_penalty_reasonably_certain" boolean,
    "termination_penalty_basis" "text",
    "ownership_transfers_at_end" boolean,
    "bargain_purchase_option" boolean,
    "major_part_economic_life" boolean,
    "major_part_economic_life_pct" numeric(5,2),
    "pv_substantially_all_fair_value" boolean,
    "pv_to_fair_value_pct" numeric(5,2),
    "asset_fair_value" numeric(14,2),
    "specialized_asset_no_alt_use" boolean,
    "classification_criteria_basis" "text",
    "renewal_options_rc_term_months" integer,
    "renewal_options_rc_basis" "text",
    "short_term_lease_election" boolean,
    "short_term_lease_election_basis" "text",
    "variable_payments_description" "text",
    "variable_payments_estimated_annual" numeric(14,2),
    "sublease_income_annual" numeric(14,2),
    "sublease_basis" "text",
    "last_updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "asc842_inputs_amounts_non_negative" CHECK (((("tenant_improvement_allowance" IS NULL) OR ("tenant_improvement_allowance" >= (0)::numeric)) AND (("initial_direct_costs" IS NULL) OR ("initial_direct_costs" >= (0)::numeric)) AND (("prepaid_rent" IS NULL) OR ("prepaid_rent" >= (0)::numeric)) AND (("lease_incentives_received" IS NULL) OR ("lease_incentives_received" >= (0)::numeric)) AND (("residual_value_guarantee" IS NULL) OR ("residual_value_guarantee" >= (0)::numeric)) AND (("purchase_option_price" IS NULL) OR ("purchase_option_price" >= (0)::numeric)) AND (("termination_penalty_amount" IS NULL) OR ("termination_penalty_amount" >= (0)::numeric)) AND (("asset_fair_value" IS NULL) OR ("asset_fair_value" >= (0)::numeric)) AND (("variable_payments_estimated_annual" IS NULL) OR ("variable_payments_estimated_annual" >= (0)::numeric)) AND (("sublease_income_annual" IS NULL) OR ("sublease_income_annual" >= (0)::numeric)))),
    CONSTRAINT "asc842_inputs_pct_range" CHECK (((("major_part_economic_life_pct" IS NULL) OR (("major_part_economic_life_pct" >= (0)::numeric) AND ("major_part_economic_life_pct" <= (100)::numeric))) AND (("pv_to_fair_value_pct" IS NULL) OR (("pv_to_fair_value_pct" >= (0)::numeric) AND ("pv_to_fair_value_pct" <= (100)::numeric))))),
    CONSTRAINT "asc842_inputs_renewal_term_non_negative" CHECK ((("renewal_options_rc_term_months" IS NULL) OR ("renewal_options_rc_term_months" >= 0)))
);


ALTER TABLE "public"."lease_asc842_inputs" OWNER TO "postgres";


COMMENT ON TABLE "public"."lease_asc842_inputs" IS 'Per-lease ASC 842 measurement and classification inputs. One row per lease (UNIQUE on lease_id). NULL = not yet captured (distinct from 0/false which means captured as zero).';



CREATE TABLE IF NOT EXISTS "public"."lease_attribute_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "chain_resolution_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "policy_id" "uuid",
    "policy_version" integer,
    "asset_type" "text",
    "lease_type" "text",
    "requesting_department" "text",
    "region" "text",
    "monthly_payment" numeric,
    "annual_cost_at_snapshot" numeric,
    "raw_attributes" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lease_attribute_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_change_set_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "change_set_id" "uuid" NOT NULL,
    "field_name" "text" NOT NULL,
    "field_label" "text" NOT NULL,
    "old_value" "text",
    "proposed_value" "text",
    "source_section" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lease_change_set_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_change_sets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "unlock_request_id" "uuid",
    "submitted_by" "uuid" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "change_summary" "text",
    "submitted_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "self_approved" boolean DEFAULT false NOT NULL,
    "requested_approver_id" "uuid",
    CONSTRAINT "lease_change_sets_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'pending_approval'::"text", 'approved'::"text", 'rejected'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."lease_change_sets" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lease_change_sets"."self_approved" IS 'TRUE when the submitter (admin role) self-approved the change_set in one action via the lock dialog. FALSE for the standard approver workflow. External auditors filter by this column to flag self-approved financial changes.';



COMMENT ON COLUMN "public"."lease_change_sets"."requested_approver_id" IS 'auth.users.id of the specific approver the submitter requested. NULL means any workspace admin can review. Set when the submitter picks an approver in the Lock dialog Request Approval flow.';



CREATE TABLE IF NOT EXISTS "public"."lease_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "document_type" "text" NOT NULL,
    "iteration_number" integer NOT NULL,
    "version_number" integer NOT NULL,
    "storage_path" "text" NOT NULL,
    "filename" "text" NOT NULL,
    "mime_type" "text",
    "file_size_bytes" bigint,
    "uploaded_by" "uuid" NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    "is_current_latest" boolean DEFAULT false NOT NULL,
    "superseded_by" "uuid",
    "superseded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_documents_document_type_check" CHECK (("document_type" = ANY (ARRAY['concept_attachment'::"text", 'loi'::"text", 'draft'::"text", 'redline'::"text", 'counter_redline'::"text", 'final_negotiated'::"text", 'our_signed'::"text", 'fully_executed_counterparty_returned'::"text", 'amendment'::"text", 'side_letter'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."lease_documents" OWNER TO "postgres";


COMMENT ON TABLE "public"."lease_documents" IS 'One row per uploaded document iteration. is_current_latest flag is maintained by the AFTER INSERT trigger; application code never sets it directly.';



CREATE TABLE IF NOT EXISTS "public"."lease_field_confidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "field_name" "text" NOT NULL,
    "confidence_score" numeric(3,2) NOT NULL,
    "was_corrected" boolean DEFAULT false,
    "corrected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lease_field_confidence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_governance_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "actor_user_id" "uuid",
    "actor_email" "text",
    "related_unlock_request_id" "uuid",
    "related_change_set_id" "uuid",
    "field_name" "text",
    "field_label" "text",
    "old_value" "text",
    "proposed_value" "text",
    "final_value" "text",
    "change_summary" "text",
    "rejection_reason" "text",
    "cancellation_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_governance_audit_event_type_check" CHECK (("event_type" = ANY (ARRAY['unlock_requested'::"text", 'unlock_approved'::"text", 'unlock_rejected'::"text", 'change_set_created'::"text", 'field_change_staged'::"text", 'change_set_submitted'::"text", 'change_set_approved'::"text", 'field_change_committed'::"text", 'change_set_rejected'::"text", 'change_set_canceled'::"text", 'lease_relocked'::"text", 'change_set_self_approved'::"text"])))
);


ALTER TABLE "public"."lease_governance_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "insight_type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "source_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "triggered_by" "text" NOT NULL,
    "generated_model" "text",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_insights_body_check" CHECK ((("length"(TRIM(BOTH FROM "body")) >= 1) AND ("length"(TRIM(BOTH FROM "body")) <= 1000))),
    CONSTRAINT "lease_insights_insight_type_check" CHECK (("insight_type" = ANY (ARRAY['portfolio_norm_deviation'::"text", 'amendment_impact'::"text", 'renewal_proximity'::"text", 'risk_pattern_match'::"text", 'general_observation'::"text"]))),
    CONSTRAINT "lease_insights_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'notice'::"text", 'concern'::"text"]))),
    CONSTRAINT "lease_insights_title_check" CHECK ((("length"(TRIM(BOTH FROM "title")) >= 1) AND ("length"(TRIM(BOTH FROM "title")) <= 120))),
    CONSTRAINT "lease_insights_triggered_by_check" CHECK (("triggered_by" = ANY (ARRAY['manual'::"text", 'model_locked'::"text", 'amendment_confirmed'::"text", 'scheduled'::"text"])))
);


ALTER TABLE "public"."lease_insights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_date" "date" NOT NULL,
    "event_description" "text",
    "notify_days_before" integer[] DEFAULT '{90,60,30,14,7}'::integer[] NOT NULL,
    "notify_email" boolean DEFAULT true NOT NULL,
    "is_confirmed" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_notified_at" timestamp with time zone,
    CONSTRAINT "lease_notifications_event_type_check" CHECK (("event_type" = ANY (ARRAY['expiration'::"text", 'escalation'::"text", 'renewal_window'::"text", 'commencement'::"text", 'custom'::"text", 'new_request'::"text", 'status_changed'::"text", 'document_uploaded'::"text"])))
);


ALTER TABLE "public"."lease_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_nudges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "sent_by" "uuid",
    "nudge_type" "text" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "channel" "text" NOT NULL,
    CONSTRAINT "lease_nudges_channel_check" CHECK (("channel" = ANY (ARRAY['in_app'::"text", 'email'::"text", 'sms'::"text"]))),
    CONSTRAINT "lease_nudges_nudge_type_check" CHECK (("nudge_type" = ANY (ARRAY['manual'::"text", 'automatic_day2'::"text", 'automatic_day5'::"text", 'automatic_day10'::"text"])))
);


ALTER TABLE "public"."lease_nudges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "report_type" "text" NOT NULL,
    "report_scope" "text" NOT NULL,
    "lease_id" "uuid",
    "period_start" "date",
    "period_end" "date",
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "generated_by" "uuid" NOT NULL,
    "pdf_storage_path" "text",
    "json_storage_path" "text",
    "lease_count" integer DEFAULT 0 NOT NULL,
    "excluded_lease_count" integer DEFAULT 0 NOT NULL,
    "exclusion_reasons" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "organization_name_at_gen" "text",
    "discount_rate_method_at_gen" "text",
    "workspace_settings_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "error_message" "text",
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_reports_report_scope_check" CHECK (("report_scope" = ANY (ARRAY['single_lease'::"text", 'monthly'::"text", 'quarterly'::"text", 'annual'::"text", 'custom_range'::"text"]))),
    CONSTRAINT "lease_reports_report_type_check" CHECK (("report_type" = ANY (ARRAY['lease_disclosure'::"text", 'portfolio_period'::"text"]))),
    CONSTRAINT "lease_reports_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'generating'::"text", 'ready'::"text", 'failed'::"text", 'expired'::"text"]))),
    CONSTRAINT "report_scope_lease_id_correlation" CHECK (((("report_scope" = 'single_lease'::"text") AND ("lease_id" IS NOT NULL) AND ("period_start" IS NULL) AND ("period_end" IS NULL)) OR (("report_scope" = ANY (ARRAY['monthly'::"text", 'quarterly'::"text", 'annual'::"text", 'custom_range'::"text"])) AND ("lease_id" IS NULL) AND ("period_start" IS NOT NULL) AND ("period_end" IS NOT NULL) AND ("period_start" <= "period_end"))))
);


ALTER TABLE "public"."lease_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_reroute_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "triggered_by" "uuid",
    "triggered_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "trigger_reason" "text" NOT NULL,
    "prior_policy_id" "uuid",
    "prior_policy_version" integer,
    "new_policy_id" "uuid",
    "new_policy_version" integer,
    "changed_attributes" "jsonb" NOT NULL,
    "prior_lifecycle_status" "text" NOT NULL,
    "new_lifecycle_status" "text" NOT NULL,
    "steps_added_count" integer DEFAULT 0 NOT NULL,
    "steps_superseded_count" integer DEFAULT 0 NOT NULL,
    "steps_preserved_count" integer DEFAULT 0 NOT NULL,
    "detection_mode" "text" NOT NULL,
    "resulted_in_chain_violation" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_reroute_events_detection_mode_check" CHECK (("detection_mode" = ANY (ARRAY['auto'::"text", 'manual_admin'::"text", 'manual_audit'::"text"])))
);


ALTER TABLE "public"."lease_reroute_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_state_transitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "from_status" "text",
    "to_status" "text" NOT NULL,
    "from_lifecycle" "text",
    "to_lifecycle" "text",
    "transitioned_by" "uuid",
    "transition_reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."lease_state_transitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lease_unlock_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "request_reason" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lease_unlock_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."lease_unlock_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."leases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "filename" "text" NOT NULL,
    "storage_path" "text",
    "status" "text" DEFAULT 'Uploaded'::"text" NOT NULL,
    "error_message" "text",
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "extracted_json" "jsonb",
    "landlord_name" "text",
    "tenant_name" "text",
    "lease_start" "date",
    "lease_end" "date",
    "base_rent_amount" "text",
    "base_rent_frequency" "text",
    "current_monthly_rent" numeric(12,2),
    "rent_escalation_type" "text",
    "workspace_id" "uuid",
    "square_footage" integer,
    "confirmed_sections" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "lifecycle_status" "text" DEFAULT 'draft'::"text",
    "category" "text",
    "business_unit" "text",
    "estimated_term_min" integer,
    "estimated_term_max" integer,
    "estimated_monthly_cost_min" numeric,
    "estimated_monthly_cost_max" numeric,
    "lease_owner_id" "uuid",
    "notes" "text",
    "rejection_reason" "text",
    "submitted_for_approval_at" timestamp with time zone,
    "internal_approved_at" timestamp with time zone,
    "execution_approved_at" timestamp with time zone,
    "activated_at" timestamp with time zone,
    "lease_type" "text",
    "approver_email" "text",
    "initializer_id" "uuid",
    "confidence_scores" "jsonb" DEFAULT '{}'::"jsonb",
    "audit_log" "jsonb" DEFAULT '[]'::"jsonb",
    "last_nudged_at" timestamp with time zone,
    "parent_lease_id" "uuid",
    "avg_confidence_score" numeric(3,2),
    "monthly_payment" numeric,
    "term_months" integer,
    "asset_type" "text",
    "escalation_rate" numeric DEFAULT 0,
    "calc_total_commitment" numeric,
    "calc_pv_liability" numeric,
    "calc_straight_line_exp" numeric,
    "calc_cash_pl_delta" numeric,
    "lease_classification" "text" DEFAULT 'pending'::"text",
    "covenant_flagged" boolean DEFAULT false,
    "request_title" "text",
    "requesting_department" "text",
    "requestor_id" "uuid",
    "request_urgency" "text" DEFAULT 'standard'::"text",
    "expected_start_date" "date",
    "request_description" "text",
    "vendor_name" "text",
    "manager_approved_by" "uuid",
    "manager_approved_at" timestamp with time zone,
    "manager_rejection_reason" "text",
    "financial_approved_by" "uuid",
    "financial_approved_at" timestamp with time zone,
    "financial_rejection_reason" "text",
    "financial_returned_to_submitter" boolean DEFAULT false,
    "lease_classification_set_by" "uuid",
    "lease_classification_set_at" timestamp with time zone,
    "status_changed_at" timestamp with time zone,
    "summary_share_token" "text",
    "summary_shared_at" timestamp with time zone,
    "summary_last_viewed_at" timestamp with time zone,
    "executed_document_url" "text",
    "executed_storage_path" "text",
    "executed_filename" "text",
    "executed_extracted_json" "jsonb",
    "executed_extraction_confidence" "jsonb" DEFAULT '{}'::"jsonb",
    "executed_uploaded_at" timestamp with time zone,
    "executed_uploaded_by" "uuid",
    "executed_monthly_payment" numeric,
    "executed_commencement_date" "date",
    "executed_expiry_date" "date",
    "executed_tenant_name" "text",
    "executed_landlord_name" "text",
    "executed_rent_review_clause" "text",
    "executed_break_clause" "text",
    "variance_monthly_payment" numeric,
    "variance_commencement_days" integer,
    "variance_expiry_days" integer,
    "variance_tenant_name_match" boolean,
    "variance_landlord_name_match" boolean,
    "variance_reviewed_at" timestamp with time zone,
    "variance_reviewed_by" "uuid",
    "model_locked" boolean DEFAULT false NOT NULL,
    "model_locked_at" timestamp with time zone,
    "model_locked_by" "uuid",
    "escalation_type" "text",
    "needs_escalation_review" boolean DEFAULT false,
    "property_address" "text",
    "rent_commencement_date" "date",
    "security_deposit" "text",
    "renewal_options" "text",
    "escalation_clauses" "text",
    "termination_clauses" "text",
    "intake_source" "text" DEFAULT 'manual_upload'::"text",
    "location" "text",
    "building" "text",
    "region" "text",
    "unlock_requested" boolean DEFAULT false NOT NULL,
    "unlock_requested_by" "uuid",
    "unlock_requested_at" timestamp with time zone,
    "unlock_action_token" "text",
    "unlock_token_expires_at" timestamp with time zone,
    "vendor_address_line1" "text",
    "vendor_address_line2" "text",
    "vendor_city" "text",
    "vendor_state" "text",
    "vendor_zip" "text",
    "vendor_phone" "text",
    "summary_share_token_expires_at" timestamp with time zone,
    "archived" boolean DEFAULT false NOT NULL,
    "archived_at" timestamp with time zone,
    "archived_by" "uuid",
    "concept_approved_at" timestamp with time zone,
    "signator_approved_at" timestamp with time zone,
    "counter_signed_at" timestamp with time zone,
    "fully_executed_at" timestamp with time zone,
    "execution_owner_id" "uuid",
    "signator_attestation" "text",
    "counter_signature_due_date" "date",
    "counter_signature_reminder_count" integer DEFAULT 0 NOT NULL,
    "reroute_evaluation_pending" boolean DEFAULT false NOT NULL,
    "discount_rate" numeric(6,4),
    "discount_rate_basis" "text",
    "discount_rate_set_at" timestamp with time zone,
    "discount_rate_set_by" "uuid",
    CONSTRAINT "leases_category_check" CHECK (("category" = ANY (ARRAY['property'::"text", 'equipment'::"text", 'vehicle'::"text", 'other'::"text"]))),
    CONSTRAINT "leases_discount_rate_range" CHECK ((("discount_rate" IS NULL) OR (("discount_rate" > (0)::numeric) AND ("discount_rate" <= (50)::numeric)))),
    CONSTRAINT "leases_intake_source_check" CHECK (("intake_source" = ANY (ARRAY['request_workflow'::"text", 'email_intake'::"text", 'backdoor'::"text", 'manual_upload'::"text", 'audit'::"text"]))),
    CONSTRAINT "leases_lifecycle_status_check" CHECK (("lifecycle_status" = ANY (ARRAY['draft'::"text", 'submitted'::"text", 'under_review'::"text", 'approved'::"text", 'executed'::"text", 'active'::"text", 'expired'::"text", 'rejected'::"text", 'cancelled'::"text", 'concept_submitted'::"text", 'concept_under_review'::"text", 'in_negotiation'::"text", 'final_review'::"text", 'pending_counter_signature'::"text", 'fully_executed'::"text", 'chain_violation'::"text"]))),
    CONSTRAINT "leases_signator_attestation_required" CHECK ((("signator_approved_at" IS NULL) OR (("signator_approved_at" IS NOT NULL) AND ("signator_attestation" IS NOT NULL) AND ("length"(TRIM(BOTH FROM "signator_attestation")) > 0)))),
    CONSTRAINT "leases_status_check" CHECK (("status" = ANY (ARRAY['Uploaded'::"text", 'Processing'::"text", 'Ready'::"text", 'Failed'::"text", 'Needs Review'::"text"]))),
    CONSTRAINT "leases_type_check" CHECK ((("lease_type" IS NULL) OR ("lease_type" = ANY (ARRAY['Real Estate'::"text", 'Equipment'::"text", 'master'::"text", 'amendment'::"text"]))))
);


ALTER TABLE "public"."leases" OWNER TO "postgres";


COMMENT ON COLUMN "public"."leases"."property_address" IS 'Full address of leased premises — extracted by AI, editable in workbench';



COMMENT ON COLUMN "public"."leases"."rent_commencement_date" IS 'Date rent obligations begin (may differ from lease_start)';



COMMENT ON COLUMN "public"."leases"."security_deposit" IS 'Security deposit amount as extracted from document';



COMMENT ON COLUMN "public"."leases"."renewal_options" IS 'Summary of renewal / extension option terms';



COMMENT ON COLUMN "public"."leases"."escalation_clauses" IS 'Detailed description of rent escalation methodology';



COMMENT ON COLUMN "public"."leases"."termination_clauses" IS 'Summary of termination and break clause provisions';



COMMENT ON COLUMN "public"."leases"."intake_source" IS 'How this lease entered the system: request_workflow (Path 1), email_intake (Path 2), backdoor (historical onboarding), manual_upload (direct upload)';



COMMENT ON COLUMN "public"."leases"."signator_attestation" IS 'Free-text attestation captured at signator approval. Required (per CHECK constraint) when signator_approved_at is set. Becomes part of the audit trail.';



COMMENT ON COLUMN "public"."leases"."counter_signature_due_date" IS 'Date by which the counter-signed document is expected. Populated when the lease enters pending_counter_signature. Drives the reminder cadence.';



COMMENT ON COLUMN "public"."leases"."counter_signature_reminder_count" IS 'Number of reminders sent for counter-signature. Incremented by send-counter-signature-reminder edge function; used for idempotency + escalation.';



CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "lease_id" "uuid",
    "alert_type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ops_admins" (
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "added_by" "uuid",
    "note" "text"
);


ALTER TABLE "public"."ops_admins" OWNER TO "postgres";


COMMENT ON TABLE "public"."ops_admins" IS 'Allowlist of users who can read Operational Monitoring data (vendor health, renewals, alerts). Replaces the hardcoded workspace UUID in is_ops_admin. Only mutated via service-role.';



CREATE TABLE IF NOT EXISTS "public"."processing_rate_limits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "function_name" "text" NOT NULL,
    "window_start" timestamp with time zone NOT NULL,
    "request_count" integer DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."processing_rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "plan" "text" DEFAULT 'free'::"text" NOT NULL,
    "processed_count" integer DEFAULT 0 NOT NULL,
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "subscription_status" "text",
    "subscription_period_end" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "company_name" "text",
    "timezone" "text" DEFAULT 'America/New_York'::"text",
    "billing_interval" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "trial_ends_at" timestamp with time zone,
    "email_notifications_enabled" boolean DEFAULT true NOT NULL,
    "sms_notifications_enabled" boolean DEFAULT false NOT NULL,
    "current_workspace_id" "uuid",
    "ai_processing_consent_at" timestamp with time zone,
    "notify_abstraction_complete" boolean DEFAULT true NOT NULL,
    CONSTRAINT "profiles_plan_check" CHECK (("plan" = ANY (ARRAY['free'::"text", 'starter'::"text", 'pro'::"text", 'business'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."notify_abstraction_complete" IS 'When true, the user receives a notification when the AI extraction pipeline finishes processing a lease they uploaded. Default true.';



CREATE TABLE IF NOT EXISTS "public"."rent_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "period_start" "date" NOT NULL,
    "period_end" "date",
    "monthly_amount" numeric(12,2),
    "annual_amount" numeric(12,2),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rent_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."risk_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid",
    "is_system" boolean DEFAULT false NOT NULL,
    "title" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "default_explanation" "text" NOT NULL,
    "asset_type" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "risk_templates_scope_check" CHECK (((("is_system" = true) AND ("workspace_id" IS NULL)) OR (("is_system" = false) AND ("workspace_id" IS NOT NULL)))),
    CONSTRAINT "risk_templates_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text"])))
);


ALTER TABLE "public"."risk_templates" OWNER TO "postgres";


COMMENT ON TABLE "public"."risk_templates" IS 'Library of predefined risks, both system-wide and workspace-custom. Used by the "+ Risk" workflow to seed risk titles, severities, and default explanations.';



CREATE TABLE IF NOT EXISTS "public"."risks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "explanation" "text",
    "citation_page" integer,
    "citation_snippet" "text",
    "dismissed_at" timestamp with time zone,
    "dismissed_by" "uuid",
    "dismissed_reason" "text",
    "created_by" "uuid",
    "is_user_added" boolean DEFAULT false NOT NULL,
    "risk_template_id" "uuid",
    "source_text_norm" "text",
    CONSTRAINT "risks_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text"])))
);


ALTER TABLE "public"."risks" OWNER TO "postgres";


COMMENT ON COLUMN "public"."risks"."dismissed_at" IS 'Set when a user dismisses the risk; null means active. Filtered out of all reporting surfaces by default.';



COMMENT ON COLUMN "public"."risks"."dismissed_by" IS 'auth.users.id of the user who dismissed this risk.';



COMMENT ON COLUMN "public"."risks"."dismissed_reason" IS 'Optional free-text reason captured at dismiss time.';



COMMENT ON COLUMN "public"."risks"."is_user_added" IS 'TRUE when this risk was created by a user via the "+ Risk" UI rather than the AI extraction pipeline.';



COMMENT ON COLUMN "public"."risks"."risk_template_id" IS 'If the risk was instantiated from a template, the template id (template may be edited or deleted independently).';



CREATE TABLE IF NOT EXISTS "public"."summary_views" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "viewed_at" timestamp with time zone DEFAULT "now"(),
    "viewer_ip" "text",
    "referrer" "text"
);


ALTER TABLE "public"."summary_views" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_out_of_office" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "delegate_user_id" "uuid" NOT NULL,
    "reason" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ooo_no_self_delegation" CHECK (("user_id" <> "delegate_user_id")),
    CONSTRAINT "ooo_valid_window" CHECK (("starts_at" < "ends_at"))
);


ALTER TABLE "public"."user_out_of_office" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_preferences" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "onboarding_dismissed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_preferences" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_correction_analytics" WITH ("security_invoker"='on') AS
 SELECT "field_name",
    "count"(*) AS "total_corrections",
    "avg"("ai_confidence") AS "avg_original_confidence",
    "count"(DISTINCT "lease_id") AS "leases_affected",
    "max"("corrected_at") AS "last_correction"
   FROM "public"."field_corrections" "fc"
  GROUP BY "field_name"
  ORDER BY ("count"(*)) DESC;


ALTER VIEW "public"."v_correction_analytics" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."v_governance_audit_report" WITH ("security_invoker"='true') AS
 SELECT "gau"."id",
    "gau"."created_at" AS "event_timestamp",
    "gau"."event_type",
    "gau"."workspace_id",
    "gau"."lease_id",
    COALESCE("l"."request_title", "l"."filename", 'Unnamed lease'::"text") AS "lease_name",
    "gau"."actor_user_id",
    "gau"."actor_email",
    "gau"."related_unlock_request_id",
    "gau"."related_change_set_id",
    "gau"."field_name",
    "gau"."field_label",
    "gau"."old_value",
    "gau"."proposed_value",
    "gau"."final_value",
    "gau"."change_summary",
    "gau"."rejection_reason",
    "gau"."cancellation_reason"
   FROM ("public"."lease_governance_audit" "gau"
     JOIN "public"."leases" "l" ON (("l"."id" = "gau"."lease_id")))
  ORDER BY "gau"."created_at" DESC;


ALTER VIEW "public"."v_governance_audit_report" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_governance_audit_report" IS 'Audit-report view for governance events. Created WITH (security_invoker = true) so the caller''s RLS applies to lease_governance_audit and leases — workspace members see only their workspace''s rows. Audit P1-09.';



CREATE TABLE IF NOT EXISTS "public"."workspaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "plan" "text" DEFAULT 'pro'::"text" NOT NULL,
    "document_limit" integer DEFAULT 3 NOT NULL,
    "documents_used" integer DEFAULT 0 NOT NULL,
    "timezone" "text" DEFAULT 'America/New_York'::"text" NOT NULL,
    "default_notification_days" integer DEFAULT 90 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "billing_interval" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "discount_rate" numeric DEFAULT 5.5,
    "covenant_threshold" numeric,
    "approval_threshold" numeric DEFAULT 0,
    "backdoor_enabled" boolean DEFAULT false NOT NULL,
    "asset_type_config" "jsonb" DEFAULT '["Real Estate", "Equipment", "Vehicle", "Other"]'::"jsonb",
    "department_options" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "region_options" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "location_options" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "building_options" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "max_archived_leases" integer,
    "separation_of_duties_default" boolean DEFAULT true NOT NULL,
    "counter_signature_default_due_days" integer DEFAULT 21 NOT NULL,
    "report_organization_name" "text",
    "report_fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
    "report_rounding_precision" integer DEFAULT 2 NOT NULL,
    "report_artifact_retention_days" integer DEFAULT 90 NOT NULL,
    "report_default_discount_method" "text" DEFAULT 'workspace_default'::"text",
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "subscription_status" "text",
    "subscription_period_end" timestamp with time zone,
    "intended_plan" "text",
    CONSTRAINT "workspaces_counter_signature_due_days_range" CHECK ((("counter_signature_default_due_days" >= 1) AND ("counter_signature_default_due_days" <= 365))),
    CONSTRAINT "workspaces_report_artifact_retention_days_check" CHECK ((("report_artifact_retention_days" >= 1) AND ("report_artifact_retention_days" <= 730))),
    CONSTRAINT "workspaces_report_default_discount_method_check" CHECK (("report_default_discount_method" = ANY (ARRAY['workspace_default'::"text", 'risk_free_rate'::"text", 'incremental_borrowing_rate'::"text", 'custom'::"text"]))),
    CONSTRAINT "workspaces_report_fiscal_year_start_month_check" CHECK ((("report_fiscal_year_start_month" >= 1) AND ("report_fiscal_year_start_month" <= 12))),
    CONSTRAINT "workspaces_report_rounding_precision_check" CHECK ((("report_rounding_precision" >= 0) AND ("report_rounding_precision" <= 6)))
);


ALTER TABLE "public"."workspaces" OWNER TO "postgres";


COMMENT ON COLUMN "public"."workspaces"."backdoor_enabled" IS 'When true, enables the historical portfolio bulk-upload form for this workspace. Admin-controlled: on during onboarding, off after.';



COMMENT ON COLUMN "public"."workspaces"."counter_signature_default_due_days" IS 'Default number of days from signator approval until counter-signed document is expected. Used by act-on-chain-step to compute counter_signature_due_date when transitioning a lease to pending_counter_signature.';



COMMENT ON COLUMN "public"."workspaces"."intended_plan" IS 'User-declared plan at workspace creation. Not an entitlement — Stripe webhook owns workspaces.plan. Used to recover abandoned checkout flows.';



CREATE OR REPLACE VIEW "public"."v_lease_verification_audit" WITH ("security_invoker"='true') AS
 SELECT "l"."id" AS "lease_id",
    "l"."workspace_id",
    "l"."confirmed_sections",
    "l"."model_locked",
    "l"."model_locked_at",
    "l"."model_locked_by",
    "l"."lease_classification_set_at",
    "l"."lease_classification_set_by",
    COALESCE("l"."discount_rate", "w"."discount_rate") AS "discount_rate",
    "l"."discount_rate" AS "discount_rate_per_lease_override",
    "w"."discount_rate" AS "discount_rate_workspace_default",
    "l"."discount_rate_basis",
    "l"."discount_rate_set_at",
    "l"."discount_rate_set_by",
    "l"."signator_attestation",
    "l"."signator_approved_at",
    COALESCE(( SELECT "jsonb_agg"("jsonb_build_object"('field_id', "fc"."field_name", 'original_value', "fc"."original_value", 'corrected_value', "fc"."corrected_value", 'correction_type', "fc"."correction_type", 'corrected_at', "fc"."corrected_at", 'corrected_by', "fc"."corrected_by", 'ai_confidence_at_correction', "fc"."ai_confidence") ORDER BY "fc"."corrected_at") AS "jsonb_agg"
           FROM "public"."field_corrections" "fc"
          WHERE ("fc"."lease_id" = "l"."id")), '[]'::"jsonb") AS "field_corrections"
   FROM ("public"."leases" "l"
     LEFT JOIN "public"."workspaces" "w" ON (("w"."id" = "l"."workspace_id")));


ALTER VIEW "public"."v_lease_verification_audit" OWNER TO "postgres";


COMMENT ON VIEW "public"."v_lease_verification_audit" IS 'Verification audit aggregate for ASC 842 disclosure reports. Created WITH (security_invoker = true). The discount_rate column is the EFFECTIVE rate (per-lease override if set, else workspace default). Audit P1-09.';



CREATE OR REPLACE VIEW "public"."v_review_queue" WITH ("security_invoker"='on') AS
 SELECT "id",
    "filename",
    "tenant_name",
    "landlord_name",
    "status",
    "avg_confidence_score",
    "uploaded_at",
    "user_id",
    "workspace_id",
    COALESCE((("extracted_json" ->> '_fields_requiring_review'::"text"))::"text"[], '{}'::"text"[]) AS "fields_requiring_review",
    "array_length"(COALESCE((("extracted_json" ->> '_fields_requiring_review'::"text"))::"text"[], '{}'::"text"[]), 1) AS "review_field_count"
   FROM "public"."leases" "l"
  WHERE ("status" = 'Needs Review'::"text")
  ORDER BY "avg_confidence_score", "uploaded_at";


ALTER VIEW "public"."v_review_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_alert_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor" "text" NOT NULL,
    "metric" "text" NOT NULL,
    "threshold_crossed" "text" NOT NULL,
    "current_value" numeric,
    "limit_value" numeric,
    "pct_of_limit" numeric,
    "upgrade_suggestion" "text",
    "upgrade_url" "text",
    "fired_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "acknowledged_at" timestamp with time zone,
    "acknowledged_by" "uuid",
    CONSTRAINT "vendor_alert_log_threshold_crossed_check" CHECK (("threshold_crossed" = ANY (ARRAY['warn'::"text", 'alert'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."vendor_alert_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_alert_recipients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vendor_alert_recipients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_renewal_calendar" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor" "text" NOT NULL,
    "item" "text" NOT NULL,
    "renewal_date" "date" NOT NULL,
    "amount_estimate" numeric,
    "reminder_days_before" integer[] DEFAULT ARRAY[60, 30, 14, 7, 1] NOT NULL,
    "auto_renew" boolean DEFAULT false NOT NULL,
    "account_url" "text",
    "notes" "text",
    "last_alerted_at" timestamp with time zone
);


ALTER TABLE "public"."vendor_renewal_calendar" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_usage_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor" "text" NOT NULL,
    "metric" "text" NOT NULL,
    "current_value" numeric NOT NULL,
    "limit_value" numeric,
    "pct_of_limit" numeric,
    "tier" "text",
    "category" "text" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "vendor_usage_snapshots_category_check" CHECK (("category" = ANY (ARRAY['soft_quota'::"text", 'hard_cliff'::"text", 'cost_runaway'::"text"])))
);


ALTER TABLE "public"."vendor_usage_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_approvers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid"
);


ALTER TABLE "public"."workspace_approvers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role" "public"."workspace_role" DEFAULT 'viewer'::"public"."workspace_role" NOT NULL,
    "invited_email" "text",
    "invited_at" timestamp with time zone,
    "accepted_at" timestamp with time zone
);


ALTER TABLE "public"."workspace_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_quota_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "metric" "text" NOT NULL,
    "current_value" numeric NOT NULL,
    "limit_value" numeric,
    "pct_of_limit" numeric,
    "tier" "text",
    "category" "text" NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "workspace_quota_snapshots_category_check" CHECK (("category" = ANY (ARRAY['soft_quota'::"text", 'hard_cliff'::"text", 'cost_runaway'::"text"])))
);


ALTER TABLE "public"."workspace_quota_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "workspace_roles_role_check" CHECK (("role" = ANY (ARRAY['submitter'::"text", 'manager_approver'::"text", 'financial_approver'::"text", 'signator'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."workspace_roles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."alert_rules"
    ADD CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alert_rules"
    ADD CONSTRAINT "alert_rules_workspace_id_alert_type_key" UNIQUE ("workspace_id", "alert_type");



ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."approval_policies"
    ADD CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chain_step_overrides"
    ADD CONSTRAINT "chain_step_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chain_step_voluntary_delegations"
    ADD CONSTRAINT "chain_step_voluntary_delegations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."classification_corrections"
    ADD CONSTRAINT "classification_corrections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deleted_workspaces"
    ADD CONSTRAINT "deleted_workspaces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dismissed_events"
    ADD CONSTRAINT "dismissed_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dismissed_events"
    ADD CONSTRAINT "dismissed_events_user_id_workspace_id_event_key_key" UNIQUE ("user_id", "workspace_id", "event_key");



ALTER TABLE ONLY "public"."executed_term_edits"
    ADD CONSTRAINT "executed_term_edits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."field_corrections"
    ADD CONSTRAINT "field_corrections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invite_tokens"
    ADD CONSTRAINT "invite_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invite_tokens"
    ADD CONSTRAINT "invite_tokens_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."lease_activity_log"
    ADD CONSTRAINT "lease_activity_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_approval_actions"
    ADD CONSTRAINT "lease_approval_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_approvers"
    ADD CONSTRAINT "lease_approvers_lease_id_approver_id_approval_type_key" UNIQUE ("lease_id", "approver_id", "approval_type");



ALTER TABLE ONLY "public"."lease_approvers"
    ADD CONSTRAINT "lease_approvers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_asc842_inputs"
    ADD CONSTRAINT "lease_asc842_inputs_lease_id_key" UNIQUE ("lease_id");



ALTER TABLE ONLY "public"."lease_asc842_inputs"
    ADD CONSTRAINT "lease_asc842_inputs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_attribute_snapshots"
    ADD CONSTRAINT "lease_attribute_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_change_set_items"
    ADD CONSTRAINT "lease_change_set_items_change_set_field_unique" UNIQUE ("change_set_id", "field_name");



ALTER TABLE ONLY "public"."lease_change_set_items"
    ADD CONSTRAINT "lease_change_set_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_change_sets"
    ADD CONSTRAINT "lease_change_sets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_documents"
    ADD CONSTRAINT "lease_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_field_confidence"
    ADD CONSTRAINT "lease_field_confidence_lease_id_field_name_key" UNIQUE ("lease_id", "field_name");



ALTER TABLE ONLY "public"."lease_field_confidence"
    ADD CONSTRAINT "lease_field_confidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_governance_audit"
    ADD CONSTRAINT "lease_governance_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_insights"
    ADD CONSTRAINT "lease_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_notifications"
    ADD CONSTRAINT "lease_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_nudges"
    ADD CONSTRAINT "lease_nudges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_reports"
    ADD CONSTRAINT "lease_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_reroute_events"
    ADD CONSTRAINT "lease_reroute_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_state_transitions"
    ADD CONSTRAINT "lease_state_transitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lease_unlock_requests"
    ADD CONSTRAINT "lease_unlock_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_summary_share_token_key" UNIQUE ("summary_share_token");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ops_admins"
    ADD CONSTRAINT "ops_admins_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."processing_rate_limits"
    ADD CONSTRAINT "processing_rate_limits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."processing_rate_limits"
    ADD CONSTRAINT "processing_rate_limits_workspace_id_function_name_window_st_key" UNIQUE ("workspace_id", "function_name", "window_start");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rent_schedules"
    ADD CONSTRAINT "rent_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."risk_templates"
    ADD CONSTRAINT "risk_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."risks"
    ADD CONSTRAINT "risks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."summary_views"
    ADD CONSTRAINT "summary_views_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_out_of_office"
    ADD CONSTRAINT "user_out_of_office_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_workspace_id_key" UNIQUE ("user_id", "workspace_id");



ALTER TABLE ONLY "public"."vendor_alert_log"
    ADD CONSTRAINT "vendor_alert_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_alert_recipients"
    ADD CONSTRAINT "vendor_alert_recipients_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."vendor_alert_recipients"
    ADD CONSTRAINT "vendor_alert_recipients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_renewal_calendar"
    ADD CONSTRAINT "vendor_renewal_calendar_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vendor_usage_snapshots"
    ADD CONSTRAINT "vendor_usage_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_approvers"
    ADD CONSTRAINT "workspace_approvers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_approvers"
    ADD CONSTRAINT "workspace_approvers_workspace_id_user_id_key" UNIQUE ("workspace_id", "user_id");



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_workspace_id_user_id_key" UNIQUE ("workspace_id", "user_id");



ALTER TABLE ONLY "public"."workspace_quota_snapshots"
    ADD CONSTRAINT "workspace_quota_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_roles"
    ADD CONSTRAINT "workspace_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_roles"
    ADD CONSTRAINT "workspace_roles_workspace_id_user_id_role_key" UNIQUE ("workspace_id", "user_id", "role");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "idx_alert_dedupe" ON "public"."vendor_alert_log" USING "btree" ("vendor", "metric", "threshold_crossed", ((("fired_at" AT TIME ZONE 'UTC'::"text"))::"date"));



CREATE INDEX "idx_alert_rules_workspace" ON "public"."alert_rules" USING "btree" ("workspace_id");



CREATE INDEX "idx_approval_chain_steps_approver_user_id" ON "public"."approval_chain_steps" USING "btree" ("approver_user_id");



CREATE INDEX "idx_approval_chain_steps_delegate_user_id" ON "public"."approval_chain_steps" USING "btree" ("delegate_user_id");



CREATE INDEX "idx_approval_chain_steps_policy" ON "public"."approval_chain_steps" USING "btree" ("policy_id", "stage", "step_order");



CREATE INDEX "idx_approval_policies_created_by" ON "public"."approval_policies" USING "btree" ("created_by");



CREATE UNIQUE INDEX "idx_approval_policies_one_default_per_workspace" ON "public"."approval_policies" USING "btree" ("workspace_id") WHERE (("is_default_fallback" = true) AND ("is_active" = true));



CREATE INDEX "idx_approval_policies_updated_by" ON "public"."approval_policies" USING "btree" ("updated_by");



CREATE INDEX "idx_approval_policies_workspace_active" ON "public"."approval_policies" USING "btree" ("workspace_id", "is_active");



CREATE INDEX "idx_chain_pending_delegate_timer" ON "public"."lease_approval_chain" USING "btree" ("pending_since") WHERE (("status" = 'pending'::"text") AND ("delegate_user_id" IS NOT NULL) AND ("delegate_after_days" IS NOT NULL) AND ("delegate_activated_at" IS NULL));



CREATE INDEX "idx_chain_pending_since" ON "public"."lease_approval_chain" USING "btree" ("pending_since") WHERE (("status" = 'pending'::"text") AND ("pending_since" IS NOT NULL));



CREATE INDEX "idx_chain_step_overrides_chain_step_id" ON "public"."chain_step_overrides" USING "btree" ("chain_step_id");



CREATE INDEX "idx_chain_step_overrides_lease" ON "public"."chain_step_overrides" USING "btree" ("lease_id", "override_at" DESC);



CREATE INDEX "idx_chain_step_overrides_override_by" ON "public"."chain_step_overrides" USING "btree" ("override_by");



CREATE INDEX "idx_chain_step_overrides_prior_assignee_user_id" ON "public"."chain_step_overrides" USING "btree" ("prior_assignee_user_id");



CREATE INDEX "idx_chain_step_overrides_reassigned_to_user_id" ON "public"."chain_step_overrides" USING "btree" ("reassigned_to_user_id");



CREATE INDEX "idx_chain_step_overrides_workspace_recent" ON "public"."chain_step_overrides" USING "btree" ("workspace_id", "override_at" DESC);



CREATE INDEX "idx_chain_step_voluntary_delegations_delegated_by" ON "public"."chain_step_voluntary_delegations" USING "btree" ("delegated_by");



CREATE INDEX "idx_chain_step_voluntary_delegations_delegated_to" ON "public"."chain_step_voluntary_delegations" USING "btree" ("delegated_to");



CREATE INDEX "idx_chain_step_voluntary_delegations_lease_id" ON "public"."chain_step_voluntary_delegations" USING "btree" ("lease_id");



CREATE INDEX "idx_chain_step_voluntary_delegations_revoked_by" ON "public"."chain_step_voluntary_delegations" USING "btree" ("revoked_by");



CREATE INDEX "idx_chain_step_voluntary_delegations_workspace_id" ON "public"."chain_step_voluntary_delegations" USING "btree" ("workspace_id");



CREATE INDEX "idx_classification_corrections_lease" ON "public"."classification_corrections" USING "btree" ("lease_id", "created_at" DESC) WHERE ("lease_id" IS NOT NULL);



CREATE INDEX "idx_classification_corrections_workspace_recent" ON "public"."classification_corrections" USING "btree" ("workspace_id", "created_at" DESC);



CREATE INDEX "idx_corrections_created_at" ON "public"."field_corrections" USING "btree" ("corrected_at" DESC);



CREATE INDEX "idx_corrections_field_name" ON "public"."field_corrections" USING "btree" ("field_name");



CREATE INDEX "idx_corrections_lease_id" ON "public"."field_corrections" USING "btree" ("lease_id");



CREATE INDEX "idx_deleted_workspaces_deleted_by" ON "public"."deleted_workspaces" USING "btree" ("deleted_by");



CREATE INDEX "idx_deleted_workspaces_owner" ON "public"."deleted_workspaces" USING "btree" ("owner_id", "deleted_at" DESC);



CREATE INDEX "idx_dismissed_events_workspace_id" ON "public"."dismissed_events" USING "btree" ("workspace_id");



CREATE INDEX "idx_executed_term_edits_edited_by" ON "public"."executed_term_edits" USING "btree" ("edited_by");



CREATE INDEX "idx_executed_term_edits_lease_id" ON "public"."executed_term_edits" USING "btree" ("lease_id");



CREATE INDEX "idx_field_confidence_lease_id" ON "public"."lease_field_confidence" USING "btree" ("lease_id");



CREATE INDEX "idx_field_confidence_low_scores" ON "public"."lease_field_confidence" USING "btree" ("confidence_score") WHERE ("confidence_score" < 0.85);



CREATE INDEX "idx_field_corrections_lease_id" ON "public"."field_corrections" USING "btree" ("lease_id");



CREATE INDEX "idx_governance_audit_change_set_id" ON "public"."lease_governance_audit" USING "btree" ("related_change_set_id") WHERE ("related_change_set_id" IS NOT NULL);



CREATE INDEX "idx_governance_audit_lease_id" ON "public"."lease_governance_audit" USING "btree" ("lease_id", "created_at" DESC);



CREATE INDEX "idx_governance_audit_workspace_id" ON "public"."lease_governance_audit" USING "btree" ("workspace_id", "created_at" DESC);



CREATE INDEX "idx_lease_activity_log_lease_id" ON "public"."lease_activity_log" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_activity_log_user_id" ON "public"."lease_activity_log" USING "btree" ("user_id");



CREATE INDEX "idx_lease_approval_actions_approver_id" ON "public"."lease_approval_actions" USING "btree" ("approver_id");



CREATE INDEX "idx_lease_approval_actions_lease_id" ON "public"."lease_approval_actions" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_approval_chain_action_by" ON "public"."lease_approval_chain" USING "btree" ("action_by");



CREATE INDEX "idx_lease_approval_chain_assignee_pending" ON "public"."lease_approval_chain" USING "btree" ("approver_user_id", "status") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_lease_approval_chain_delegate_user_id" ON "public"."lease_approval_chain" USING "btree" ("delegate_user_id");



CREATE INDEX "idx_lease_approval_chain_effective_assignee_user_id" ON "public"."lease_approval_chain" USING "btree" ("effective_assignee_user_id");



CREATE INDEX "idx_lease_approval_chain_lease" ON "public"."lease_approval_chain" USING "btree" ("lease_id", "stage", "step_order");



CREATE INDEX "idx_lease_approval_chain_policy_id" ON "public"."lease_approval_chain" USING "btree" ("policy_id");



CREATE INDEX "idx_lease_approval_chain_rerouted_from_chain_id" ON "public"."lease_approval_chain" USING "btree" ("rerouted_from_chain_id");



CREATE INDEX "idx_lease_approval_chain_workspace_pending" ON "public"."lease_approval_chain" USING "btree" ("workspace_id", "status") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_lease_approvers_approver_id" ON "public"."lease_approvers" USING "btree" ("approver_id");



CREATE INDEX "idx_lease_approvers_lease_id" ON "public"."lease_approvers" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_asc842_inputs_last_updated_by" ON "public"."lease_asc842_inputs" USING "btree" ("last_updated_by");



CREATE INDEX "idx_lease_asc842_inputs_workspace" ON "public"."lease_asc842_inputs" USING "btree" ("workspace_id");



CREATE INDEX "idx_lease_attribute_snapshots_lease_chronological" ON "public"."lease_attribute_snapshots" USING "btree" ("lease_id", "chain_resolution_at" DESC);



CREATE INDEX "idx_lease_attribute_snapshots_policy_id" ON "public"."lease_attribute_snapshots" USING "btree" ("policy_id");



CREATE INDEX "idx_lease_attribute_snapshots_workspace_id" ON "public"."lease_attribute_snapshots" USING "btree" ("workspace_id");



CREATE INDEX "idx_lease_change_set_items_change_set_id" ON "public"."lease_change_set_items" USING "btree" ("change_set_id");



CREATE INDEX "idx_lease_change_sets_lease_id" ON "public"."lease_change_sets" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_change_sets_reviewed_by" ON "public"."lease_change_sets" USING "btree" ("reviewed_by");



CREATE INDEX "idx_lease_change_sets_submitted_by" ON "public"."lease_change_sets" USING "btree" ("submitted_by");



CREATE INDEX "idx_lease_change_sets_workspace_status" ON "public"."lease_change_sets" USING "btree" ("workspace_id", "status");



CREATE INDEX "idx_lease_documents_lease_chronological" ON "public"."lease_documents" USING "btree" ("lease_id", "iteration_number", "version_number");



CREATE UNIQUE INDEX "idx_lease_documents_one_current_latest_per_lease" ON "public"."lease_documents" USING "btree" ("lease_id") WHERE ("is_current_latest" = true);



CREATE INDEX "idx_lease_documents_superseded_by" ON "public"."lease_documents" USING "btree" ("superseded_by");



CREATE INDEX "idx_lease_documents_uploaded_by" ON "public"."lease_documents" USING "btree" ("uploaded_by");



CREATE INDEX "idx_lease_documents_workspace" ON "public"."lease_documents" USING "btree" ("workspace_id");



CREATE INDEX "idx_lease_field_confidence_lease_id" ON "public"."lease_field_confidence" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_field_confidence_score" ON "public"."lease_field_confidence" USING "btree" ("confidence_score");



CREATE INDEX "idx_lease_insights_lease_recent" ON "public"."lease_insights" USING "btree" ("lease_id", "generated_at" DESC);



CREATE INDEX "idx_lease_insights_workspace_recent" ON "public"."lease_insights" USING "btree" ("workspace_id", "generated_at" DESC);



CREATE INDEX "idx_lease_notifications_confirmed" ON "public"."lease_notifications" USING "btree" ("is_confirmed") WHERE ("is_confirmed" = true);



CREATE INDEX "idx_lease_notifications_event_date" ON "public"."lease_notifications" USING "btree" ("event_date");



CREATE INDEX "idx_lease_notifications_lease_id" ON "public"."lease_notifications" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_nudges_lease_id" ON "public"."lease_nudges" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_nudges_sent_by" ON "public"."lease_nudges" USING "btree" ("sent_by");



CREATE INDEX "idx_lease_reports_generated_by" ON "public"."lease_reports" USING "btree" ("generated_by");



CREATE INDEX "idx_lease_reports_lease" ON "public"."lease_reports" USING "btree" ("lease_id", "generated_at" DESC) WHERE ("lease_id" IS NOT NULL);



CREATE INDEX "idx_lease_reports_period" ON "public"."lease_reports" USING "btree" ("workspace_id", "period_start", "period_end") WHERE ("period_start" IS NOT NULL);



CREATE INDEX "idx_lease_reports_workspace_chronological" ON "public"."lease_reports" USING "btree" ("workspace_id", "generated_at" DESC);



CREATE INDEX "idx_lease_reroute_events_lease_chronological" ON "public"."lease_reroute_events" USING "btree" ("lease_id", "triggered_at" DESC);



CREATE INDEX "idx_lease_reroute_events_new_policy_id" ON "public"."lease_reroute_events" USING "btree" ("new_policy_id");



CREATE INDEX "idx_lease_reroute_events_prior_policy_id" ON "public"."lease_reroute_events" USING "btree" ("prior_policy_id");



CREATE INDEX "idx_lease_reroute_events_triggered_by" ON "public"."lease_reroute_events" USING "btree" ("triggered_by");



CREATE INDEX "idx_lease_reroute_events_workspace_chain_violations" ON "public"."lease_reroute_events" USING "btree" ("workspace_id", "triggered_at") WHERE ("resulted_in_chain_violation" = true);



CREATE INDEX "idx_lease_unlock_requests_lease_id" ON "public"."lease_unlock_requests" USING "btree" ("lease_id");



CREATE INDEX "idx_lease_unlock_requests_requested_by" ON "public"."lease_unlock_requests" USING "btree" ("requested_by");



CREATE INDEX "idx_lease_unlock_requests_reviewed_by" ON "public"."lease_unlock_requests" USING "btree" ("reviewed_by");



CREATE INDEX "idx_lease_unlock_requests_workspace_status" ON "public"."lease_unlock_requests" USING "btree" ("workspace_id", "status");



CREATE INDEX "idx_leases_archived_by" ON "public"."leases" USING "btree" ("archived_by");



CREATE INDEX "idx_leases_avg_confidence" ON "public"."leases" USING "btree" ("avg_confidence_score") WHERE ("avg_confidence_score" IS NOT NULL);



CREATE INDEX "idx_leases_discount_rate_set_at" ON "public"."leases" USING "btree" ("workspace_id", "discount_rate_set_at" DESC) WHERE ("discount_rate" IS NOT NULL);



CREATE INDEX "idx_leases_discount_rate_set_by" ON "public"."leases" USING "btree" ("discount_rate_set_by");



CREATE INDEX "idx_leases_executed_uploaded_by" ON "public"."leases" USING "btree" ("executed_uploaded_by");



CREATE INDEX "idx_leases_execution_owner_id" ON "public"."leases" USING "btree" ("execution_owner_id");



CREATE INDEX "idx_leases_financial_approved_by" ON "public"."leases" USING "btree" ("financial_approved_by");



CREATE INDEX "idx_leases_lease_classification_set_by" ON "public"."leases" USING "btree" ("lease_classification_set_by");



CREATE INDEX "idx_leases_lease_owner_id" ON "public"."leases" USING "btree" ("lease_owner_id");



CREATE INDEX "idx_leases_lifecycle_status" ON "public"."leases" USING "btree" ("lifecycle_status");



CREATE INDEX "idx_leases_manager_approved_by" ON "public"."leases" USING "btree" ("manager_approved_by");



CREATE INDEX "idx_leases_model_locked" ON "public"."leases" USING "btree" ("model_locked") WHERE ("model_locked" = true);



CREATE INDEX "idx_leases_model_locked_by" ON "public"."leases" USING "btree" ("model_locked_by");



CREATE INDEX "idx_leases_parent_lease_id" ON "public"."leases" USING "btree" ("parent_lease_id") WHERE ("parent_lease_id" IS NOT NULL);



CREATE INDEX "idx_leases_review_queue" ON "public"."leases" USING "btree" ("user_id", "status", "avg_confidence_score") WHERE ("status" = 'Needs Review'::"text");



CREATE INDEX "idx_leases_status" ON "public"."leases" USING "btree" ("status");



CREATE INDEX "idx_leases_unlock_requested_by" ON "public"."leases" USING "btree" ("unlock_requested_by");



CREATE INDEX "idx_leases_user_status" ON "public"."leases" USING "btree" ("user_id", "status");



CREATE INDEX "idx_leases_variance_reviewed_by" ON "public"."leases" USING "btree" ("variance_reviewed_by");



CREATE INDEX "idx_leases_workspace_id" ON "public"."leases" USING "btree" ("workspace_id");



CREATE INDEX "idx_notifications_lease" ON "public"."notifications" USING "btree" ("lease_id");



CREATE INDEX "idx_notifications_unread" ON "public"."notifications" USING "btree" ("workspace_id", "user_id") WHERE ("read_at" IS NULL);



CREATE INDEX "idx_notifications_user" ON "public"."notifications" USING "btree" ("user_id");



CREATE INDEX "idx_notifications_workspace" ON "public"."notifications" USING "btree" ("workspace_id");



CREATE INDEX "idx_profiles_email_lower" ON "public"."profiles" USING "btree" ("lower"("email"));



COMMENT ON INDEX "public"."idx_profiles_email_lower" IS 'Case-insensitive lookup for the invite-acceptance flow (P2-11). Used by get-invite-info + accept-invite to decide existing-account vs new-user path.';



CREATE INDEX "idx_rent_schedules_lease_id" ON "public"."rent_schedules" USING "btree" ("lease_id");



CREATE INDEX "idx_rent_schedules_period" ON "public"."rent_schedules" USING "btree" ("period_start", "period_end");



CREATE INDEX "idx_risk_templates_created_by" ON "public"."risk_templates" USING "btree" ("created_by");



CREATE INDEX "idx_risks_created_by" ON "public"."risks" USING "btree" ("created_by");



CREATE INDEX "idx_risks_dismissed_by" ON "public"."risks" USING "btree" ("dismissed_by");



CREATE INDEX "idx_state_transitions_date" ON "public"."lease_state_transitions" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_state_transitions_lease" ON "public"."lease_state_transitions" USING "btree" ("lease_id");



CREATE INDEX "idx_state_transitions_user" ON "public"."lease_state_transitions" USING "btree" ("transitioned_by");



CREATE INDEX "idx_user_ooo_active_window" ON "public"."user_out_of_office" USING "btree" ("user_id", "workspace_id", "starts_at", "ends_at") WHERE ("is_active" = true);



CREATE INDEX "idx_user_out_of_office_delegate_user_id" ON "public"."user_out_of_office" USING "btree" ("delegate_user_id");



CREATE INDEX "idx_user_out_of_office_workspace_id" ON "public"."user_out_of_office" USING "btree" ("workspace_id");



CREATE INDEX "idx_user_preferences_workspace_id" ON "public"."user_preferences" USING "btree" ("workspace_id");



CREATE INDEX "idx_vendor_alert_recent" ON "public"."vendor_alert_log" USING "btree" ("fired_at" DESC);



CREATE INDEX "idx_vendor_renewal_upcoming" ON "public"."vendor_renewal_calendar" USING "btree" ("renewal_date");



CREATE INDEX "idx_vendor_usage_recent" ON "public"."vendor_usage_snapshots" USING "btree" ("vendor", "metric", "recorded_at" DESC);



CREATE INDEX "idx_voluntary_delegations_active" ON "public"."chain_step_voluntary_delegations" USING "btree" ("chain_step_id", "delegated_at" DESC) WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_voluntary_delegations_step" ON "public"."chain_step_voluntary_delegations" USING "btree" ("chain_step_id");



CREATE INDEX "idx_workspace_approvers_created_by" ON "public"."workspace_approvers" USING "btree" ("created_by");



CREATE INDEX "idx_workspace_approvers_user_id" ON "public"."workspace_approvers" USING "btree" ("user_id");



CREATE INDEX "idx_workspace_approvers_workspace_id" ON "public"."workspace_approvers" USING "btree" ("workspace_id");



CREATE INDEX "idx_workspace_members_user_id" ON "public"."workspace_members" USING "btree" ("user_id");



CREATE INDEX "idx_workspace_quota_global" ON "public"."workspace_quota_snapshots" USING "btree" ("recorded_at" DESC);



CREATE INDEX "idx_workspace_quota_recent" ON "public"."workspace_quota_snapshots" USING "btree" ("workspace_id", "metric", "recorded_at" DESC);



CREATE INDEX "idx_workspace_roles_user_id" ON "public"."workspace_roles" USING "btree" ("user_id");



CREATE INDEX "idx_workspaces_owner_id" ON "public"."workspaces" USING "btree" ("owner_id");



CREATE INDEX "idx_workspaces_stripe_subscription_id" ON "public"."workspaces" USING "btree" ("stripe_subscription_id") WHERE ("stripe_subscription_id" IS NOT NULL);



CREATE INDEX "invite_tokens_workspace_id_idx" ON "public"."invite_tokens" USING "btree" ("workspace_id");



CREATE INDEX "lease_change_sets_requested_approver_id_idx" ON "public"."lease_change_sets" USING "btree" ("requested_approver_id") WHERE ("requested_approver_id" IS NOT NULL);



CREATE INDEX "lease_change_sets_unlock_request_id_idx" ON "public"."lease_change_sets" USING "btree" ("unlock_request_id") WHERE ("unlock_request_id" IS NOT NULL);



CREATE INDEX "lease_governance_audit_actor_user_id_idx" ON "public"."lease_governance_audit" USING "btree" ("actor_user_id") WHERE ("actor_user_id" IS NOT NULL);



CREATE INDEX "lease_governance_audit_related_unlock_request_id_idx" ON "public"."lease_governance_audit" USING "btree" ("related_unlock_request_id") WHERE ("related_unlock_request_id" IS NOT NULL);



CREATE INDEX "leases_archived_workspace_idx" ON "public"."leases" USING "btree" ("workspace_id", "archived");



CREATE INDEX "leases_summary_share_token_expires_at_idx" ON "public"."leases" USING "btree" ("summary_share_token_expires_at") WHERE ("summary_share_token_expires_at" IS NOT NULL);



CREATE INDEX "risk_templates_asset_type_idx" ON "public"."risk_templates" USING "btree" ("asset_type") WHERE ("asset_type" IS NOT NULL);



CREATE INDEX "risk_templates_workspace_idx" ON "public"."risk_templates" USING "btree" ("workspace_id", "is_system");



CREATE INDEX "risks_dismissed_at_idx" ON "public"."risks" USING "btree" ("lease_id", "dismissed_at");



CREATE INDEX "risks_is_user_added_idx" ON "public"."risks" USING "btree" ("lease_id", "is_user_added");



CREATE INDEX "risks_risk_template_id_idx" ON "public"."risks" USING "btree" ("risk_template_id") WHERE ("risk_template_id" IS NOT NULL);



CREATE INDEX "summary_views_lease_id_idx" ON "public"."summary_views" USING "btree" ("lease_id");



CREATE OR REPLACE TRIGGER "approval_policies_updated_at" BEFORE UPDATE ON "public"."approval_policies" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "approval_policies_version_increment" BEFORE UPDATE ON "public"."approval_policies" FOR EACH ROW WHEN ((("old"."name" IS DISTINCT FROM "new"."name") OR ("old"."match_asset_types" IS DISTINCT FROM "new"."match_asset_types") OR ("old"."match_departments" IS DISTINCT FROM "new"."match_departments") OR ("old"."match_min_annual_cost" IS DISTINCT FROM "new"."match_min_annual_cost") OR ("old"."match_max_annual_cost" IS DISTINCT FROM "new"."match_max_annual_cost") OR ("old"."match_regions" IS DISTINCT FROM "new"."match_regions") OR ("old"."match_lease_types" IS DISTINCT FROM "new"."match_lease_types") OR ("old"."priority" IS DISTINCT FROM "new"."priority") OR ("old"."separation_of_duties_override" IS DISTINCT FROM "new"."separation_of_duties_override"))) EXECUTE FUNCTION "public"."increment_policy_version"();



CREATE OR REPLACE TRIGGER "enforce_model_lock" BEFORE UPDATE ON "public"."leases" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_locked_lease_edits"();



CREATE OR REPLACE TRIGGER "lease_asc842_inputs_updated_at_trigger" BEFORE UPDATE ON "public"."lease_asc842_inputs" FOR EACH ROW EXECUTE FUNCTION "public"."lease_asc842_inputs_set_updated_at"();



CREATE OR REPLACE TRIGGER "lease_change_sets_updated_at" BEFORE UPDATE ON "public"."lease_change_sets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "lease_documents_latest_flag" AFTER INSERT ON "public"."lease_documents" FOR EACH ROW EXECUTE FUNCTION "public"."maintain_lease_document_latest_flag"();



CREATE OR REPLACE TRIGGER "lease_state_change_logger" AFTER UPDATE ON "public"."leases" FOR EACH ROW EXECUTE FUNCTION "public"."log_lease_state_change"();



CREATE OR REPLACE TRIGGER "lease_unlock_requests_updated_at" BEFORE UPDATE ON "public"."lease_unlock_requests" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "leases_detect_attribute_change" BEFORE UPDATE ON "public"."leases" FOR EACH ROW EXECUTE FUNCTION "public"."detect_lease_attribute_change"();



CREATE OR REPLACE TRIGGER "prevent_unauthorized_lease_workflow_edits" BEFORE UPDATE ON "public"."leases" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_unauthorized_lease_workflow_edits"();



CREATE OR REPLACE TRIGGER "track_correction_on_field" AFTER INSERT ON "public"."field_corrections" FOR EACH ROW EXECUTE FUNCTION "public"."mark_field_as_corrected"();



CREATE OR REPLACE TRIGGER "update_avg_confidence_on_insert" AFTER INSERT OR UPDATE ON "public"."lease_field_confidence" FOR EACH ROW EXECUTE FUNCTION "public"."update_lease_avg_confidence"();



CREATE OR REPLACE TRIGGER "update_lease_notifications_updated_at" BEFORE UPDATE ON "public"."lease_notifications" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_rent_schedules_updated_at" BEFORE UPDATE ON "public"."rent_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_workspaces_updated_at" BEFORE UPDATE ON "public"."workspaces" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "user_out_of_office_updated_at" BEFORE UPDATE ON "public"."user_out_of_office" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."alert_rules"
    ADD CONSTRAINT "alert_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_delegate_user_id_fkey" FOREIGN KEY ("delegate_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."approval_chain_steps"
    ADD CONSTRAINT "approval_chain_steps_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."approval_policies"
    ADD CONSTRAINT "approval_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."approval_policies"
    ADD CONSTRAINT "approval_policies_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."approval_policies"
    ADD CONSTRAINT "approval_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chain_step_overrides"
    ADD CONSTRAINT "chain_step_overrides_chain_step_id_fkey" FOREIGN KEY ("chain_step_id") REFERENCES "public"."lease_approval_chain"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chain_step_overrides"
    ADD CONSTRAINT "chain_step_overrides_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chain_step_overrides"
    ADD CONSTRAINT "chain_step_overrides_override_by_fkey" FOREIGN KEY ("override_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."chain_step_overrides"
    ADD CONSTRAINT "chain_step_overrides_prior_assignee_user_id_fkey" FOREIGN KEY ("prior_assignee_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."chain_step_overrides"
    ADD CONSTRAINT "chain_step_overrides_reassigned_to_user_id_fkey" FOREIGN KEY ("reassigned_to_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."chain_step_overrides"
    ADD CONSTRAINT "chain_step_overrides_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chain_step_voluntary_delegations"
    ADD CONSTRAINT "chain_step_voluntary_delegations_chain_step_id_fkey" FOREIGN KEY ("chain_step_id") REFERENCES "public"."lease_approval_chain"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chain_step_voluntary_delegations"
    ADD CONSTRAINT "chain_step_voluntary_delegations_delegated_by_fkey" FOREIGN KEY ("delegated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."chain_step_voluntary_delegations"
    ADD CONSTRAINT "chain_step_voluntary_delegations_delegated_to_fkey" FOREIGN KEY ("delegated_to") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."chain_step_voluntary_delegations"
    ADD CONSTRAINT "chain_step_voluntary_delegations_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chain_step_voluntary_delegations"
    ADD CONSTRAINT "chain_step_voluntary_delegations_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."chain_step_voluntary_delegations"
    ADD CONSTRAINT "chain_step_voluntary_delegations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."classification_corrections"
    ADD CONSTRAINT "classification_corrections_corrected_by_fkey" FOREIGN KEY ("corrected_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."classification_corrections"
    ADD CONSTRAINT "classification_corrections_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."classification_corrections"
    ADD CONSTRAINT "classification_corrections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deleted_workspaces"
    ADD CONSTRAINT "deleted_workspaces_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."dismissed_events"
    ADD CONSTRAINT "dismissed_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dismissed_events"
    ADD CONSTRAINT "dismissed_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."executed_term_edits"
    ADD CONSTRAINT "executed_term_edits_edited_by_fkey" FOREIGN KEY ("edited_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."executed_term_edits"
    ADD CONSTRAINT "executed_term_edits_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."field_corrections"
    ADD CONSTRAINT "field_corrections_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invite_tokens"
    ADD CONSTRAINT "invite_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_activity_log"
    ADD CONSTRAINT "lease_activity_log_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_activity_log"
    ADD CONSTRAINT "lease_activity_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lease_approval_actions"
    ADD CONSTRAINT "lease_approval_actions_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_approval_actions"
    ADD CONSTRAINT "lease_approval_actions_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_action_by_fkey" FOREIGN KEY ("action_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_approver_user_id_fkey" FOREIGN KEY ("approver_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_delegate_user_id_fkey" FOREIGN KEY ("delegate_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_effective_assignee_user_id_fkey" FOREIGN KEY ("effective_assignee_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id");



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_rerouted_from_chain_id_fkey" FOREIGN KEY ("rerouted_from_chain_id") REFERENCES "public"."lease_approval_chain"("id");



ALTER TABLE ONLY "public"."lease_approval_chain"
    ADD CONSTRAINT "lease_approval_chain_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_approvers"
    ADD CONSTRAINT "lease_approvers_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_approvers"
    ADD CONSTRAINT "lease_approvers_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_asc842_inputs"
    ADD CONSTRAINT "lease_asc842_inputs_last_updated_by_fkey" FOREIGN KEY ("last_updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_asc842_inputs"
    ADD CONSTRAINT "lease_asc842_inputs_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_asc842_inputs"
    ADD CONSTRAINT "lease_asc842_inputs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_attribute_snapshots"
    ADD CONSTRAINT "lease_attribute_snapshots_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_attribute_snapshots"
    ADD CONSTRAINT "lease_attribute_snapshots_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id");



ALTER TABLE ONLY "public"."lease_attribute_snapshots"
    ADD CONSTRAINT "lease_attribute_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_change_set_items"
    ADD CONSTRAINT "lease_change_set_items_change_set_id_fkey" FOREIGN KEY ("change_set_id") REFERENCES "public"."lease_change_sets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_change_sets"
    ADD CONSTRAINT "lease_change_sets_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_change_sets"
    ADD CONSTRAINT "lease_change_sets_requested_approver_id_fkey" FOREIGN KEY ("requested_approver_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lease_change_sets"
    ADD CONSTRAINT "lease_change_sets_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_change_sets"
    ADD CONSTRAINT "lease_change_sets_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_change_sets"
    ADD CONSTRAINT "lease_change_sets_unlock_request_id_fkey" FOREIGN KEY ("unlock_request_id") REFERENCES "public"."lease_unlock_requests"("id");



ALTER TABLE ONLY "public"."lease_change_sets"
    ADD CONSTRAINT "lease_change_sets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_documents"
    ADD CONSTRAINT "lease_documents_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_documents"
    ADD CONSTRAINT "lease_documents_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."lease_documents"("id");



ALTER TABLE ONLY "public"."lease_documents"
    ADD CONSTRAINT "lease_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_documents"
    ADD CONSTRAINT "lease_documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_field_confidence"
    ADD CONSTRAINT "lease_field_confidence_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_governance_audit"
    ADD CONSTRAINT "lease_governance_audit_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_governance_audit"
    ADD CONSTRAINT "lease_governance_audit_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_governance_audit"
    ADD CONSTRAINT "lease_governance_audit_related_change_set_id_fkey" FOREIGN KEY ("related_change_set_id") REFERENCES "public"."lease_change_sets"("id");



ALTER TABLE ONLY "public"."lease_governance_audit"
    ADD CONSTRAINT "lease_governance_audit_related_unlock_request_id_fkey" FOREIGN KEY ("related_unlock_request_id") REFERENCES "public"."lease_unlock_requests"("id");



ALTER TABLE ONLY "public"."lease_governance_audit"
    ADD CONSTRAINT "lease_governance_audit_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_insights"
    ADD CONSTRAINT "lease_insights_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_insights"
    ADD CONSTRAINT "lease_insights_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_notifications"
    ADD CONSTRAINT "lease_notifications_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_nudges"
    ADD CONSTRAINT "lease_nudges_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_nudges"
    ADD CONSTRAINT "lease_nudges_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_reports"
    ADD CONSTRAINT "lease_reports_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_reports"
    ADD CONSTRAINT "lease_reports_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_reports"
    ADD CONSTRAINT "lease_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_reroute_events"
    ADD CONSTRAINT "lease_reroute_events_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_reroute_events"
    ADD CONSTRAINT "lease_reroute_events_new_policy_id_fkey" FOREIGN KEY ("new_policy_id") REFERENCES "public"."approval_policies"("id");



ALTER TABLE ONLY "public"."lease_reroute_events"
    ADD CONSTRAINT "lease_reroute_events_prior_policy_id_fkey" FOREIGN KEY ("prior_policy_id") REFERENCES "public"."approval_policies"("id");



ALTER TABLE ONLY "public"."lease_reroute_events"
    ADD CONSTRAINT "lease_reroute_events_triggered_by_fkey" FOREIGN KEY ("triggered_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_reroute_events"
    ADD CONSTRAINT "lease_reroute_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_state_transitions"
    ADD CONSTRAINT "lease_state_transitions_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_unlock_requests"
    ADD CONSTRAINT "lease_unlock_requests_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lease_unlock_requests"
    ADD CONSTRAINT "lease_unlock_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_unlock_requests"
    ADD CONSTRAINT "lease_unlock_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lease_unlock_requests"
    ADD CONSTRAINT "lease_unlock_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_discount_rate_set_by_fkey" FOREIGN KEY ("discount_rate_set_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_executed_uploaded_by_fkey" FOREIGN KEY ("executed_uploaded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_execution_owner_id_fkey" FOREIGN KEY ("execution_owner_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_financial_approved_by_fkey" FOREIGN KEY ("financial_approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_lease_classification_set_by_fkey" FOREIGN KEY ("lease_classification_set_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_lease_owner_id_fkey" FOREIGN KEY ("lease_owner_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_manager_approved_by_fkey" FOREIGN KEY ("manager_approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_model_locked_by_fkey" FOREIGN KEY ("model_locked_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_parent_lease_id_fkey" FOREIGN KEY ("parent_lease_id") REFERENCES "public"."leases"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_unlock_requested_by_fkey" FOREIGN KEY ("unlock_requested_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_variance_reviewed_by_fkey" FOREIGN KEY ("variance_reviewed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."leases"
    ADD CONSTRAINT "leases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ops_admins"
    ADD CONSTRAINT "ops_admins_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ops_admins"
    ADD CONSTRAINT "ops_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."processing_rate_limits"
    ADD CONSTRAINT "processing_rate_limits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rent_schedules"
    ADD CONSTRAINT "rent_schedules_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."risk_templates"
    ADD CONSTRAINT "risk_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."risk_templates"
    ADD CONSTRAINT "risk_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."risks"
    ADD CONSTRAINT "risks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."risks"
    ADD CONSTRAINT "risks_dismissed_by_fkey" FOREIGN KEY ("dismissed_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."risks"
    ADD CONSTRAINT "risks_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."risks"
    ADD CONSTRAINT "risks_risk_template_id_fkey" FOREIGN KEY ("risk_template_id") REFERENCES "public"."risk_templates"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."summary_views"
    ADD CONSTRAINT "summary_views_lease_id_fkey" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_out_of_office"
    ADD CONSTRAINT "user_out_of_office_delegate_user_id_fkey" FOREIGN KEY ("delegate_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."user_out_of_office"
    ADD CONSTRAINT "user_out_of_office_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_out_of_office"
    ADD CONSTRAINT "user_out_of_office_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vendor_alert_log"
    ADD CONSTRAINT "vendor_alert_log_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."workspace_approvers"
    ADD CONSTRAINT "workspace_approvers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."workspace_approvers"
    ADD CONSTRAINT "workspace_approvers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_approvers"
    ADD CONSTRAINT "workspace_approvers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_quota_snapshots"
    ADD CONSTRAINT "workspace_quota_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_roles"
    ADD CONSTRAINT "workspace_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_roles"
    ADD CONSTRAINT "workspace_roles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Approvers can create approval actions" ON "public"."lease_approval_actions" FOR INSERT WITH CHECK ((("approver_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."lease_approvers" "la"
  WHERE (("la"."lease_id" = "lease_approval_actions"."lease_id") AND ("la"."approver_id" = "auth"."uid"()))))));



CREATE POLICY "Lease owners and admins can assign approvers" ON "public"."lease_approvers" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_approvers"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."has_workspace_permission"("l"."workspace_id", "auth"."uid"(), 'admin'::"public"."workspace_role"))))));



CREATE POLICY "Lease owners and admins can remove approvers" ON "public"."lease_approvers" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_approvers"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."has_workspace_permission"("l"."workspace_id", "auth"."uid"(), 'admin'::"public"."workspace_role"))))));



CREATE POLICY "Lease owners and admins can send nudges" ON "public"."lease_nudges" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_nudges"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR ("l"."lease_owner_id" = "auth"."uid"()) OR "public"."has_workspace_permission"("l"."workspace_id", "auth"."uid"(), 'admin'::"public"."workspace_role"))))));



CREATE POLICY "Members can view workspace membership" ON "public"."workspace_members" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("workspace_id", "auth"."uid"())));



CREATE POLICY "Owners can add members" ON "public"."workspace_members" FOR INSERT WITH CHECK ("public"."is_workspace_owner"("workspace_id", "auth"."uid"()));



CREATE POLICY "Owners can create workspace invites" ON "public"."invite_tokens" FOR INSERT WITH CHECK ("public"."is_workspace_owner"("workspace_id", "auth"."uid"()));



CREATE POLICY "Owners can delete their workspaces" ON "public"."workspaces" FOR DELETE USING (("owner_id" = "auth"."uid"()));



CREATE POLICY "Owners can delete workspace invites" ON "public"."invite_tokens" FOR DELETE USING ("public"."is_workspace_owner"("workspace_id", "auth"."uid"()));



CREATE POLICY "Owners can remove members" ON "public"."workspace_members" FOR DELETE USING ("public"."is_workspace_owner"("workspace_id", "auth"."uid"()));



CREATE POLICY "Owners can update members" ON "public"."workspace_members" FOR UPDATE USING ("public"."is_workspace_owner"("workspace_id", "auth"."uid"()));



CREATE POLICY "Owners can update their workspaces" ON "public"."workspaces" FOR UPDATE USING (("owner_id" = "auth"."uid"()));



CREATE POLICY "Owners can view workspace invites" ON "public"."invite_tokens" FOR SELECT USING ("public"."is_workspace_owner"("workspace_id", "auth"."uid"()));



CREATE POLICY "Owners view own workspace deletions" ON "public"."deleted_workspaces" FOR SELECT USING ((("owner_id" = "auth"."uid"()) OR ("deleted_by" = "auth"."uid"())));



CREATE POLICY "Service role only" ON "public"."processing_rate_limits" USING (false) WITH CHECK (false);



CREATE POLICY "Users can create activity entries" ON "public"."lease_activity_log" FOR INSERT WITH CHECK (((("user_id" = "auth"."uid"()) OR ("user_id" IS NULL)) AND (EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_activity_log"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"())))))));



CREATE POLICY "Users can create notifications for their leases" ON "public"."lease_notifications" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases"
  WHERE (("leases"."id" = "lease_notifications"."lease_id") AND ("leases"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can create workspaces" ON "public"."workspaces" FOR INSERT WITH CHECK (("owner_id" = "auth"."uid"()));



CREATE POLICY "Users can delete notifications for their leases" ON "public"."lease_notifications" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."leases"
  WHERE (("leases"."id" = "lease_notifications"."lease_id") AND ("leases"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert corrections for their leases" ON "public"."field_corrections" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "field_corrections"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Users can insert field confidence for their leases" ON "public"."lease_field_confidence" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_field_confidence"."lease_id") AND ("l"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert leases" ON "public"."leases" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") AND (("workspace_id" IS NULL) OR "public"."is_workspace_member"("workspace_id", "auth"."uid"()))));



CREATE POLICY "Users can insert transitions for their leases" ON "public"."lease_state_transitions" FOR INSERT WITH CHECK (((("transitioned_by" = "auth"."uid"()) OR ("transitioned_by" IS NULL)) AND (EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_state_transitions"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"())))))));



CREATE POLICY "Users can manage their own dismissed events" ON "public"."dismissed_events" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can manage their own preferences" ON "public"."user_preferences" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update notifications for their leases" ON "public"."lease_notifications" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."leases"
  WHERE (("leases"."id" = "lease_notifications"."lease_id") AND ("leases"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view activity for their leases" ON "public"."lease_activity_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_activity_log"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Users can view approval actions for their leases" ON "public"."lease_approval_actions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_approval_actions"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Users can view corrections for their workspace leases" ON "public"."field_corrections" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "field_corrections"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Users can view field confidence for their leases" ON "public"."lease_field_confidence" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_field_confidence"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Users can view invites sent to them" ON "public"."invite_tokens" FOR SELECT USING (("email" = (( SELECT "users"."email"
   FROM "auth"."users"
  WHERE ("users"."id" = "auth"."uid"())))::"text"));



CREATE POLICY "Users can view lease approvers for their leases" ON "public"."lease_approvers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_approvers"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Users can view notifications for their leases" ON "public"."lease_notifications" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases"
  WHERE (("leases"."id" = "lease_notifications"."lease_id") AND ("leases"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view nudges for their leases" ON "public"."lease_nudges" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_nudges"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Users can view workspaces they own or are members of" ON "public"."workspaces" FOR SELECT USING ((("owner_id" = "auth"."uid"()) OR "public"."is_workspace_member"("id", "auth"."uid"())));



CREATE POLICY "Users view transitions in workspace" ON "public"."lease_state_transitions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_state_transitions"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "Workspace members can view approvers" ON "public"."workspace_approvers" FOR SELECT USING ("public"."is_workspace_member"("workspace_id", "auth"."uid"()));



CREATE POLICY "Workspace owners can manage approvers" ON "public"."workspace_approvers" USING ("public"."is_workspace_owner"("workspace_id", "auth"."uid"()));



CREATE POLICY "admins and requesters can update unlock requests" ON "public"."lease_unlock_requests" FOR UPDATE USING ((("requested_by" = "auth"."uid"()) OR ("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))) OR ("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())))));



CREATE POLICY "admins delete documents" ON "public"."lease_documents" FOR DELETE USING (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



CREATE POLICY "admins delete reports" ON "public"."lease_reports" FOR DELETE TO "authenticated" USING (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



CREATE POLICY "admins manage documents" ON "public"."lease_documents" FOR UPDATE USING (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



CREATE POLICY "admins update chain in workspace" ON "public"."lease_approval_chain" FOR UPDATE USING (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role"))))) WITH CHECK (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



CREATE POLICY "admins write steps via policy" ON "public"."approval_chain_steps" USING (("policy_id" IN ( SELECT "approval_policies"."id"
   FROM "public"."approval_policies"
  WHERE ("approval_policies"."workspace_id" IN ( SELECT "workspaces"."id"
           FROM "public"."workspaces"
          WHERE ("workspaces"."owner_id" = "auth"."uid"())
        UNION
         SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role"))))))) WITH CHECK (("policy_id" IN ( SELECT "approval_policies"."id"
   FROM "public"."approval_policies"
  WHERE ("approval_policies"."workspace_id" IN ( SELECT "workspaces"."id"
           FROM "public"."workspaces"
          WHERE ("workspaces"."owner_id" = "auth"."uid"())
        UNION
         SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))))));



ALTER TABLE "public"."alert_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "alert_rules_manage" ON "public"."alert_rules" USING ((("workspace_id" IN ( SELECT "wm"."workspace_id"
   FROM "public"."workspace_members" "wm"
  WHERE (("wm"."user_id" = "auth"."uid"()) AND ("wm"."role" = 'admin'::"public"."workspace_role")))) OR ("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))))) WITH CHECK ((("workspace_id" IN ( SELECT "wm"."workspace_id"
   FROM "public"."workspace_members" "wm"
  WHERE (("wm"."user_id" = "auth"."uid"()) AND ("wm"."role" = 'admin'::"public"."workspace_role")))) OR ("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())))));



CREATE POLICY "alert_rules_select" ON "public"."alert_rules" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."approval_chain_steps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."approval_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "assignee acts on own pending step" ON "public"."lease_approval_chain" FOR UPDATE USING ((("status" = 'pending'::"text") AND (("approver_user_id" = "auth"."uid"()) OR (("approver_role" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."workspace_roles" "wr"
  WHERE (("wr"."workspace_id" = "lease_approval_chain"."workspace_id") AND ("wr"."user_id" = "auth"."uid"()) AND ("wr"."role" = "lease_approval_chain"."approver_role")))))))) WITH CHECK ((("action_by" = "auth"."uid"()) AND ("status" = ANY (ARRAY['approved'::"text", 'rejected'::"text", 'sent_back'::"text"]))));



ALTER TABLE "public"."chain_step_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chain_step_overrides_select" ON "public"."chain_step_overrides" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



ALTER TABLE "public"."chain_step_voluntary_delegations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."classification_corrections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deleted_workspaces" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dismissed_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "editors and admins update asc842 inputs" ON "public"."lease_asc842_inputs" FOR UPDATE USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = ANY (ARRAY['admin'::"public"."workspace_role", 'editor'::"public"."workspace_role"])))
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())))) WITH CHECK (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = ANY (ARRAY['admin'::"public"."workspace_role", 'editor'::"public"."workspace_role"])))
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "editors and admins write asc842 inputs" ON "public"."lease_asc842_inputs" FOR INSERT WITH CHECK (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = ANY (ARRAY['admin'::"public"."workspace_role", 'editor'::"public"."workspace_role"])))
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



ALTER TABLE "public"."executed_term_edits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."field_corrections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "financial_approver_insert_term_edits" ON "public"."executed_term_edits" FOR INSERT WITH CHECK ((("edited_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM ("public"."leases" "l"
     JOIN "public"."workspace_roles" "wr" ON ((("wr"."workspace_id" = "l"."workspace_id") AND ("wr"."user_id" = "auth"."uid"()))))
  WHERE (("l"."id" = "executed_term_edits"."lease_id") AND ("wr"."role" = ANY (ARRAY['financial_approver'::"text", 'admin'::"text"])))))));



ALTER TABLE "public"."invite_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_activity_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_approval_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_approval_chain" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_approvers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lease_approvers_update" ON "public"."lease_approvers" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_approvers"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."has_workspace_permission"("l"."workspace_id", "auth"."uid"(), 'admin'::"public"."workspace_role")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_approvers"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."has_workspace_permission"("l"."workspace_id", "auth"."uid"(), 'admin'::"public"."workspace_role"))))));



ALTER TABLE "public"."lease_asc842_inputs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_attribute_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lease_attribute_snapshots_select" ON "public"."lease_attribute_snapshots" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



ALTER TABLE "public"."lease_change_set_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_change_sets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lease_change_sets_delete" ON "public"."lease_change_sets" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_change_sets"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



ALTER TABLE "public"."lease_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_field_confidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_governance_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_insights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_nudges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_reroute_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lease_reroute_events_select" ON "public"."lease_reroute_events" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



ALTER TABLE "public"."lease_state_transitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lease_unlock_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lease_unlock_requests_delete" ON "public"."lease_unlock_requests" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "lease_unlock_requests"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



ALTER TABLE "public"."leases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "leases_delete_own_or_workspace_admin" ON "public"."leases" FOR DELETE USING ((("user_id" = "auth"."uid"()) OR "public"."has_workspace_permission"("workspace_id", "auth"."uid"(), 'admin'::"public"."workspace_role")));



CREATE POLICY "leases_select_own_or_workspace" ON "public"."leases" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("workspace_id", "auth"."uid"())));



CREATE POLICY "leases_update_own_or_workspace_editor" ON "public"."leases" FOR UPDATE USING ((("user_id" = "auth"."uid"()) OR "public"."has_workspace_permission"("workspace_id", "auth"."uid"(), 'editor'::"public"."workspace_role") OR (EXISTS ( SELECT 1
   FROM "public"."workspace_roles" "wr"
  WHERE (("wr"."workspace_id" = "leases"."workspace_id") AND ("wr"."user_id" = "auth"."uid"()) AND ("wr"."role" = ANY (ARRAY['manager_approver'::"text", 'financial_approver'::"text", 'admin'::"text"])))))));



CREATE POLICY "members initiate reports" ON "public"."lease_reports" FOR INSERT TO "authenticated" WITH CHECK ((("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = ANY (ARRAY['admin'::"public"."workspace_role", 'editor'::"public"."workspace_role"])))
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))) AND ("generated_by" = "auth"."uid"())));



CREATE POLICY "members read steps via policy" ON "public"."approval_chain_steps" FOR SELECT USING (("policy_id" IN ( SELECT "approval_policies"."id"
   FROM "public"."approval_policies"
  WHERE ("approval_policies"."workspace_id" IN ( SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE ("workspace_members"."user_id" = "auth"."uid"())
        UNION
         SELECT "workspaces"."id"
           FROM "public"."workspaces"
          WHERE ("workspaces"."owner_id" = "auth"."uid"()))))));



CREATE POLICY "no client deletes" ON "public"."classification_corrections" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "no client deletes" ON "public"."lease_insights" FOR DELETE TO "authenticated" USING (false);



CREATE POLICY "no client updates" ON "public"."classification_corrections" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "no client updates" ON "public"."lease_insights" FOR UPDATE TO "authenticated" USING (false);



CREATE POLICY "no direct client inserts" ON "public"."lease_insights" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "no direct inserts from clients" ON "public"."classification_corrections" FOR INSERT TO "authenticated" WITH CHECK (false);



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_delete" ON "public"."notifications" FOR DELETE USING ((("user_id" = "auth"."uid"()) OR ("user_id" IS NULL)));



CREATE POLICY "notifications_select" ON "public"."notifications" FOR SELECT USING ((("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))) AND (("user_id" = "auth"."uid"()) OR ("user_id" IS NULL))));



CREATE POLICY "notifications_service_insert" ON "public"."notifications" FOR INSERT WITH CHECK (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "notifications_update_read" ON "public"."notifications" FOR UPDATE USING ((("user_id" = "auth"."uid"()) OR ("user_id" IS NULL))) WITH CHECK ((("user_id" = "auth"."uid"()) OR ("user_id" IS NULL)));



CREATE POLICY "ops admins acknowledge alerts" ON "public"."vendor_alert_log" FOR UPDATE TO "authenticated" USING ("public"."is_ops_admin"("auth"."uid"())) WITH CHECK ("public"."is_ops_admin"("auth"."uid"()));



CREATE POLICY "ops admins can see themselves" ON "public"."ops_admins" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));



CREATE POLICY "ops admins read alerts" ON "public"."vendor_alert_log" FOR SELECT TO "authenticated" USING ("public"."is_ops_admin"("auth"."uid"()));



CREATE POLICY "ops admins read recipients" ON "public"."vendor_alert_recipients" FOR SELECT TO "authenticated" USING ("public"."is_ops_admin"("auth"."uid"()));



CREATE POLICY "ops admins read renewals" ON "public"."vendor_renewal_calendar" FOR SELECT TO "authenticated" USING ("public"."is_ops_admin"("auth"."uid"()));



CREATE POLICY "ops admins read snapshots" ON "public"."vendor_usage_snapshots" FOR SELECT TO "authenticated" USING ("public"."is_ops_admin"("auth"."uid"()));



ALTER TABLE "public"."ops_admins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."processing_rate_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_delete_self" ON "public"."profiles" FOR DELETE USING (("id" = "auth"."uid"()));



CREATE POLICY "profiles_insert_own" ON "public"."profiles" FOR INSERT WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "profiles_insert_self" ON "public"."profiles" FOR INSERT WITH CHECK (true);



CREATE POLICY "profiles_select_own_or_coworker" ON "public"."profiles" FOR SELECT USING ((("id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."workspace_members" "wm"
  WHERE (("wm"."user_id" = "profiles"."id") AND "public"."is_workspace_member"("wm"."workspace_id", "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."workspaces" "w"
  WHERE (("w"."owner_id" = "profiles"."id") AND "public"."is_workspace_member"("w"."id", "auth"."uid"()))))));



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE USING (("id" = "auth"."uid"()));



CREATE POLICY "profiles_update_self" ON "public"."profiles" FOR UPDATE USING (("id" = "auth"."uid"())) WITH CHECK ((("id" = "auth"."uid"()) AND (("current_workspace_id" IS NULL) OR "public"."is_workspace_member"("current_workspace_id", "auth"."uid"()))));



ALTER TABLE "public"."rent_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rent_schedules_delete" ON "public"."rent_schedules" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "rent_schedules"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "rent_schedules_insert" ON "public"."rent_schedules" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "rent_schedules"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "rent_schedules_select" ON "public"."rent_schedules" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "rent_schedules"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "rent_schedules_update" ON "public"."rent_schedules" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "rent_schedules"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



ALTER TABLE "public"."risk_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "risk_templates_delete" ON "public"."risk_templates" FOR DELETE USING ((("is_system" = false) AND ("workspace_id" IS NOT NULL) AND "public"."is_workspace_member"("workspace_id", "auth"."uid"())));



CREATE POLICY "risk_templates_insert" ON "public"."risk_templates" FOR INSERT WITH CHECK ((("is_system" = false) AND ("workspace_id" IS NOT NULL) AND "public"."is_workspace_member"("workspace_id", "auth"."uid"())));



CREATE POLICY "risk_templates_select" ON "public"."risk_templates" FOR SELECT USING ((("is_system" = true) OR (("workspace_id" IS NOT NULL) AND "public"."is_workspace_member"("workspace_id", "auth"."uid"()))));



CREATE POLICY "risk_templates_update" ON "public"."risk_templates" FOR UPDATE USING ((("is_system" = false) AND ("workspace_id" IS NOT NULL) AND "public"."is_workspace_member"("workspace_id", "auth"."uid"()))) WITH CHECK ((("is_system" = false) AND ("workspace_id" IS NOT NULL) AND "public"."is_workspace_member"("workspace_id", "auth"."uid"())));



ALTER TABLE "public"."risks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "risks_delete" ON "public"."risks" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "risks"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "risks_insert" ON "public"."risks" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "risks"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "risks_select" ON "public"."risks" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "risks"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "risks_update" ON "public"."risks" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "risks"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"())))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "risks"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



CREATE POLICY "submitters and admins write documents" ON "public"."lease_documents" FOR INSERT WITH CHECK ((("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = ANY (ARRAY['admin'::"public"."workspace_role", 'editor'::"public"."workspace_role"])))
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))) AND ("uploaded_by" = "auth"."uid"()) AND ("lease_id" IN ( SELECT "leases"."id"
   FROM "public"."leases"
  WHERE ("leases"."workspace_id" = "lease_documents"."workspace_id")))));



CREATE POLICY "submitters and approvers can update change sets" ON "public"."lease_change_sets" FOR UPDATE USING ((("submitted_by" = "auth"."uid"()) OR ("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))) OR ("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))) OR ("workspace_id" IN ( SELECT "workspace_roles"."workspace_id"
   FROM "public"."workspace_roles"
  WHERE (("workspace_roles"."user_id" = "auth"."uid"()) AND ("workspace_roles"."role" = 'financial_approver'::"text"))))));



ALTER TABLE "public"."summary_views" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "summary_views_insert" ON "public"."summary_views" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "summary_views"."lease_id") AND ("l"."summary_share_token" IS NOT NULL)))));



CREATE POLICY "summary_views_select_workspace" ON "public"."summary_views" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "summary_views"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



ALTER TABLE "public"."user_out_of_office" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_out_of_office_insert_self" ON "public"."user_out_of_office" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND ("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())))));



CREATE POLICY "user_out_of_office_select" ON "public"."user_out_of_office" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "user_out_of_office_update_self" ON "public"."user_out_of_office" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendor_alert_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendor_alert_recipients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendor_renewal_calendar" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendor_usage_snapshots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "voluntary_delegations_select" ON "public"."chain_step_voluntary_delegations" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "workspace admins write policies" ON "public"."approval_policies" USING (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role"))))) WITH CHECK (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



CREATE POLICY "workspace members can create change sets" ON "public"."lease_change_sets" FOR INSERT WITH CHECK (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "workspace members can create unlock requests" ON "public"."lease_unlock_requests" FOR INSERT WITH CHECK (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "workspace members can delete change set items" ON "public"."lease_change_set_items" FOR DELETE USING (("change_set_id" IN ( SELECT "lease_change_sets"."id"
   FROM "public"."lease_change_sets"
  WHERE ("lease_change_sets"."workspace_id" IN ( SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE ("workspace_members"."user_id" = "auth"."uid"()))))));



CREATE POLICY "workspace members can insert change set items" ON "public"."lease_change_set_items" FOR INSERT WITH CHECK (("change_set_id" IN ( SELECT "lease_change_sets"."id"
   FROM "public"."lease_change_sets"
  WHERE ("lease_change_sets"."workspace_id" IN ( SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE ("workspace_members"."user_id" = "auth"."uid"()))))));



CREATE POLICY "workspace members can insert governance audit" ON "public"."lease_governance_audit" FOR INSERT WITH CHECK (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "workspace members can update change set items" ON "public"."lease_change_set_items" FOR UPDATE USING (("change_set_id" IN ( SELECT "lease_change_sets"."id"
   FROM "public"."lease_change_sets"
  WHERE ("lease_change_sets"."workspace_id" IN ( SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE ("workspace_members"."user_id" = "auth"."uid"())))))) WITH CHECK (("change_set_id" IN ( SELECT "lease_change_sets"."id"
   FROM "public"."lease_change_sets"
  WHERE ("lease_change_sets"."workspace_id" IN ( SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE ("workspace_members"."user_id" = "auth"."uid"()))))));



CREATE POLICY "workspace members can view change set items" ON "public"."lease_change_set_items" FOR SELECT USING (("change_set_id" IN ( SELECT "lease_change_sets"."id"
   FROM "public"."lease_change_sets"
  WHERE ("lease_change_sets"."workspace_id" IN ( SELECT "workspace_members"."workspace_id"
           FROM "public"."workspace_members"
          WHERE ("workspace_members"."user_id" = "auth"."uid"()))))));



CREATE POLICY "workspace members can view change sets" ON "public"."lease_change_sets" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "workspace members can view governance audit" ON "public"."lease_governance_audit" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "workspace members can view unlock requests" ON "public"."lease_unlock_requests" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"()))));



CREATE POLICY "workspace members read asc842 inputs" ON "public"."lease_asc842_inputs" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "workspace members read chain" ON "public"."lease_approval_chain" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "workspace members read corrections" ON "public"."classification_corrections" FOR SELECT TO "authenticated" USING ("public"."is_workspace_member"("workspace_id", "auth"."uid"()));



CREATE POLICY "workspace members read documents" ON "public"."lease_documents" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "workspace members read insights" ON "public"."lease_insights" FOR SELECT TO "authenticated" USING ("public"."is_workspace_member"("workspace_id", "auth"."uid"()));



CREATE POLICY "workspace members read policies" ON "public"."approval_policies" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "workspace members read reports" ON "public"."lease_reports" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "workspace members read their quotas" ON "public"."workspace_quota_snapshots" FOR SELECT TO "authenticated" USING ("public"."is_workspace_member"("workspace_id", "auth"."uid"()));



ALTER TABLE "public"."workspace_approvers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workspace_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspace_members_select_term_edits" ON "public"."executed_term_edits" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."leases" "l"
  WHERE (("l"."id" = "executed_term_edits"."lease_id") AND (("l"."user_id" = "auth"."uid"()) OR "public"."is_workspace_member"("l"."workspace_id", "auth"."uid"()))))));



ALTER TABLE "public"."workspace_quota_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workspace_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspace_roles_delete" ON "public"."workspace_roles" FOR DELETE USING (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



CREATE POLICY "workspace_roles_insert" ON "public"."workspace_roles" FOR INSERT WITH CHECK (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



CREATE POLICY "workspace_roles_select" ON "public"."workspace_roles" FOR SELECT USING (("workspace_id" IN ( SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE ("workspace_members"."user_id" = "auth"."uid"())
UNION
 SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"()))));



CREATE POLICY "workspace_roles_update" ON "public"."workspace_roles" FOR UPDATE USING (("workspace_id" IN ( SELECT "workspaces"."id"
   FROM "public"."workspaces"
  WHERE ("workspaces"."owner_id" = "auth"."uid"())
UNION
 SELECT "workspace_members"."workspace_id"
   FROM "public"."workspace_members"
  WHERE (("workspace_members"."user_id" = "auth"."uid"()) AND ("workspace_members"."role" = 'admin'::"public"."workspace_role")))));



ALTER TABLE "public"."workspaces" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."am_i_ops_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."am_i_ops_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."am_i_ops_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_policy_steps"("p_policy_id" "uuid", "p_steps" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_policy_steps"("p_policy_id" "uuid", "p_steps" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_policy_steps"("p_policy_id" "uuid", "p_steps" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."approve_field"("p_lease_id" "uuid", "p_field_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_field"("p_lease_id" "uuid", "p_field_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_field"("p_lease_id" "uuid", "p_field_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."detect_lease_attribute_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."detect_lease_attribute_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."detect_lease_attribute_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."finalize_lease_approval"("p_lease_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."finalize_lease_approval"("p_lease_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."finalize_lease_approval"("p_lease_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_audit_user_id"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_audit_user_id"("p_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_audit_user_id"("p_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_audit_user_id"("p_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_workspace_role"("_workspace_id" "uuid", "_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_workspace_role"("_workspace_id" "uuid", "_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_workspace_role"("_workspace_id" "uuid", "_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_workspace_permission"("_workspace_id" "uuid", "_user_id" "uuid", "_min_role" "public"."workspace_role") TO "anon";
GRANT ALL ON FUNCTION "public"."has_workspace_permission"("_workspace_id" "uuid", "_user_id" "uuid", "_min_role" "public"."workspace_role") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_workspace_permission"("_workspace_id" "uuid", "_user_id" "uuid", "_min_role" "public"."workspace_role") TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_policy_version"() TO "anon";
GRANT ALL ON FUNCTION "public"."increment_policy_version"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_policy_version"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_ops_admin"("_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_ops_admin"("_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_ops_admin"("_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_workspace_member"("_workspace_id" "uuid", "_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_workspace_member"("_workspace_id" "uuid", "_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_workspace_member"("_workspace_id" "uuid", "_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_workspace_owner"("_workspace_id" "uuid", "_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_workspace_owner"("_workspace_id" "uuid", "_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_workspace_owner"("_workspace_id" "uuid", "_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lease_asc842_inputs_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."lease_asc842_inputs_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."lease_asc842_inputs_set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_lease_state_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_lease_state_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_lease_state_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."maintain_lease_document_latest_flag"() TO "anon";
GRANT ALL ON FUNCTION "public"."maintain_lease_document_latest_flag"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."maintain_lease_document_latest_flag"() TO "service_role";



GRANT ALL ON FUNCTION "public"."mark_field_as_corrected"() TO "anon";
GRANT ALL ON FUNCTION "public"."mark_field_as_corrected"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_field_as_corrected"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."pg_database_size_postgres"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pg_database_size_postgres"() TO "anon";
GRANT ALL ON FUNCTION "public"."pg_database_size_postgres"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."pg_database_size_postgres"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_locked_lease_edits"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_locked_lease_edits"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_locked_lease_edits"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_unauthorized_lease_workflow_edits"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_unauthorized_lease_workflow_edits"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_unauthorized_lease_workflow_edits"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."preview_policy_resolution"("p_workspace_id" "uuid", "p_asset_type" "text", "p_department" "text", "p_annual_cost" numeric, "p_region" "text", "p_lease_type" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."preview_policy_resolution"("p_workspace_id" "uuid", "p_asset_type" "text", "p_department" "text", "p_annual_cost" numeric, "p_region" "text", "p_lease_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."preview_policy_resolution"("p_workspace_id" "uuid", "p_asset_type" "text", "p_department" "text", "p_annual_cost" numeric, "p_region" "text", "p_lease_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."record_field_correction"("p_lease_id" "uuid", "p_field_name" "text", "p_original_value" "text", "p_corrected_value" "text", "p_correction_type" "text", "p_user_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."record_field_correction"("p_lease_id" "uuid", "p_field_name" "text", "p_original_value" "text", "p_corrected_value" "text", "p_correction_type" "text", "p_user_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_field_correction"("p_lease_id" "uuid", "p_field_name" "text", "p_original_value" "text", "p_corrected_value" "text", "p_correction_type" "text", "p_user_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."storage_total_bytes"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."storage_total_bytes"() TO "anon";
GRANT ALL ON FUNCTION "public"."storage_total_bytes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."storage_total_bytes"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_lease_avg_confidence"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_lease_avg_confidence"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_lease_avg_confidence"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON TABLE "public"."alert_rules" TO "anon";
GRANT ALL ON TABLE "public"."alert_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."alert_rules" TO "service_role";



GRANT ALL ON TABLE "public"."approval_chain_steps" TO "anon";
GRANT ALL ON TABLE "public"."approval_chain_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."approval_chain_steps" TO "service_role";



GRANT ALL ON TABLE "public"."approval_policies" TO "anon";
GRANT ALL ON TABLE "public"."approval_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."approval_policies" TO "service_role";



GRANT ALL ON TABLE "public"."chain_step_overrides" TO "anon";
GRANT ALL ON TABLE "public"."chain_step_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."chain_step_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."chain_step_voluntary_delegations" TO "anon";
GRANT ALL ON TABLE "public"."chain_step_voluntary_delegations" TO "authenticated";
GRANT ALL ON TABLE "public"."chain_step_voluntary_delegations" TO "service_role";



GRANT ALL ON TABLE "public"."classification_corrections" TO "anon";
GRANT ALL ON TABLE "public"."classification_corrections" TO "authenticated";
GRANT ALL ON TABLE "public"."classification_corrections" TO "service_role";



GRANT ALL ON TABLE "public"."deleted_workspaces" TO "anon";
GRANT ALL ON TABLE "public"."deleted_workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."deleted_workspaces" TO "service_role";



GRANT ALL ON TABLE "public"."dismissed_events" TO "anon";
GRANT ALL ON TABLE "public"."dismissed_events" TO "authenticated";
GRANT ALL ON TABLE "public"."dismissed_events" TO "service_role";



GRANT ALL ON TABLE "public"."executed_term_edits" TO "anon";
GRANT ALL ON TABLE "public"."executed_term_edits" TO "authenticated";
GRANT ALL ON TABLE "public"."executed_term_edits" TO "service_role";



GRANT ALL ON TABLE "public"."field_corrections" TO "anon";
GRANT ALL ON TABLE "public"."field_corrections" TO "authenticated";
GRANT ALL ON TABLE "public"."field_corrections" TO "service_role";



GRANT ALL ON TABLE "public"."invite_tokens" TO "anon";
GRANT ALL ON TABLE "public"."invite_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."invite_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."lease_activity_log" TO "anon";
GRANT ALL ON TABLE "public"."lease_activity_log" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_activity_log" TO "service_role";



GRANT ALL ON TABLE "public"."lease_approval_actions" TO "anon";
GRANT ALL ON TABLE "public"."lease_approval_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_approval_actions" TO "service_role";



GRANT ALL ON TABLE "public"."lease_approval_chain" TO "anon";
GRANT ALL ON TABLE "public"."lease_approval_chain" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_approval_chain" TO "service_role";



GRANT ALL ON TABLE "public"."lease_approvers" TO "anon";
GRANT ALL ON TABLE "public"."lease_approvers" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_approvers" TO "service_role";



GRANT ALL ON TABLE "public"."lease_asc842_inputs" TO "anon";
GRANT ALL ON TABLE "public"."lease_asc842_inputs" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_asc842_inputs" TO "service_role";



GRANT ALL ON TABLE "public"."lease_attribute_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."lease_attribute_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_attribute_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."lease_change_set_items" TO "anon";
GRANT ALL ON TABLE "public"."lease_change_set_items" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_change_set_items" TO "service_role";



GRANT ALL ON TABLE "public"."lease_change_sets" TO "anon";
GRANT ALL ON TABLE "public"."lease_change_sets" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_change_sets" TO "service_role";



GRANT ALL ON TABLE "public"."lease_documents" TO "anon";
GRANT ALL ON TABLE "public"."lease_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_documents" TO "service_role";



GRANT ALL ON TABLE "public"."lease_field_confidence" TO "anon";
GRANT ALL ON TABLE "public"."lease_field_confidence" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_field_confidence" TO "service_role";



GRANT ALL ON TABLE "public"."lease_governance_audit" TO "anon";
GRANT ALL ON TABLE "public"."lease_governance_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_governance_audit" TO "service_role";



GRANT ALL ON TABLE "public"."lease_insights" TO "anon";
GRANT ALL ON TABLE "public"."lease_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_insights" TO "service_role";



GRANT ALL ON TABLE "public"."lease_notifications" TO "anon";
GRANT ALL ON TABLE "public"."lease_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."lease_nudges" TO "anon";
GRANT ALL ON TABLE "public"."lease_nudges" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_nudges" TO "service_role";



GRANT ALL ON TABLE "public"."lease_reports" TO "anon";
GRANT ALL ON TABLE "public"."lease_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_reports" TO "service_role";



GRANT ALL ON TABLE "public"."lease_reroute_events" TO "anon";
GRANT ALL ON TABLE "public"."lease_reroute_events" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_reroute_events" TO "service_role";



GRANT ALL ON TABLE "public"."lease_state_transitions" TO "anon";
GRANT ALL ON TABLE "public"."lease_state_transitions" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_state_transitions" TO "service_role";



GRANT ALL ON TABLE "public"."lease_unlock_requests" TO "anon";
GRANT ALL ON TABLE "public"."lease_unlock_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."lease_unlock_requests" TO "service_role";



GRANT ALL ON TABLE "public"."leases" TO "anon";
GRANT ALL ON TABLE "public"."leases" TO "authenticated";
GRANT ALL ON TABLE "public"."leases" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."ops_admins" TO "anon";
GRANT ALL ON TABLE "public"."ops_admins" TO "authenticated";
GRANT ALL ON TABLE "public"."ops_admins" TO "service_role";



GRANT ALL ON TABLE "public"."processing_rate_limits" TO "anon";
GRANT ALL ON TABLE "public"."processing_rate_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."processing_rate_limits" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."rent_schedules" TO "anon";
GRANT ALL ON TABLE "public"."rent_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."rent_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."risk_templates" TO "anon";
GRANT ALL ON TABLE "public"."risk_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."risk_templates" TO "service_role";



GRANT ALL ON TABLE "public"."risks" TO "anon";
GRANT ALL ON TABLE "public"."risks" TO "authenticated";
GRANT ALL ON TABLE "public"."risks" TO "service_role";



GRANT ALL ON TABLE "public"."summary_views" TO "anon";
GRANT ALL ON TABLE "public"."summary_views" TO "authenticated";
GRANT ALL ON TABLE "public"."summary_views" TO "service_role";



GRANT ALL ON TABLE "public"."user_out_of_office" TO "anon";
GRANT ALL ON TABLE "public"."user_out_of_office" TO "authenticated";
GRANT ALL ON TABLE "public"."user_out_of_office" TO "service_role";



GRANT ALL ON TABLE "public"."user_preferences" TO "anon";
GRANT ALL ON TABLE "public"."user_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."user_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."v_correction_analytics" TO "anon";
GRANT ALL ON TABLE "public"."v_correction_analytics" TO "authenticated";
GRANT ALL ON TABLE "public"."v_correction_analytics" TO "service_role";



GRANT ALL ON TABLE "public"."v_governance_audit_report" TO "service_role";
GRANT SELECT ON TABLE "public"."v_governance_audit_report" TO "authenticated";



GRANT ALL ON TABLE "public"."workspaces" TO "anon";
GRANT ALL ON TABLE "public"."workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."workspaces" TO "service_role";



GRANT ALL ON TABLE "public"."v_lease_verification_audit" TO "service_role";
GRANT SELECT ON TABLE "public"."v_lease_verification_audit" TO "authenticated";



GRANT ALL ON TABLE "public"."v_review_queue" TO "anon";
GRANT ALL ON TABLE "public"."v_review_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."v_review_queue" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_alert_log" TO "anon";
GRANT ALL ON TABLE "public"."vendor_alert_log" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_alert_log" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_alert_recipients" TO "anon";
GRANT ALL ON TABLE "public"."vendor_alert_recipients" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_alert_recipients" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_renewal_calendar" TO "anon";
GRANT ALL ON TABLE "public"."vendor_renewal_calendar" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_renewal_calendar" TO "service_role";



GRANT ALL ON TABLE "public"."vendor_usage_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."vendor_usage_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."vendor_usage_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_approvers" TO "anon";
GRANT ALL ON TABLE "public"."workspace_approvers" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_approvers" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_members" TO "anon";
GRANT ALL ON TABLE "public"."workspace_members" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_members" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_quota_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."workspace_quota_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_quota_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."workspace_roles" TO "anon";
GRANT ALL ON TABLE "public"."workspace_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_roles" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







