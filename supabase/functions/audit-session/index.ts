import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { encode as base64Encode } from "https://deno.land/std@0.190.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders, jsonResponse } from "../_shared/audit.ts";

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_AUDIT_DOCS = 5;
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && PDF_MAGIC.every((b, i) => b === bytes[i]);
}

function sanitizeFilename(name: string): string {
  const s = name
    .replace(/[\/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .trim();
  return s.slice(0, 255) || `lease_${Date.now()}.pdf`;
}

const SYSTEM_PROMPT =
  "You are a lease document analyzer for LeaseIO. Extract structured lease data from documents. Return ONLY valid JSON — no explanation, no markdown fences. If a field is absent from the document, return null.";

const EXTRACTION_PROMPT = `Extract the following fields from this lease document and return ONLY a valid JSON object:

{
  "landlord_name": "string or null",
  "tenant_name": "string or null",
  "property_address": "string or null",
  "asset_type": "real_estate or equipment or vehicle or other or null",
  "lease_start": "YYYY-MM-DD or null",
  "lease_end": "YYYY-MM-DD or null",
  "current_monthly_rent": number or null,
  "rent_escalation_type": "fixed or cpi or index or none or null",
  "escalation_rate": number or null,
  "security_deposit": "string or null",
  "renewal_options": "brief summary string or null",
  "termination_clauses": "brief summary string or null",
  "risks": [
    { "title": "string", "severity": "low|medium|high", "explanation": "1-2 sentences" }
  ]
}`;

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, origin);

  const supabaseUrl            = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicApiKey        = Deno.env.get("ANTHROPIC_API_KEY")!;

  if (!supabaseUrl || !supabaseServiceRoleKey || !anthropicApiKey) {
    return jsonResponse({ error: "Server configuration error" }, 500, origin);
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // --- Parse multipart form ---
  let email: string;
  let workspaceId: string | null;
  let fileBytes: Uint8Array;
  let filename: string;

  try {
    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return jsonResponse({ error: "Expected multipart/form-data" }, 400, origin);
    }
    const form = await req.formData();
    email       = ((form.get("email") as string) ?? "").trim().toLowerCase();
    workspaceId = (form.get("workspaceId") as string) || null;
    const file  = form.get("file") as File | null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ error: "A valid email is required" }, 400, origin);
    }
    if (!file) return jsonResponse({ error: "A PDF file is required" }, 400, origin);

    const buf = await file.arrayBuffer();
    fileBytes = new Uint8Array(buf);
    filename  = sanitizeFilename(file.name || "document.pdf");

    if (fileBytes.length > MAX_FILE_BYTES) {
      return jsonResponse({ error: "File too large (max 20 MB)" }, 400, origin);
    }
    if (!isPdf(fileBytes)) {
      return jsonResponse({ error: "Only PDF files are accepted" }, 400, origin);
    }
  } catch {
    return jsonResponse({ error: "Failed to parse request" }, 400, origin);
  }

  // --- Find or create user ---
  let userId: string;
  try {
    const { data: existingId } = await supabaseAdmin.rpc("get_audit_user_id", { p_email: email });
    if (existingId) {
      userId = existingId as string;
    } else {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { audit_user: true },
      });
      if (createErr || !created?.user) {
        console.error("[audit-session] createUser failed:", createErr?.message);
        return jsonResponse({ error: "Failed to create session. Please try again." }, 500, origin);
      }
      userId = created.user.id;
    }
  } catch (err) {
    console.error("[audit-session] user lookup error:", err);
    return jsonResponse({ error: "Failed to initialize session" }, 500, origin);
  }

  // --- Find or create audit workspace ---
  let resolvedWorkspaceId: string;
  try {
    if (workspaceId) {
      const { data: ws } = await supabaseAdmin
        .from("workspaces")
        .select("id")
        .eq("id", workspaceId)
        .eq("owner_id", userId)
        .eq("plan", "audit")
        .maybeSingle();
      if (!ws) return jsonResponse({ error: "Invalid session token" }, 400, origin);
      resolvedWorkspaceId = workspaceId;
    } else {
      const { data: existing } = await supabaseAdmin
        .from("workspaces")
        .select("id")
        .eq("owner_id", userId)
        .eq("plan", "audit")
        .maybeSingle();

      if (existing) {
        resolvedWorkspaceId = existing.id;
      } else {
        const { data: created, error: wsErr } = await supabaseAdmin
          .from("workspaces")
          .insert({ owner_id: userId, name: `Free Audit – ${email}`, plan: "audit", document_limit: MAX_AUDIT_DOCS })
          .select("id")
          .single();
        if (wsErr || !created) {
          console.error("[audit-session] workspace create failed:", wsErr?.message);
          return jsonResponse({ error: "Failed to create audit session" }, 500, origin);
        }
        resolvedWorkspaceId = created.id;
      }
    }
  } catch (err) {
    console.error("[audit-session] workspace error:", err);
    return jsonResponse({ error: "Failed to initialize audit workspace" }, 500, origin);
  }

  // --- Check document limit ---
  const { count: docCount } = await supabaseAdmin
    .from("leases")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", resolvedWorkspaceId)
    .neq("status", "Failed");

  if ((docCount ?? 0) >= MAX_AUDIT_DOCS) {
    return jsonResponse(
      {
        error: `The free audit is limited to ${MAX_AUDIT_DOCS} documents. Create an account to analyze your full portfolio.`,
        limitReached: true,
        workspaceId: resolvedWorkspaceId,
        slotsRemaining: 0,
      },
      429,
      origin,
    );
  }

  // --- Extract with Claude (native PDF beta) ---
  let extracted: Record<string, unknown>;
  try {
    const base64Pdf = base64Encode(fileBytes);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "pdfs-2024-09-25",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: base64Pdf },
              },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      console.error("[audit-session] Anthropic error:", errBody);
      return jsonResponse({ error: "AI extraction failed. Please try again." }, 500, origin);
    }

    const json = await anthropicRes.json();
    const rawText: string = json?.content?.[0]?.text ?? "";

    // Strip markdown fences, extract JSON object
    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    try {
      extracted = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) {
        console.error("[audit-session] Could not parse Claude response:", cleaned.slice(0, 200));
        return jsonResponse({ error: "Failed to parse extraction result" }, 500, origin);
      }
      extracted = JSON.parse(match[0]);
    }
  } catch (err) {
    console.error("[audit-session] Extraction error:", err);
    return jsonResponse({ error: "Document analysis failed. Please try again." }, 500, origin);
  }

  console.log(`[audit-session] Extracted lease data for ${email}: ${JSON.stringify(extracted).slice(0, 200)}`);

  // --- Upload file to storage ---
  const leaseId    = crypto.randomUUID();
  const storagePath = `${userId}/${leaseId}/${filename}`;
  await supabaseAdmin.storage
    .from("leases")
    .upload(storagePath, fileBytes, { contentType: "application/pdf", upsert: true });

  // --- Parse extracted fields ---
  const monthlyRent = typeof extracted.current_monthly_rent === "number"
    ? extracted.current_monthly_rent : null;
  const leaseStart  = typeof extracted.lease_start === "string" && extracted.lease_start ? extracted.lease_start : null;
  const leaseEnd    = typeof extracted.lease_end   === "string" && extracted.lease_end   ? extracted.lease_end   : null;
  const termMonths  = leaseStart && leaseEnd
    ? Math.max(1, Math.round(
        (new Date(leaseEnd).getTime() - new Date(leaseStart).getTime()) / (86400 * 30.4375 * 1000),
      ))
    : null;

  // --- Insert lease record ---
  const { error: insertErr } = await supabaseAdmin.from("leases").insert({
    id:                  leaseId,
    user_id:             userId,
    workspace_id:        resolvedWorkspaceId,
    filename,
    storage_path:        storagePath,
    status:              "Ready",
    lifecycle_status:    "active",
    intake_source:       "audit",
    landlord_name:       (extracted.landlord_name       as string | null) ?? null,
    tenant_name:         (extracted.tenant_name         as string | null) ?? null,
    property_address:    (extracted.property_address    as string | null) ?? null,
    asset_type:          (extracted.asset_type          as string | null) ?? null,
    lease_start:         leaseStart,
    lease_end:           leaseEnd,
    term_months:         termMonths,
    current_monthly_rent: monthlyRent,
    escalation_type:     (extracted.rent_escalation_type as string | null) ?? null,
    escalation_rate:     typeof extracted.escalation_rate === "number" ? extracted.escalation_rate : null,
    security_deposit:    (extracted.security_deposit    as string | null) ?? null,
    renewal_options:     (extracted.renewal_options     as string | null) ?? null,
    termination_clauses: (extracted.termination_clauses as string | null) ?? null,
    extracted_json:      extracted,
    processed_at:        new Date().toISOString(),
  });

  if (insertErr) {
    console.error("[audit-session] Lease insert failed:", insertErr.message);
    // Non-fatal — still return extracted data
  }

  // Insert risks
  const risks = Array.isArray(extracted.risks) ? extracted.risks as Array<Record<string, unknown>> : [];
  if (risks.length > 0) {
    await supabaseAdmin.from("risks").insert(
      risks.map((r) => ({
        lease_id:    leaseId,
        title:       r.title as string,
        severity:    r.severity as string,
        explanation: r.explanation as string,
      })),
    );
  }

  const slotsRemaining = Math.max(0, MAX_AUDIT_DOCS - ((docCount ?? 0) + 1));
  console.log(`[audit-session] Done. workspace=${resolvedWorkspaceId}, slotsRemaining=${slotsRemaining}`);

  return jsonResponse(
    {
      workspaceId:    resolvedWorkspaceId,
      slotsRemaining,
      lease: {
        id:                  leaseId,
        filename,
        landlord_name:       extracted.landlord_name       ?? null,
        tenant_name:         extracted.tenant_name         ?? null,
        property_address:    extracted.property_address    ?? null,
        asset_type:          extracted.asset_type          ?? null,
        lease_start:         leaseStart,
        lease_end:           leaseEnd,
        term_months:         termMonths,
        current_monthly_rent: monthlyRent,
        escalation_type:     extracted.rent_escalation_type ?? null,
        escalation_rate:     extracted.escalation_rate      ?? null,
        security_deposit:    extracted.security_deposit     ?? null,
        renewal_options:     extracted.renewal_options      ?? null,
        termination_clauses: extracted.termination_clauses  ?? null,
        risks,
      },
    },
    200,
    origin,
  );
});
