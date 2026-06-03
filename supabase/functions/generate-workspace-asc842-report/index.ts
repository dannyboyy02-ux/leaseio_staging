// generate-workspace-asc842-report
//
// Builds the section payloads for an ASC 842 disclosure report covering
// every model-locked lease in a workspace. The client receives the
// payload array and renders a single consolidated PDF for download.
//
// This is the workspace-wide companion to generate-lease-report. Unlike
// that function:
//   - It does NOT create lease_reports rows (the consolidated PDF is
//     ephemeral; per-lease library entries are produced by the per-lease
//     report flow if desired).
//   - It does NOT upload artifacts to storage.
//   - It returns the same per-lease section shape so the same
//     LeaseDisclosureDocument pieces render under a cover page.
//
// AUTHORIZATION
//   - Bearer JWT (verify_jwt = true)
//   - Caller must be workspace owner OR a member with role admin/editor.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import {
  buildLeaseDisclosureSections,
  type Asc842Inputs,
  type Citation,
  type EscalationClause,
  type LeaseClassification,
  type RenewalOption,
  type ReportInputs,
  type RentPeriod,
  type ReportSection,
  type TerminationClause,
  type VerificationAuditEntry,
} from "../_shared/asc842_report.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pickClassification(value: unknown): LeaseClassification {
  if (value === "operating" || value === "finance") return value;
  return "pending";
}

function shapeRentSchedule(rows: unknown): RentPeriod[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      period_start: asString(r.period_start) ?? "",
      period_end: asString(r.period_end) ?? "",
      monthly_amount: asNumber(r.monthly_amount) ?? 0,
      annual_amount: asNumber(r.annual_amount),
      notes: asString(r.notes),
    }))
    .filter((r) => r.period_start && r.period_end);
}

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
    return [{ option_term_months: null, notice_required_days: null, notes: ro }];
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
    specialized_no_alternative_use: typeof r.specialized_no_alternative_use === "boolean" ? r.specialized_no_alternative_use : null,
    specialized_no_alternative_use_basis: asString(r.specialized_no_alternative_use_basis),
    short_term_election: typeof r.short_term_election === "boolean" ? r.short_term_election : null,
    short_term_election_basis: asString(r.short_term_election_basis),
    practical_expedients_applied: Array.isArray(r.practical_expedients_applied)
      ? (r.practical_expedients_applied as string[])
      : null,
    related_party_disclosure: asString(r.related_party_disclosure),
    auditor_attention_notes: asString(r.auditor_attention_notes),
  };
}

const LEASE_SELECT = "id, workspace_id, lifecycle_status, model_locked, model_locked_at, model_locked_by, lease_classification, lease_classification_set_at, lease_classification_set_by, signator_attestation, signator_approved_at, request_title, filename, asset_type, landlord_name, tenant_name, property_address, lease_start, lease_end, term_months, executed_monthly_payment, current_monthly_rent, monthly_payment, escalation_type, escalation_rate, renewal_options, termination_clauses, escalation_clauses, security_deposit, calc_total_commitment, calc_pv_liability, calc_straight_line_exp, calc_cash_pl_delta, extracted_json, discount_rate, discount_rate_basis, discount_rate_set_at, discount_rate_set_by";

interface RequestBody {
  workspaceId?: string;
}

interface LeasePayload {
  leaseId: string;
  leaseLabel: string;
  sections: ReportSection[];
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, origin);
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "Unauthorized", reason: "no_auth" }, 401, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ ok: false, error: "Invalid authentication", reason: "invalid_auth" }, 401, origin);
  }
  const user = userData.user;

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body", reason: "bad_request" }, 400, origin);
  }
  if (!body?.workspaceId || typeof body.workspaceId !== "string") {
    return jsonResponse({ ok: false, error: "workspaceId is required", reason: "bad_request" }, 400, origin);
  }
  const workspaceId = body.workspaceId;

  // Authorization: workspace owner OR member with role admin/editor.
  const { data: ws } = await supabaseAdmin
    .from("workspaces")
    .select(
      "id, name, owner_id, discount_rate, report_organization_name, report_fiscal_year_start_month, report_rounding_precision, report_artifact_retention_days, report_default_discount_method",
    )
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws) {
    return jsonResponse({ ok: false, error: "Workspace not found", reason: "not_found" }, 404, origin);
  }

  let isAuthorized = (ws as any).owner_id === user.id;
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
      { ok: false, error: "Forbidden — workspace admins, editors, or owners only.", reason: "not_authorized" },
      403,
      origin,
    );
  }

  // Rate limit at workspace scope — conservative because each call can fan
  // out to many lease loads.
  const rateLimit = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    workspaceId,
    "generate-workspace-asc842-report",
    origin,
    10,
  );
  if (rateLimit) return rateLimit;

  const w = ws as any;
  const organizationName: string = w.report_organization_name || w.name || "Workspace";
  const workspaceRate = asNumber(w.discount_rate) ?? 0;

  // Fetch all model_locked leases for the workspace.
  const { data: leases, error: leasesError } = await supabaseAdmin
    .from("leases")
    .select(LEASE_SELECT)
    .eq("workspace_id", workspaceId)
    .eq("model_locked", true)
    .eq("archived", false)
    .order("lease_start", { ascending: true });

  if (leasesError) {
    return jsonResponse({ ok: false, error: `Failed to load leases: ${leasesError.message}` }, 500, origin);
  }

  const leaseRows = (leases ?? []) as Array<Record<string, unknown>>;

  if (leaseRows.length === 0) {
    return jsonResponse(
      {
        ok: true,
        organizationName,
        leaseCount: 0,
        leases: [] as LeasePayload[],
      },
      200,
      origin,
    );
  }

  const payloads: LeasePayload[] = [];

  for (const l of leaseRows) {
    const leaseId = l.id as string;

    const [{ data: rentSchedules }, { data: auditView }, { data: asc842Row }] =
      await Promise.all([
        supabaseAdmin
          .from("rent_schedules")
          .select("period_start, period_end, monthly_amount, annual_amount, notes")
          .eq("lease_id", leaseId)
          .order("period_start"),
        supabaseAdmin
          .from("v_lease_verification_audit")
          .select("field_corrections")
          .eq("lease_id", leaseId)
          .maybeSingle(),
        supabaseAdmin
          .from("lease_asc842_inputs")
          .select("*")
          .eq("lease_id", leaseId)
          .maybeSingle(),
      ]);

    const verificationAudit = shapeAuditEntries((auditView as any)?.field_corrections);
    const perLeaseRate = asNumber(l.discount_rate);
    const effectiveRate = perLeaseRate !== null && perLeaseRate > 0 ? perLeaseRate : workspaceRate;
    const monthlyPayment =
      asNumber(l.executed_monthly_payment) ??
      asNumber(l.current_monthly_rent) ??
      asNumber(l.monthly_payment);

    const inputs: ReportInputs = {
      lease_id: leaseId,
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
      discount_rate: effectiveRate,
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

    const sections = buildLeaseDisclosureSections(inputs);
    const leaseLabel =
      asString(l.request_title) ??
      asString(l.tenant_name) ??
      asString(l.filename) ??
      `Lease ${leaseId.slice(0, 8)}`;

    payloads.push({ leaseId, leaseLabel, sections });
  }

  return jsonResponse(
    {
      ok: true,
      organizationName,
      leaseCount: payloads.length,
      leases: payloads,
    },
    200,
    origin,
  );
});
