// generate-lease-report — Phase 8 Checkpoint 3
//
// Produces a single-lease ASC 842 disclosure report. Loads the lease,
// rent schedules, field corrections, and verification audit; assembles
// ReportInputs; builds the JSON output; uploads JSON to the
// lease-reports bucket; inserts the lease_reports row; and returns the
// section data plus the generated report id.
//
// PDF rendering is performed CLIENT-SIDE. @react-pdf/renderer is a
// browser library; the existing codebase precedent (see
// supabase/functions/generate-lease-analysis/index.ts and
// src/components/leases/LeaseAnalysisExport.tsx) is for the edge
// function to return structured data and the client to render the PDF
// via pdf().toBlob(). The client subsequently uploads the PDF to the
// same storage prefix and invokes finalize-report-pdf to record the
// pdf_storage_path on the lease_reports row.
//
// AUTHORIZATION
//   - Bearer JWT (verify_jwt = true)
//   - Caller must be a workspace member (admin/editor/owner) OR the
//     workspace owner. The lease_reports INSERT RLS already enforces
//     editor/admin via the policy, but the edge function uses the
//     service role to insert the row so we re-implement the check.
//
// VALIDATION
//   - leaseId required
//   - lease.model_locked must be true (Phase 8 reports only finalized
//     leases per docs/PHASE_8_BUILD_SPEC.md)
//
// ACTIVITY LOG
//   - report_generation_requested on insert (status=generating)
//   - report_generation_completed on success (status=ready)
//   - report_generation_failed on internal error (status=failed)

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import {
  buildLeaseDisclosureJson,
  buildLeaseDisclosureSections,
  type Asc842Inputs,
  type Citation,
  type EscalationClause,
  type LeaseClassification,
  type RenewalOption,
  type ReportInputs,
  type RentPeriod,
  type TerminationClause,
  type VerificationAuditEntry,
} from "../_shared/asc842_report.ts";

