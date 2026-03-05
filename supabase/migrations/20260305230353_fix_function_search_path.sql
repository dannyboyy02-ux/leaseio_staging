-- Fix mutable search_path warning on prevent_locked_lease_edits trigger function
CREATE OR REPLACE FUNCTION public.prevent_locked_lease_edits()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_catalog
AS $function$
BEGIN
  IF OLD.model_locked = true THEN
    IF (
      NEW.executed_monthly_payment      IS DISTINCT FROM OLD.executed_monthly_payment      OR
      NEW.executed_commencement_date    IS DISTINCT FROM OLD.executed_commencement_date    OR
      NEW.executed_expiry_date          IS DISTINCT FROM OLD.executed_expiry_date          OR
      NEW.executed_tenant_name          IS DISTINCT FROM OLD.executed_tenant_name          OR
      NEW.executed_landlord_name        IS DISTINCT FROM OLD.executed_landlord_name        OR
      NEW.executed_rent_review_clause   IS DISTINCT FROM OLD.executed_rent_review_clause   OR
      NEW.executed_break_clause         IS DISTINCT FROM OLD.executed_break_clause         OR
      NEW.executed_extracted_json       IS DISTINCT FROM OLD.executed_extracted_json       OR
      NEW.variance_monthly_payment      IS DISTINCT FROM OLD.variance_monthly_payment      OR
      NEW.variance_commencement_days    IS DISTINCT FROM OLD.variance_commencement_days    OR
      NEW.variance_expiry_days          IS DISTINCT FROM OLD.variance_expiry_days          OR
      NEW.variance_tenant_name_match    IS DISTINCT FROM OLD.variance_tenant_name_match    OR
      NEW.variance_landlord_name_match  IS DISTINCT FROM OLD.variance_landlord_name_match
    ) THEN
      RAISE EXCEPTION 'Cannot modify executed or variance fields on a locked lease record (model_locked = true)';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
