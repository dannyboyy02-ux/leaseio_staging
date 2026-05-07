// generate-portfolio-report — Phase 8 Checkpoint 3
//
// Produces a portfolio-period ASC 842 disclosure report covering all
// eligible leases in a workspace whose term overlaps the requested
// period. Uses partitionPortfolioCandidates from the shared pure-logic
// module to apply the report-eligibility criteria
// (model_locked + active + period overlap + verification complete) and
// then aggregates included leases via buildPortfolioPeriodReport.
//
// Like generate-lease-report, the JSON is uploaded server-side and the
// PDF is rendered client-side (limitation of @react-pdf/renderer).
// finalize-report-pdf records the pdf_storage_path after client upload.
//
// AUTHORIZATION
//   - Bearer JWT (verify_jwt = true)
//   - Caller must be a workspace member with role 'admin' OR 'editor'
//     OR the workspace owner. Editors can request portfolio reports
//     because they are the typical day-to-day finance operators; admins
//     get the same surface plus retroactive deletion via the
//     lease_reports DELETE policy.
//
// VALIDATION
//   - workspaceId required
//   - reportScope ∈ {monthly, quarterly, annual, custom_range}
//   - periodStart ≤ periodEnd
//   - Period bounds must be ISO date strings (YYYY-MM-DD)
//
// ACTIVITY LOG
// Portfolio reports are not tied to a single lease; the
// report_generation_* activity rows still go to lease_activity_log but
// with lease_id = NULL... wait — lease_activity_log.lease_id is NOT
// NULL. So portfolio activity goes against an arbitrary "anchor" lease
// or is omitted at the lease scope. Phase 8 As-built decision: skip
// per-lease activity rows for portfolio generation; the lease_reports
// row itself is the audit trail at the workspace level. This keeps the
// activity log a per-lease vehicle and avoids creating a placeholder
// lease_id reference.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import {
  buildPortfolioPeriodReport,
  partitionPortfolioCandidates,
  type Asc842Inputs,
  type EscalationClause,
  type ExcludedLease,
  type LeaseClassification,
  type PortfolioCandidate,
  type RenewalOption,
  type ReportInputs,
  type RentPeriod,
  type TerminationClause,
  type VerificationAuditEntry,
  type WorkspacePortfolioContext,
} from "../_shared/asc842_report.ts";

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
// the deploy bundle stays under the deploy-tool payload envelope
// (Phase 7 A4 documented the ~65KB ceiling).
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
  workspaceId: string;
  reportScope: "monthly" | "quarterly" | "annual" | "custom_range";
  periodStart: string;
  periodEnd: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

  if (!body?.workspaceId || typeof body.workspaceId !== "string") {
    return jsonResponse(
      { ok: false, error: "workspaceId is required", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (
    body.reportScope !== "monthly" &&
    body.reportScope !== "quarterly" &&
    body.reportScope !== "annual" &&
    body.reportScope !== "custom_range"
  ) {
    return jsonResponse(
      { ok: false, error: "Invalid reportScope", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (!ISO_DATE.test(body.periodStart) || !ISO_DATE.test(body.periodEnd)) {
    return jsonResponse(
      {
        ok: false,
        error: "periodStart and periodEnd must be YYYY-MM-DD",
        reason: "bad_request",
      },
      400,
      origin,
    );
  }
  if (body.periodStart > body.periodEnd) {
    return jsonResponse(
      {
        ok: false,
        error: "periodStart must be on or before periodEnd",
        reason: "bad_request",
      },
      400,
      origin,
    );
  }

  // Authorization: workspace owner OR member with role admin/editor
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select(
      "id, name, owner_id, discount_rate, report_organization_name, report_fiscal_year_start_month, report_rounding_precision, report_artifact_retention_days, report_default_discount_method",
    )
    .eq("id", body.workspaceId)
    .maybeSingle();
  if (!ws) {
    return jsonResponse(
      { ok: false, error: "Workspace not found", reason: "not_found" },
      404,
      origin,
    );
  }
  let isAuthorized = false;
  if ((ws as any).owner_id === user.id) isAuthorized = true;
  if (!isAuthorized) {
    const { data: member } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", body.workspaceId)
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
          "Forbidden — only workspace admins, editors, or owners can generate portfolio reports.",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }

  const rateLimit = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    body.workspaceId,
    "generate-portfolio-report",
    origin,
    10,
  );
  if (rateLimit) return rateLimit;

  const w = ws as any;
  const organizationName: string =
    w.report_organization_name || w.name || "Workspace";
  const fiscalYearStartMonth: number = w.report_fiscal_year_start_month ?? 1;
  const roundingPrecision: number = w.report_rounding_precision ?? 2;
  const retentionDays: number = w.report_artifact_retention_days ?? 90;
  const discountRateMethod: string =
    w.report_default_discount_method ?? "workspace_default";
  const discountRate: number = asNumber(w.discount_rate) ?? 0;

  const workspaceSettingsSnapshot = {
    organization_name: organizationName,
    fiscal_year_start_month: fiscalYearStartMonth,
    rounding_precision: roundingPrecision,
    retention_days: retentionDays,
    discount_rate_method: discountRateMethod,
    discount_rate: discountRate,
  };

  const expiresAt = new Date(
    Date.now() + retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // Insert the lease_reports row first so any failure can mark it.
  const { data: reportRow, error: insertError } = await supabaseAdmin
    .from("lease_reports")
    .insert({
      workspace_id: body.workspaceId,
      report_type: "portfolio_period",
      report_scope: body.reportScope,
      period_start: body.periodStart,
      period_end: body.periodEnd,
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

  try {
    // Load all candidate leases in the workspace
    const { data: candidates, error: candidatesError } = await supabaseAdmin
      .from("leases")
      .select(
        "id, workspace_id, lifecycle_status, model_locked, model_locked_at, model_locked_by, lease_classification, lease_classification_set_at, lease_classification_set_by, signator_attestation, signator_approved_at, request_title, filename, asset_type, landlord_name, tenant_name, property_address, lease_start, lease_end, term_months, executed_monthly_payment, current_monthly_rent, monthly_payment, escalation_type, escalation_rate, renewal_options, termination_clauses, escalation_clauses, security_deposit, calc_total_commitment, calc_pv_liability, calc_straight_line_exp, calc_cash_pl_delta, extracted_json, confirmed_sections, discount_rate, discount_rate_basis, discount_rate_set_at, discount_rate_set_by",
      )
      .eq("workspace_id", body.workspaceId);

    if (candidatesError) {
      throw new Error(`Failed to load candidate leases: ${candidatesError.message}`);
    }

    const candidateList = (candidates ?? []) as Array<Record<string, unknown>>;

    // Verification-complete heuristic: model_locked = true AND
    // confirmed_sections jsonb is non-empty (has at least one
    // confirmed entry). The exact required-section list is per-
    // workspace and outside C3 scope; the `model_locked` flag is the
    // primary gate.
    const partitionInput: PortfolioCandidate[] = candidateList.map((c) => ({
      lease_id: asString(c.id) ?? "",
      model_locked: !!c.model_locked,
      lifecycle_status: asString(c.lifecycle_status),
      commencement_date: asString(c.lease_start),
      expiration_date: asString(c.lease_end),
      verification_complete:
        !!c.model_locked &&
        Array.isArray(c.confirmed_sections) &&
        (c.confirmed_sections as unknown[]).length > 0,
    }));

    const { included_lease_ids, excluded } = partitionPortfolioCandidates(
      partitionInput,
      { start: body.periodStart, end: body.periodEnd },
    );

    const includedSet = new Set(included_lease_ids);
    const includedLeaseRows = candidateList.filter(
      (c) => includedSet.has(asString(c.id) ?? ""),
    );

    // For each included lease, load rent_schedules + audit view + asc842 inputs in parallel
    const leaseIds = includedLeaseRows.map((c) => asString(c.id) ?? "");
    const [{ data: allRentSchedules }, { data: allAuditViews }, { data: allAsc842 }] =
      await Promise.all([
        leaseIds.length > 0
          ? supabaseAdmin
              .from("rent_schedules")
              .select(
                "lease_id, period_start, period_end, monthly_amount, annual_amount, notes",
              )
              .in("lease_id", leaseIds)
              .order("period_start")
          : Promise.resolve({ data: [] as any[], error: null }),
        leaseIds.length > 0
          ? supabaseAdmin
              .from("v_lease_verification_audit")
              .select("lease_id, field_corrections")
              .in("lease_id", leaseIds)
          : Promise.resolve({ data: [] as any[], error: null }),
        leaseIds.length > 0
          ? supabaseAdmin
              .from("lease_asc842_inputs")
              .select("*")
              .in("lease_id", leaseIds)
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);

    const rentByLease = new Map<string, any[]>();
    for (const row of (allRentSchedules ?? []) as any[]) {
      const id = row.lease_id as string;
      const list = rentByLease.get(id) ?? [];
      list.push(row);
      rentByLease.set(id, list);
    }
    const auditByLease = new Map<string, unknown>();
    for (const row of (allAuditViews ?? []) as any[]) {
      auditByLease.set(row.lease_id as string, row.field_corrections);
    }
    const asc842ByLease = new Map<string, Record<string, unknown>>();
    for (const row of (allAsc842 ?? []) as any[]) {
      asc842ByLease.set(row.lease_id as string, row as Record<string, unknown>);
    }

    const leaseInputs: ReportInputs[] = includedLeaseRows.map((l) => {
      const id = asString(l.id) ?? "";
      const monthlyPayment =
        asNumber(l.executed_monthly_payment) ??
        asNumber(l.current_monthly_rent) ??
        asNumber(l.monthly_payment);
      // ASC 842 per-lease IBR: prefer per-lease override, fall back
      // to workspace default. Each lease in the portfolio gets its
      // own effective rate.
      const perLeaseRate = asNumber(l.discount_rate);
      const effectiveRate =
        perLeaseRate !== null && perLeaseRate > 0
          ? perLeaseRate
          : discountRate;
      return {
        lease_id: id,
        workspace_id: body.workspaceId,
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
        discount_rate: effectiveRate,
        monthly_payment: monthlyPayment,
        rent_schedule: shapeRentSchedule(rentByLease.get(id) ?? []),
        security_deposit: asNumber(l.security_deposit),
        pv_liability: asNumber(l.calc_pv_liability),
        total_commitment: asNumber(l.calc_total_commitment),
        straight_line_monthly_expense: asNumber(l.calc_straight_line_exp),
        cash_pl_delta: asNumber(l.calc_cash_pl_delta),
        escalation_clause: shapeEscalation(l),
        renewal_options: shapeRenewals(l),
        termination_clause: shapeTermination(l),
        verification_audit: shapeAuditEntries(auditByLease.get(id)),
        signator_attestation: asString(l.signator_attestation),
        signator_approved_at: asString(l.signator_approved_at),
        model_locked_at: asString(l.model_locked_at),
        model_locked_by_user_label: asString(l.model_locked_by),
        field_citations: {},
        asc842_inputs: shapeAsc842Inputs(asc842ByLease.get(id) ?? null),
      } satisfies ReportInputs;
    });

    const ctx: WorkspacePortfolioContext = {
      workspace_id: body.workspaceId,
      organization_name: organizationName,
      fiscal_year_start_month: fiscalYearStartMonth,
      rounding_precision: roundingPrecision,
      discount_rate_method: discountRateMethod,
    };

    const portfolioReport = buildPortfolioPeriodReport(
      leaseInputs,
      excluded as ExcludedLease[],
      { start: body.periodStart, end: body.periodEnd },
      ctx,
    );

    const jsonStoragePath = `${body.workspaceId}/${reportId}/data.json`;
    const jsonBlob = new TextEncoder().encode(
      JSON.stringify(portfolioReport, null, 2),
    );
    const { error: jsonUploadError } = await supabaseAdmin.storage
      .from("lease-reports")
      .upload(jsonStoragePath, jsonBlob, {
        contentType: "application/json",
        upsert: true,
      });
    if (jsonUploadError) {
      throw new Error(`JSON upload failed: ${jsonUploadError.message}`);
    }

    // Group exclusion reasons in the lease_reports row
    const exclusionReasons: Record<string, string[]> = {};
    for (const e of excluded) {
      const list = exclusionReasons[e.reason] ?? [];
      list.push(e.lease_id);
      exclusionReasons[e.reason] = list;
    }

    await supabaseAdmin
      .from("lease_reports")
      .update({
        status: "ready",
        json_storage_path: jsonStoragePath,
        lease_count: leaseInputs.length,
        excluded_lease_count: excluded.length,
        exclusion_reasons: exclusionReasons,
      })
      .eq("id", reportId);

    const expectedPdfStoragePath = `${body.workspaceId}/${reportId}/report.pdf`;

    return jsonResponse(
      {
        ok: true,
        reportId,
        organizationName,
        portfolioReport,
        jsonStoragePath,
        expectedPdfStoragePath,
        workspaceSettingsSnapshot,
        leaseCount: leaseInputs.length,
        excludedCount: excluded.length,
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
    return jsonResponse(
      { ok: false, error: message, reason: "generation_failed", reportId },
      500,
      origin,
    );
  }
});