// Phase 8 follow-up: shape a Asc842Inputs from a raw lease_asc842_inputs row.
function shapeAsc842Inputs(row: Record<string, unknown> | null | undefined): Asc842Inputs | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  return {
    tenant_improvement_allowance: asNumber(r.tenant_improvement_allowance),
    tenant_improvement_allowance_basis: asString(r.tenant_improvement_allowance_basis),
    initial_direct_costs: asNumber(r.initial_direct_costs),
    initial_direct_costs_basis: asString(r.initial_direct_costs_basis),
    prepaid_rent: asNumber(r.prepaid_rent),
    prepaid_rent_basis: asString(r.prepaid_rent_basis),
    lease_incentives_received: asNumber(r.lease_incentives_received),
    lease_incentives_received_basis: asString(r.lease_incentives_received_basis),
    residual_value_guarantee: asNumber(r.residual_value_guarantee),
    residual_value_guarantee_basis: asString(r.residual_value_guarantee_basis),
    purchase_option_present: typeof r.purchase_option_present === "boolean" ? r.purchase_option_present : null,
    purchase_option_price: asNumber(r.purchase_option_price),
    purchase_option_reasonably_certain: typeof r.purchase_option_reasonably_certain === "boolean" ? r.purchase_option_reasonably_certain : null,
    purchase_option_basis: asString(r.purchase_option_basis),
    termination_penalty_amount: asNumber(r.termination_penalty_amount),
    termination_penalty_reasonably_certain: typeof r.termination_penalty_reasonably_certain === "boolean" ? r.termination_penalty_reasonably_certain : null,
    termination_penalty_basis: asString(r.termination_penalty_basis),
    ownership_transfers_at_end: typeof r.ownership_transfers_at_end === "boolean" ? r.ownership_transfers_at_end : null,
    bargain_purchase_option: typeof r.bargain_purchase_option === "boolean" ? r.bargain_purchase_option : null,
    major_part_economic_life: typeof r.major_part_economic_life === "boolean" ? r.major_part_economic_life : null,
    major_part_economic_life_pct: asNumber(r.major_part_economic_life_pct),
    pv_substantially_all_fair_value: typeof r.pv_substantially_all_fair_value === "boolean" ? r.pv_substantially_all_fair_value : null,
    pv_to_fair_value_pct: asNumber(r.pv_to_fair_value_pct),
    asset_fair_value: asNumber(r.asset_fair_value),
    specialized_asset_no_alt_use: typeof r.specialized_asset_no_alt_use === "boolean" ? r.specialized_asset_no_alt_use : null,
    classification_criteria_basis: asString(r.classification_criteria_basis),
    renewal_options_rc_term_months: asNumber(r.renewal_options_rc_term_months),
    renewal_options_rc_basis: asString(r.renewal_options_rc_basis),
    short_term_lease_election: typeof r.short_term_lease_election === "boolean" ? r.short_term_lease_election : null,
    short_term_lease_election_basis: asString(r.short_term_lease_election_basis),
    variable_payments_description: asString(r.variable_payments_description),
    variable_payments_estimated_annual: asNumber(r.variable_payments_estimated_annual),
    sublease_income_annual: asNumber(r.sublease_income_annual),
    sublease_basis: asString(r.sublease_basis),
    last_updated_at: asString(r.last_updated_at),
    last_updated_by_label: asString(r.last_updated_by),
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

// Inlined per-workspace hourly rate limiter. Mirrors
// supabase/functions/_shared/audit.ts -> enforceWorkspaceRateLimit so
// the deploy bundle for this function stays under the deploy-tool
// payload envelope (Phase 7 A4 documented the ~65KB ceiling).
async function enforceWorkspaceRateLimit(
  supabaseAdmin: any,
  workspaceId: string | null,
  functionName: string,
  requestOrigin: string | null,
  limit = 20,
): Promise<Response | null> {
  if (!workspaceId) return null;
  const windowStart = new Date();
  windowStart.setUTCMinutes(0, 0, 0);
  const windowStartIso = windowStart.toISOString();
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("processing_rate_limits")
    .select("id, request_count")
    .eq("workspace_id", workspaceId)
    .eq("function_name", functionName)
    .eq("window_start", windowStartIso)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Failed to check rate limit: ${existingError.message}`);
  }
  if (existing && existing.request_count >= limit) {
    return jsonResponse(
      { error: "Rate limit exceeded. Please wait before retrying." },
      429,
      requestOrigin,
    );
  }
  const nextCount = (existing?.request_count || 0) + 1;
  const { error: upsertError } = await supabaseAdmin
    .from("processing_rate_limits")
    .upsert(
      {
        workspace_id: workspaceId,
        function_name: functionName,
        window_start: windowStartIso,
        request_count: nextCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,function_name,window_start" },
    );
  if (upsertError) {
    throw new Error(`Failed to update rate limit: ${upsertError.message}`);
  }
  return null;
}

interface RequestBody {
  leaseId: string;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function pickClassification(value: unknown): LeaseClassification {
  if (value === "operating" || value === "finance") return value;
  return "pending";
}

function shapeRentSchedule(rows: unknown): RentPeriod[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => {
      const monthly = asNumber(r.monthly_amount) ?? 0;
      const annualRaw = asNumber(r.annual_amount);
      return {
        period_start: asString(r.period_start) ?? "",
        period_end: asString(r.period_end) ?? "",
        monthly_amount: monthly,
        annual_amount: annualRaw ?? monthly * 12,
        notes: asString(r.notes),
      };
    })
    .filter((p) => p.period_start && p.period_end);
}

// Citations live inside the extracted_json blob from the AI pipeline.
// Field-level citation shape is { snippet: string; page: number }
// keyed by field name. We accept a few common shapes the pipeline has
// emitted historically.
function shapeCitations(extracted: unknown): Record<string, Citation> {
  const out: Record<string, Citation> = {};
  if (!extracted || typeof extracted !== "object") return out;
  const obj = extracted as Record<string, unknown>;
  const candidates = [obj.citations, obj.field_citations, obj.sources];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const entries = c as Record<string, unknown>;
    for (const [k, v] of Object.entries(entries)) {
      if (!v || typeof v !== "object") continue;
      const cell = v as Record<string, unknown>;
      const snippet = asString(cell.snippet) ?? asString(cell.text);
      const page = asNumber(cell.page) ?? asNumber(cell.page_number);
      if (snippet && page !== null) {
        out[k] = { snippet, page };
      }
    }
  }
  return out;
}

function shapeEscalation(lease: Record<string, unknown>): EscalationClause | null {
  const type = asString(lease.escalation_type);
  const rate = asNumber(lease.escalation_rate);
  const notes = asString(lease.escalation_clauses);
  if (!type && rate === null && !notes) return null;
  return { type, rate, notes };
}

function shapeRenewals(lease: Record<string, unknown>): RenewalOption[] {
  const ro = lease.renewal_options;
  if (Array.isArray(ro)) {
    return ro
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => ({
        option_term_months: asNumber(r.option_term_months ?? r.term_months),
        notice_required_days: asNumber(r.notice_required_days ?? r.notice_days),
        notes: asString(r.notes),
      }));
  }
  if (typeof ro === "string" && ro.trim().length > 0) {
    return [
      { option_term_months: null, notice_required_days: null, notes: ro },
    ];
  }
  return [];
}

function shapeTermination(
  lease: Record<string, unknown>,
): TerminationClause | null {
  const notes = asString(lease.termination_clauses);
  if (!notes) return null;
  return {
    early_termination_allowed: null,
    notice_days: null,
    penalty_amount: null,
    notes,
  };
}

function shapeAuditEntries(value: unknown): VerificationAuditEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => {
      const ct = asString(r.correction_type);
      const correctionType =
        ct === "add_missing" ||
        ct === "delete_wrong" ||
        ct === "edit" ||
        ct === "verified_unchanged"
          ? ct
          : "edit";
      return {
        field_id: asString(r.field_id) ?? "",
        original_value: asString(r.original_value),
        corrected_value: asString(r.corrected_value),
        correction_type: correctionType,
        corrected_at: asString(r.corrected_at) ?? new Date().toISOString(),
        corrected_by_user_label: asString(r.corrected_by) ?? "system",
        ai_confidence_at_correction: asNumber(r.ai_confidence_at_correction),
      } satisfies VerificationAuditEntry;
    })
    .filter((e) => e.field_id);
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { ok: false, error: "Server configuration error" },
      500,
      origin,
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { ok: false, error: "Unauthorized", reason: "no_auth" },
      401,
      origin,
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse(
      { ok: false, error: "Invalid authentication", reason: "invalid_auth" },
      401,
      origin,
    );
  }
  const user = userData.user;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { ok: false, error: "Invalid JSON body", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (!body?.leaseId || typeof body.leaseId !== "string") {
    return jsonResponse(
      { ok: false, error: "leaseId is required", reason: "bad_request" },
      400,
      origin,
    );
  }

  // Load lease + workspace authorization
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select(
      "id, workspace_id, lifecycle_status, model_locked, model_locked_at, model_locked_by, lease_classification, lease_classification_set_at, lease_classification_set_by, signator_attestation, signator_approved_at, request_title, filename, asset_type, landlord_name, tenant_name, property_address, lease_start, lease_end, term_months, executed_monthly_payment, current_monthly_rent, monthly_payment, escalation_type, escalation_rate, renewal_options, termination_clauses, escalation_clauses, security_deposit, calc_total_commitment, calc_pv_liability, calc_straight_line_exp, calc_cash_pl_delta, extracted_json, discount_rate, discount_rate_basis, discount_rate_set_at, discount_rate_set_by",
    )
    .eq("id", body.leaseId)
    .maybeSingle();

  if (leaseError) {
    return jsonResponse(
      { ok: false, error: "Failed to load lease", reason: "internal" },
      500,
      origin,
    );
  }
  if (!lease) {
    return jsonResponse(
      { ok: false, error: "Lease not found", reason: "not_found" },
      404,
      origin,
    );
  }

  const workspaceId = (lease as any).workspace_id as string;

  // Authorization: workspace owner OR member with role admin/editor
  let isAuthorized = false;
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select(
      "id, name, owner_id, discount_rate, report_organization_name, report_fiscal_year_start_month, report_rounding_precision, report_artifact_retention_days, report_default_discount_method",
    )
    .eq("id", workspaceId)
    .maybeSingle();
  if ((ws as any)?.owner_id === user.id) isAuthorized = true;
  if (!isAuthorized) {
    const { data: member } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    const role = (member as any)?.role;
    if (role === "admin" || role === "editor") isAuthorized = true;
  }
  if (!isAuthorized) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Forbidden — only workspace admins, editors, or owners can generate reports.",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }
  if (!ws) {
    return jsonResponse(
      { ok: false, error: "Workspace metadata missing", reason: "internal" },
      500,
      origin,
    );
  }

  // Phase 8 reports only finalized leases
  if (!(lease as any).model_locked) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Lease is not finalized (model_locked=false). Reports can only be generated for finalized leases.",
        reason: "not_locked",
      },
      400,
      origin,
    );
  }

  // Rate limit at workspace scope
  const rateLimit = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    workspaceId,
    "generate-lease-report",
    origin,
    30,
  );
  if (rateLimit) return rateLimit;

  // Capture organization context at generation time (forensic snapshot)
  const w = ws as any;
  const organizationName: string =
    w.report_organization_name || w.name || "Workspace";
  const fiscalYearStartMonth: number = w.report_fiscal_year_start_month ?? 1;
  const roundingPrecision: number = w.report_rounding_precision ?? 2;
  const retentionDays: number = w.report_artifact_retention_days ?? 90;
  const discountRateMethod: string =
    w.report_default_discount_method ?? "workspace_default";
  // ASC 842 compliance: prefer the per-lease IBR override, fall back
  // to the workspace default. The view v_lease_verification_audit
  // surfaces this same COALESCE; we duplicate the logic here so the
  // ReportInputs.discount_rate is always the effective rate.
  const perLeaseRate = asNumber((lease as any).discount_rate);
  const workspaceRate = asNumber(w.discount_rate) ?? 0;
  const discountRate: number =
    perLeaseRate !== null && perLeaseRate > 0 ? perLeaseRate : workspaceRate;
  const discountRateSource: "per_lease" | "workspace_default" =
    perLeaseRate !== null && perLeaseRate > 0 ? "per_lease" : "workspace_default";
  const discountRateBasis = asString((lease as any).discount_rate_basis);

  const workspaceSettingsSnapshot = {
    organization_name: organizationName,
    fiscal_year_start_month: fiscalYearStartMonth,
    rounding_precision: roundingPrecision,
    retention_days: retentionDays,
    discount_rate_method: discountRateMethod,
    discount_rate: discountRate,
    discount_rate_source: discountRateSource,
    discount_rate_basis: discountRateBasis,
    workspace_default_rate: workspaceRate,
    per_lease_override_rate: perLeaseRate,
  };

  const expiresAt = new Date(
    Date.now() + retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Insert lease_reports row in 'generating' state. Edge function uses
  // service role; the row's RLS policy allows the actor to read it.
  const { data: reportRow, error: insertError } = await supabaseAdmin
    .from("lease_reports")
    .insert({
      workspace_id: workspaceId,
      report_type: "lease_disclosure",
      report_scope: "single_lease",
      lease_id: (lease as any).id,
      generated_by: user.id,
      status: "generating",
      organization_name_at_gen: organizationName,
      discount_rate_method_at_gen: discountRateMethod,
      workspace_settings_snapshot: workspaceSettingsSnapshot,
      expires_at: expiresAt,
    })
    .select("id, generated_at")
    .single();

  if (insertError || !reportRow) {
    return jsonResponse(
      {
        ok: false,
        error: `Failed to create report row: ${insertError?.message ?? "unknown"}`,
        reason: "internal",
      },
      500,
      origin,
    );
  }

  const reportId = (reportRow as any).id as string;

  // Log requested
  await supabaseAdmin.from("lease_activity_log").insert({
    lease_id: (lease as any).id,
    user_id: user.id,
    activity_type: "report_generation_requested",
    details: {
      report_id: reportId,
      report_type: "lease_disclosure",
      requested_by: user.id,
    },
  });

  try {
    // Load supporting data — including the per-lease ASC 842 inputs row
    const [{ data: rentSchedules }, { data: corrections }, { data: auditView }, { data: asc842Row }] =
      await Promise.all([
        supabaseAdmin
          .from("rent_schedules")
          .select("period_start, period_end, monthly_amount, annual_amount, notes")
          .eq("lease_id", (lease as any).id)
          .order("period_start"),
        supabaseAdmin
          .from("field_corrections")
          .select(
            "field_name, original_value, corrected_value, correction_type, corrected_at, corrected_by, ai_confidence",
          )
          .eq("lease_id", (lease as any).id),
        supabaseAdmin
          .from("v_lease_verification_audit")
          .select("field_corrections")
          .eq("lease_id", (lease as any).id)
          .maybeSingle(),
        supabaseAdmin
          .from("lease_asc842_inputs")
          .select("*")
          .eq("lease_id", (lease as any).id)
          .maybeSingle(),
      ]);

    const auditFromView = (auditView as any)?.field_corrections;
    const verificationAudit = shapeAuditEntries(auditFromView ?? corrections);

    // ReportInputs assembly
    const l = lease as any;
    const monthlyPayment =
      asNumber(l.executed_monthly_payment) ??
      asNumber(l.current_monthly_rent) ??
      asNumber(l.monthly_payment);

    const inputs: ReportInputs = {
      lease_id: l.id,
      workspace_id: workspaceId,
      tenant_name: asString(l.tenant_name),
      landlord_name: asString(l.landlord_name),
      property_address: asString(l.property_address),
      asset_type: asString(l.asset_type),
      execution_date: asString(l.lease_start),
      commencement_date: asString(l.lease_start),
      rent_commencement_date: asString(l.lease_start),
      expiration_date: asString(l.lease_end),
      term_months: asNumber(l.term_months),
      lease_classification: pickClassification(l.lease_classification),
      classification_set_at: asString(l.lease_classification_set_at),
      classification_set_by_user_label: asString(l.lease_classification_set_by),
      discount_rate: discountRate,
      monthly_payment: monthlyPayment,
      rent_schedule: shapeRentSchedule(rentSchedules),
      security_deposit: asNumber(l.security_deposit),
      pv_liability: asNumber(l.calc_pv_liability),
      total_commitment: asNumber(l.calc_total_commitment),
      straight_line_monthly_expense: asNumber(l.calc_straight_line_exp),
      cash_pl_delta: asNumber(l.calc_cash_pl_delta),
      escalation_clause: shapeEscalation(l),
      renewal_options: shapeRenewals(l),
      termination_clause: shapeTermination(l),
      verification_audit: verificationAudit,
      signator_attestation: asString(l.signator_attestation),
      signator_approved_at: asString(l.signator_approved_at),
      model_locked_at: asString(l.model_locked_at),
      model_locked_by_user_label: asString(l.model_locked_by),
      field_citations: shapeCitations(l.extracted_json),
      asc842_inputs: shapeAsc842Inputs(asc842Row as Record<string, unknown> | null),
    };

    // Build sections + JSON
    const sections = buildLeaseDisclosureSections(inputs);
    const json = buildLeaseDisclosureJson(inputs);

    // Upload JSON to storage
    const jsonStoragePath = `${workspaceId}/${reportId}/data.json`;
    const jsonBlob = new TextEncoder().encode(JSON.stringify(json, null, 2));
    const { error: jsonUploadError } = await supabaseAdmin.storage
      .from("lease-reports")
      .upload(jsonStoragePath, jsonBlob, {
        contentType: "application/json",
        upsert: true,
      });
    if (jsonUploadError) {
      throw new Error(`JSON upload failed: ${jsonUploadError.message}`);
    }

    // Mark ready (PDF will be uploaded by client; pdf_storage_path
    // populated via finalize-report-pdf when client completes upload)
    await supabaseAdmin
      .from("lease_reports")
      .update({
        status: "ready",
        json_storage_path: jsonStoragePath,
        lease_count: 1,
      })
      .eq("id", reportId);

    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: l.id,
      user_id: user.id,
      activity_type: "report_generation_completed",
      details: {
        report_id: reportId,
        report_type: "lease_disclosure",
        json_storage_path: jsonStoragePath,
      },
    });

    const leaseLabel: string =
      l.request_title || l.tenant_name || l.filename || `Lease ${l.id.slice(0, 8)}`;

    const expectedPdfStoragePath = `${workspaceId}/${reportId}/report.pdf`;

    return jsonResponse(
      {
        ok: true,
        reportId,
        leaseLabel,
        organizationName,
        sections,
        json,
        jsonStoragePath,
        expectedPdfStoragePath,
        workspaceSettingsSnapshot,
      },
      200,
      origin,
    );
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await supabaseAdmin
      .from("lease_reports")
      .update({ status: "failed", error_message: message })
      .eq("id", reportId);
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: (lease as any).id,
      user_id: user.id,
      activity_type: "report_generation_failed",
      details: { report_id: reportId, error: message },
    });
    return jsonResponse(
      { ok: false, error: message, reason: "generation_failed", reportId },
      500,
      origin,
    );
  }
});
