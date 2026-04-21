import { jsonrepair } from "npm:jsonrepair@3.13.1";

const ALLOWED_ORIGINS = [
  "https://theleaseio.com",
  "https://www.theleaseio.com",
  "https://app.theleaseio.com",
  "https://theleaseio.lovable.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];

function getAllowedOrigin(requestOrigin: string | null): string {
  const isLovablePreview =
    requestOrigin &&
    (requestOrigin.includes("lovableproject.com") ||
      requestOrigin.includes("lovable.app"));
  const isProductionDomain =
    requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin);
  return isProductionDomain || isLovablePreview
    ? requestOrigin!
    : ALLOWED_ORIGINS[0];
}

export function getCorsHeaders(
  requestOrigin: string | null,
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": getAllowedOrigin(requestOrigin),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(
  payload: unknown,
  status: number,
  requestOrigin: string | null,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...getCorsHeaders(requestOrigin),
      "Content-Type": "application/json",
    },
  });
}

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
    `${endpoint}/documentintelligence/documentModels/${model}:analyze?api-version=2024-11-30`;

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
