// upload-lease-document — Phase 4 Checkpoint 3
//
// Inserts a lease_documents metadata row after the frontend has already
// uploaded the file bytes to the lease-documents storage bucket. This
// function does NOT handle bytes — keeping it metadata-only avoids
// edge-function timeout issues for large negotiation documents (50MB
// bucket limit) and lets supabase-js handle the upload natively
// client-side.
//
// AUTHORIZATION
//   - Caller must present a valid Bearer JWT (verify_jwt = true)
//   - Caller must be a workspace member (admin / editor / viewer / owner)
//     of the workspace that owns the lease — RLS on the SELECT lease check
//     enforces this transitively.
//   - Caller must have admin / editor / owner role to actually create
//     a lease_documents row (RLS on lease_documents INSERT).
//
// CONTRACT
//   POST { leaseId, documentType, storagePath, filename, mimeType?,
//          fileSizeBytes?, notes? }
//   →  { ok: true, document: { id, iteration_number, version_number,
//                              is_current_latest } }
//   On failure: { ok: false, error, reason }
//
// The is_current_latest_promotion happens via the AFTER INSERT trigger
// (maintain_lease_document_latest_flag); this function never sets it.
//
// See docs/PHASE_4_BUILD_SPEC.md.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { enforceWorkspaceRateLimit } from "../_shared/audit.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";
import {
  type DocumentType,
  ALL_DOCUMENT_TYPES,
  nextIterationNumber,
  nextVersionNumber,
} from "../_shared/lease_documents.ts";

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
  leaseId: string;
  documentType: DocumentType;
  storagePath: string;
  filename: string;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  notes?: string | null;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
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

  // ── Body validation ────────────────────────────────────────────────
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
  if (!body?.documentType || !ALL_DOCUMENT_TYPES.includes(body.documentType)) {
    return jsonResponse(
      {
        ok: false,
        error: `documentType must be one of: ${ALL_DOCUMENT_TYPES.join(", ")}`,
        reason: "bad_request",
      },
      400,
      origin,
    );
  }
  if (!body?.storagePath || typeof body.storagePath !== "string") {
    return jsonResponse(
      { ok: false, error: "storagePath is required", reason: "bad_request" },
      400,
      origin,
    );
  }
  if (!body?.filename || typeof body.filename !== "string") {
    return jsonResponse(
      { ok: false, error: "filename is required", reason: "bad_request" },
      400,
      origin,
    );
  }

  // ── Load lease + verify workspace access ───────────────────────────
  const { data: lease, error: leaseError } = await supabaseAdmin
    .from("leases")
    .select("id, workspace_id")
    .eq("id", body.leaseId)
    .maybeSingle();
  if (leaseError) {
    console.error("[upload-lease-document] lease load error:", leaseError.message);
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
  const ws = (lease as { id: string; workspace_id: string }).workspace_id;

  // Vault V1: workspace liveness gate — no mutations on canceled /
  // soft-deleted / vault workspaces (fail closed).
  const liveness = await checkWorkspaceLive(supabaseAdmin, ws);
  if (!liveness.live) {
    return jsonResponse(
      { ok: false, error: "subscription_inactive", reason: liveness.reason },
      403,
      origin,
    );
  }

  // Caller must be a workspace member (any role) or the workspace owner.
  // Whether they can actually INSERT is enforced by lease_documents RLS
  // (admin / editor / owner) — but checking workspace membership here
  // gives a clean 403 for viewers instead of a confusing RLS error.
  const { data: ownerCheck } = await supabaseAdmin
    .from("workspaces")
    .select("owner_id")
    .eq("id", ws)
    .maybeSingle();
  const isOwner = (ownerCheck as { owner_id: string } | null)?.owner_id === user.id;

  let isWriter = isOwner;
  if (!isWriter) {
    const { data: memberRow } = await supabaseAdmin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", ws)
      .eq("user_id", user.id)
      .maybeSingle();
    const role = (memberRow as { role: string } | null)?.role;
    isWriter = role === "admin" || role === "editor";
  }

  if (!isWriter) {
    return jsonResponse(
      {
        ok: false,
        error: "Forbidden — only workspace owners, admins, and editors can upload documents",
        reason: "not_writer",
      },
      403,
      origin,
    );
  }

  // ── Rate limit ─────────────────────────────────────────────────────
  // Generous ceiling — uploads during heavy negotiation rounds are normal.
  const rateLimitResponse = await enforceWorkspaceRateLimit(
    supabaseAdmin,
    ws,
    "upload-lease-document",
    origin,
    60,
  );
  if (rateLimitResponse) return rateLimitResponse;

  // ── Compute iteration + version via Deno helpers ───────────────────
  const { data: existingDocsRaw } = await supabaseAdmin
    .from("lease_documents")
    .select("iteration_number, version_number, document_type")
    .eq("lease_id", body.leaseId);
  const existingDocs = (existingDocsRaw ?? []) as Array<{
    iteration_number: number;
    version_number: number;
    document_type: DocumentType;
  }>;

  const iteration = nextIterationNumber(existingDocs, body.documentType);
  const version = nextVersionNumber(existingDocs, iteration);

  // ── Insert metadata row (trigger flips is_current_latest) ──────────
  const insertPayload = {
    lease_id: body.leaseId,
    workspace_id: ws,
    document_type: body.documentType,
    iteration_number: iteration,
    version_number: version,
    storage_path: body.storagePath,
    filename: body.filename,
    mime_type: body.mimeType ?? null,
    file_size_bytes: body.fileSizeBytes ?? null,
    uploaded_by: user.id,
    notes: body.notes ?? null,
    // is_current_latest defaults to false; trigger promotes after insert.
  };

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("lease_documents")
    .insert(insertPayload)
    .select("id, iteration_number, version_number, is_current_latest")
    .single();

  if (insertError || !inserted) {
    console.error("[upload-lease-document] insert error:", insertError?.message);
    return jsonResponse(
      {
        ok: false,
        error: insertError?.message ?? "Failed to record document",
        reason: "insert_failed",
      },
      500,
      origin,
    );
  }

  // ── Activity log (best-effort; the document row is the truth) ──────
  const { error: logError } = await supabaseAdmin
    .from("lease_activity_log")
    .insert({
      lease_id: body.leaseId,
      user_id: user.id,
      activity_type: "document_iteration_uploaded",
      details: {
        document_id: (inserted as { id: string }).id,
        document_type: body.documentType,
        iteration_number: iteration,
        version_number: version,
        filename: body.filename,
      },
    });
  if (logError) {
    console.error("[upload-lease-document] activity log error:", logError.message);
  }

  return jsonResponse(
    {
      ok: true,
      document: inserted,
    },
    200,
    origin,
  );
});
