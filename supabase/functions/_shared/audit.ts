import { jsonrepair } from "npm:jsonrepair@3.13.1";

export { getCorsHeaders, jsonResponse } from "./cors.ts";

export async function repairJsonObject(content: string): Promise<object> {
  let jsonStr = content;

  if (content.includes("```json")) {
    const match = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (match) jsonStr = match[1];
  } else if (content.includes("```")) {
    const match = content.match(/```\s*([\s\S]*?)\s*```/);
    if (match) jsonStr = match[1];
  }

  const trimmed = jsonStr.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
  }

  jsonStr = jsonStr
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\n\s*\n/g, "\n");

  try {
    return JSON.parse(jsonStr.trim());
  } catch {
    return JSON.parse(jsonrepair(jsonStr.trim()));
  }
}

export async function analyzeWithAzureDI(
  pdfBytes: ArrayBuffer,
  {
    endpoint,
    apiKey,
    model = "prebuilt-layout",
    logPrefix,
    includePageDelimiters = false,
  }: {
    endpoint: string;
    apiKey: string;
    model?: string;
    logPrefix: string;
    includePageDelimiters?: boolean;
  },
): Promise<string> {
  const startedAt = Date.now();
  const analyzeUrl =
    `${endpoint}/documentintelligence/documentModels/${model}:analyze?api-version=2024-11-30&disableContentLogging=true`;

  console.log(`[${logPrefix}] Azure DI starting with model ${model}`);
  const analyzeResponse = await fetch(analyzeUrl, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Content-Type": "application/pdf",
    },
    body: new Blob([pdfBytes], { type: "application/pdf" }),
  });

  if (!analyzeResponse.ok) {
    const errorText = await analyzeResponse.text();
    throw new Error(
      `Azure DI analyze failed: ${analyzeResponse.status} - ${errorText}`,
    );
  }

  const operationLocation = analyzeResponse.headers.get("Operation-Location");
  if (!operationLocation) {
    throw new Error("Azure DI did not return Operation-Location header");
  }

  let result = null;
  let attempts = 0;
  const maxAttempts = 60;
  while (attempts < maxAttempts) {
    const delayMs = attempts < 20 ? 500 : 1000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const pollResponse = await fetch(operationLocation, {
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
    });
    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      throw new Error(
        `Azure DI poll failed: ${pollResponse.status} - ${errorText}`,
      );
    }

    const pollResult = await pollResponse.json();
    if (pollResult.status === "succeeded") {
      result = pollResult.analyzeResult;
      break;
    }
    if (pollResult.status === "failed") {
      throw new Error(
        `Azure DI analysis failed: ${JSON.stringify(pollResult.error)}`,
      );
    }

    attempts++;
  }

  if (!result) {
    throw new Error("Azure DI analysis timed out");
  }

  let extractedText = "";
  if (result.paragraphs) {
    let currentPage = 0;
    for (const paragraph of result.paragraphs) {
      if (includePageDelimiters) {
        const pageNum = paragraph.boundingRegions?.[0]?.pageNumber ?? currentPage;
        if (pageNum !== currentPage) {
          extractedText += `\n[PAGE ${pageNum}]\n`;
          currentPage = pageNum;
        }
      }
      extractedText += `${paragraph.content}\n\n`;
    }
  }
  if (result.tables) {
    for (const table of result.tables) {
      extractedText += "\n[TABLE]\n";
      const rows: Record<number, Record<number, string>> = {};
      for (const cell of table.cells) {
        if (!rows[cell.rowIndex]) rows[cell.rowIndex] = {};
        rows[cell.rowIndex][cell.columnIndex] = cell.content;
      }
      for (const rowIdx of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
        const row = rows[rowIdx];
        const cells = Object.keys(row)
          .map(Number)
          .sort((a, b) => a - b)
          .map((colIdx) => row[colIdx]);
        extractedText += `${cells.join(" | ")}\n`;
      }
      extractedText += "[/TABLE]\n\n";
    }
  }

  console.log(
    `[${logPrefix}] Azure DI completed in ${Date.now() - startedAt}ms with ${result.pages?.length || 0} page(s)`,
  );
  return extractedText;
}

function getHourWindowStart(now = new Date()): string {
  const windowStart = new Date(now);
  windowStart.setUTCMinutes(0, 0, 0);
  return windowStart.toISOString();
}

/**
 * Verify the user has granted AI processing consent in their profile.
 * The signup form makes this a contract; AccountSettings lets users
 * revoke it. Any edge function that sends customer lease data to a
 * third-party model MUST gate on this — P1-04.
 *
 * Returns a 403 jsonResponse when consent is missing/revoked; returns
 * null when the call may proceed. Throws on infra error (DB unreachable).
 */
export async function assertAiConsent(
  supabaseAdmin: any,
  userId: string,
  requestOrigin: string | null,
): Promise<Response | null> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("ai_processing_consent_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not verify AI processing consent: ${error.message}`);
  }
  if (!data?.ai_processing_consent_at) {
    return jsonResponse(
      {
        error:
          "AI processing consent has not been granted. Re-enable consent in Settings → Privacy before using AI features.",
        reason: "ai_consent_missing",
      },
      403,
      requestOrigin,
    );
  }
  return null;
}

/**
 * Tier gate for Business-only AI features (P1-04, P1-05). Pass the
 * workspace.plan value already fetched by the caller; this helper only
 * formats the 403 response and keeps callers consistent.
 */
export function assertBusinessPlan(
  plan: string | null | undefined,
  featureLabel: string,
  requestOrigin: string | null,
): Response | null {
  if (plan === "business") return null;
  return jsonResponse(
    {
      error: `${featureLabel} is available on the Business plan.`,
      reason: "tier_gate",
    },
    403,
    requestOrigin,
  );
}

export async function enforceWorkspaceRateLimit(
  supabaseAdmin: any,
  workspaceId: string | null,
  functionName: string,
  requestOrigin: string | null,
  limit = 20,
): Promise<Response | null> {
  if (!workspaceId) return null;

  const windowStart = getHourWindowStart();
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("processing_rate_limits")
    .select("id, request_count")
    .eq("workspace_id", workspaceId)
    .eq("function_name", functionName)
    .eq("window_start", windowStart)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Failed to check rate limit: ${existingError.message}`);
  }

  if (existing && existing.request_count >= limit) {
    return jsonResponse(
      {
        error:
          "Rate limit exceeded. Please wait before retrying this document processing request.",
      },
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
        window_start: windowStart,
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
