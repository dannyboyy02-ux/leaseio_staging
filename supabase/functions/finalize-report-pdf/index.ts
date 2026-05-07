// finalize-report-pdf — Phase 8 Checkpoint 3
//
// Records the storage path of a client-rendered PDF artifact onto an
// existing lease_reports row. Phase 8 ships with PDF generation
// performed in the browser via @react-pdf/renderer (limitation of the
// PDF library — it cannot run reliably in Deno). The flow is:
//
//   1. Client invokes generate-lease-report or generate-portfolio-report
//      → edge function uploads JSON, returns sections, and creates a
//      lease_reports row with status='ready' and pdf_storage_path=NULL.
//   2. Client renders the PDF via pdf(<DisclosureDocument />).toBlob()
//      and uploads the blob to lease-reports/{workspace_id}/{report_id}/report.pdf
//      using its own session.
//   3. Client invokes this function with { reportId, pdfStoragePath }.
//      We verify the caller is the original generator (or a workspace
//      admin/owner) and PATCH the row's pdf_storage_path. We also log
//      a 'report_downloaded' or 'report_generation_completed' marker in
//      lease_activity_log if the report is tied to a lease (single
//      scope) — portfolio reports carry no lease anchor and skip the
//      activity row.
//
// Future enhancement (KNOWN_ISSUES #13): swap to background-queue PDF
// rendering; this endpoint becomes obsolete.
//
// AUTHORIZATION
//   - Bearer JWT (verify_jwt = true)
//   - Caller must be:
//     * the original generated_by user, OR
//     * the workspace owner, OR
//     * a workspace member with role 'admin'
//
// VALIDATION
//   - reportId required
//   - pdfStoragePath required and must match the canonical path
//     {workspace_id}/{reportId}/report.pdf to prevent rebinding to an
//     arbitrary object.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";

function corsHeaders(origin: string | null): Record<string, string> {
  return baseCorsHeaders(origin, "POST, OPTIONS");
}

function jsonResponse(payload: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

interface RequestBody {
  reportId: string;
  pdfStoragePath: string;
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
  if (!body?.reportId || typeof body.reportId !== "string") {
    return jsonResponse(
      { ok: false, error: "reportId is required", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (!body?.pdfStoragePath || typeof body.pdfStoragePath !== "string") {
    return jsonResponse(
      { ok: false, error: "pdfStoragePath is required", reason: "bad_request" },
      400,
      origin,
    );
  }

  const { data: report, error: reportError } = await supabaseAdmin
    .from("lease_reports")
    .select(
      "id, workspace_id, lease_id, generated_by, status, pdf_storage_path, json_storage_path",
    )
    .eq("id", body.reportId)
    .maybeSingle();

  if (reportError) {
    return jsonResponse(
      { ok: false, error: "Failed to load report", reason: "internal" },
      500,
      origin,
    );
  }
  if (!report) {
    return jsonResponse(
      { ok: false, error: "Report not found", reason: "not_found" },
      404,
      origin,
    );
  }

  const r = report as any;
  const expectedPath = `${r.workspace_id}/${r.id}/report.pdf`;
  if (body.pdfStoragePath !== expectedPath) {
    return jsonResponse(
      {
        ok: false,
        error: "pdfStoragePath does not match the canonical report path",
        reason: "bad_request",
        expected: expectedPath,
      },
      400,
      origin,
    );
  }

  // Authorization: original generator OR workspace owner OR admin
  let isAuthorized = false;
  if (r.generated_by === user.id) isAuthorized = true;
  if (!isAuthorized) {
    const { data: ws } = await supabaseAdmin
      .from("workspaces")
      .select("owner_id")
      .eq("id", r.workspace_id)
      .maybeSingle();
    if ((ws as any)?.owner_id === user.id) isAuthorized = true;
  }
  if (!isAuthorized) {
    const { data: member } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", r.workspace_id)
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (member) isAuthorized = true;
  }
  if (!isAuthorized) {
    return jsonResponse(
      {
        ok: false,
        error: "Forbidden — only the report's generator, workspace admins, or the workspace owner can finalize a report.",
        reason: "not_authorized",
      },
      403,
      origin,
    );
  }

  // Idempotency: if pdf_storage_path already populated and matches, return ok
  if (r.pdf_storage_path === body.pdfStoragePath) {
    return jsonResponse(
      { ok: true, reportId: r.id, alreadyFinalized: true },
      200,
      origin,
    );
  }

  const { error: updateError } = await supabaseAdmin
    .from("lease_reports")
    .update({ pdf_storage_path: body.pdfStoragePath })
    .eq("id", r.id);

  if (updateError) {
    return jsonResponse(
      {
        ok: false,
        error: `Failed to record PDF path: ${updateError.message}`,
        reason: "internal",
      },
      500,
      origin,
    );
  }

  // Activity log only for single-lease reports (portfolio has no anchor)
  if (r.lease_id) {
    await supabaseAdmin.from("lease_activity_log").insert({
      lease_id: r.lease_id,
      user_id: user.id,
      activity_type: "report_generation_completed",
      details: {
        report_id: r.id,
        report_type: "lease_disclosure",
        pdf_storage_path: body.pdfStoragePath,
        finalized: true,
      },
    });
  }

  return jsonResponse({ ok: true, reportId: r.id }, 200, origin);
});
