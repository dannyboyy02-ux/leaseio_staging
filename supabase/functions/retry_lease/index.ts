import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  analyzeWithAzureDI as runAzureDI,
  assertAiConsent,
  enforceWorkspaceRateLimit,
  repairJsonObject,
} from "../_shared/audit.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { resolveProcessingSubscriptionGate } from "../_shared/monetization.ts";
import {
  callerCanProcessLeases,
  READ_ONLY_ROLE_ERROR,
  READ_ONLY_ROLE_REASON,
} from "../_shared/role_gate.ts";

// Azure Document Intelligence (OCR layer)
const AZURE_DI_ENDPOINT = Deno.env.get('AZURE_DI_ENDPOINT');
const AZURE_DI_KEY = Deno.env.get('AZURE_DI_KEY');
const AZURE_DI_MODEL = Deno.env.get('AZURE_DI_MODEL') || 'prebuilt-layout';

// Anthropic (intelligence layer)
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

// Supabase
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RentPeriod {
  period_start: string | null;
  period_end: string | null;
  monthly_amount: number | null;
  annual_amount: number | null;
  notes: string | null;
}

interface LeaseExtractionResult {
  landlord_name: string | null;
  tenant_name: string | null;
  property_address: string | null;
  lease_start: string | null;
  lease_end: string | null;
  current_monthly_rent: number | null;
  rent_escalation_type: string | null;
  rent_schedule: RentPeriod[];
  rent_commencement_date: string | null;
  base_rent_amount: string | null;
  base_rent_frequency: string | null;
  security_deposit: string | null;
  renewal_options: string | null;
  escalation_clauses: string | null;
  termination_clauses: string | null;
  key_dates: { date: string; description: string }[];
  risks: { title: string; severity: 'low' | 'medium' | 'high'; explanation: string; citation_snippet?: string; citation_page?: number }[];
}

function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

// File-upload helpers (mirror process_lease) — used by the in-place
// re-upload path when a failed lease has no stored source file.
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const PDF_MAGIC_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

function isPdfFile(bytes: ArrayBuffer): boolean {
  // Require the FULL 4-byte magic. A shorter slice makes header.every()
  // vacuously true for a 0-byte file and accepts a partial "%PD" prefix
  // (Codex PR review) — guard the length and compare over the fixed magic.
  if (bytes.byteLength < PDF_MAGIC_BYTES.length) return false;
  const header = new Uint8Array(bytes.slice(0, PDF_MAGIC_BYTES.length));
  return PDF_MAGIC_BYTES.every((byte, index) => header[index] === byte);
}

function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/[\/\\]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .trim();
  if (!sanitized || sanitized.length > 255) {
    return `lease_${Date.now()}.pdf`;
  }
  return sanitized;
}

function safeDate(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes('_')) return null;
  const invalidTokens = ['tbd', 'n/a', 'unknown', 'pending', 'none', 'null', 'undefined'];
  if (invalidTokens.includes(trimmed.toLowerCase())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  try {
    const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
      const [, month, day, year] = slashMatch;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    const monthNames: Record<string, string> = {
      'january': '01', 'jan': '01', 'february': '02', 'feb': '02',
      'march': '03', 'mar': '03', 'april': '04', 'apr': '04',
      'may': '05', 'june': '06', 'jun': '06', 'july': '07', 'jul': '07',
      'august': '08', 'aug': '08', 'september': '09', 'sep': '09', 'sept': '09',
      'october': '10', 'oct': '10', 'november': '11', 'nov': '11',
      'december': '12', 'dec': '12',
    };
    const monthMatch = trimmed.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (monthMatch) {
      const [, monthStr, day, year] = monthMatch;
      const monthNum = monthNames[monthStr.toLowerCase()];
      if (monthNum) return `${year}-${monthNum}-${day.padStart(2, '0')}`;
    }
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      if (year >= 1900 && year <= 2100) {
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
  } catch (e) {
    console.log(`[safeDate] Parse error:`, e);
  }
  return null;
}

function extractValue(field: any): any {
  if (field && typeof field === 'object' && 'value' in field) return field.value;
  return field;
}

/**
 * Escalation Rate Normalization
 * Keep in sync with process_lease/index.ts.
 */
function normalizeEscalation(rentEscalationTypeRaw: string | null): {
  escalationType: string;
  escalationRate: number | null;
  needsEscalationReview: boolean;
} {
  if (rentEscalationTypeRaw) {
    const raw = rentEscalationTypeRaw.trim();
    const percentMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) {
      return { escalationType: 'percent', escalationRate: parseFloat(percentMatch[1]), needsEscalationReview: false };
    }
    const cpiPattern = /\b(cpi|index|consumer\s+price|inflation[- ]based)\b/i;
    if (cpiPattern.test(raw)) {
      return { escalationType: 'index', escalationRate: null, needsEscalationReview: true };
    }
  }
  return { escalationType: 'none', escalationRate: 0, needsEscalationReview: false };
}

async function analyzeWithAzureDI(pdfBytes: ArrayBuffer): Promise<string> {
  return await runAzureDI(pdfBytes, {
    endpoint: AZURE_DI_ENDPOINT!,
    apiKey: AZURE_DI_KEY!,
    model: AZURE_DI_MODEL,
    logPrefix: 'retry_lease',
    includePageDelimiters: true,
  });
}

// ================================================================
// ANTHROPIC TWO-PASS EXTRACTION (same as process_lease)
// ================================================================

interface PageMap {
  parties: number[];
  financials: number[];
  escalation: number[];
  renewal: number[];
  termination: number[];
  covenants: number[];
  key_dates: number[];
  total_pages: number;
}

async function callAnthropicAPI(
  model: string,
  system: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: userContent }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Anthropic] Request failed (attempt ${attempt + 1}): ${errorText}`);
        lastError = new Error(`Anthropic API error: ${response.status} - ${errorText}`);
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
        throw lastError;
      }

      const data = await response.json();
      const content = data.content?.[0]?.text;
      if (!content) {
        lastError = new Error('Anthropic response missing content');
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
        throw lastError;
      }

      console.log(`[Anthropic:${model}] tokens in=${data.usage?.input_tokens} out=${data.usage?.output_tokens}`);
      return content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    }
  }
  throw lastError || new Error('All Anthropic API attempts failed');
}

async function callHaikuForPageMap(documentText: string): Promise<PageMap> {
  console.log('[Haiku] Building page map...');
  const system = `You are a lease document classifier. Your only job is to identify which pages contain specific types of information. Do not extract values — only identify page locations.

Return a JSON object with these arrays of 1-indexed page numbers:
- "parties": pages with landlord name, tenant name, or property address
- "financials": pages with base rent amounts, monthly rent, security deposit
- "escalation": pages with rent escalation clauses, CPI language, step increases
- "renewal": pages with renewal or extension options
- "termination": pages with termination, break clauses, early exit provisions
- "covenants": pages with assignment restrictions, use restrictions, insurance requirements
- "key_dates": pages with material deadlines, option exercise dates
- "total_pages": total page count as a number

Return ONLY valid JSON. Empty array if a category has no relevant pages. Pages may appear in multiple categories.`;

  const content = await callAnthropicAPI(
    'claude-haiku-4-5-20251001',
    system,
    `Map this lease document:\n\n${documentText}`,
    1024,
  );

  try {
    const parsed = await repairJsonObject(content) as any;
    console.log('[Haiku] Page map:', JSON.stringify(parsed));
    return {
      parties:     Array.isArray(parsed.parties)     ? parsed.parties     : [],
      financials:  Array.isArray(parsed.financials)  ? parsed.financials  : [],
      escalation:  Array.isArray(parsed.escalation)  ? parsed.escalation  : [],
      renewal:     Array.isArray(parsed.renewal)      ? parsed.renewal     : [],
      termination: Array.isArray(parsed.termination) ? parsed.termination : [],
      covenants:   Array.isArray(parsed.covenants)   ? parsed.covenants   : [],
      key_dates:   Array.isArray(parsed.key_dates)   ? parsed.key_dates   : [],
      total_pages: typeof parsed.total_pages === 'number' ? parsed.total_pages : 0,
    };
  } catch (error) {
    console.error('[Haiku] Page map parse failed, using full-document fallback:', error);
    const pageNums = [...(documentText.matchAll(/\[PAGE (\d+)\]/g))].map(m => parseInt(m[1]));
    const totalPages = pageNums.length > 0 ? Math.max(...pageNums) : 1;
    const all = Array.from({ length: totalPages }, (_, i) => i + 1);
    return { parties: all, financials: all, escalation: all, renewal: all, termination: all, covenants: all, key_dates: all, total_pages: totalPages };
  }
}

function slicePagesByNumbers(documentText: string, pageNumbers: number[]): string {
  if (pageNumbers.length === 0) return documentText;
  const pageSet = new Set(pageNumbers);
  const segments = documentText.split(/(\[PAGE \d+\])/);
  let result = '';
  let inTarget = pageSet.has(1);
  for (const segment of segments) {
    const m = segment.match(/\[PAGE (\d+)\]/);
    if (m) {
      inTarget = pageSet.has(parseInt(m[1]));
      if (inTarget) result += segment;
    } else if (inTarget) {
      result += segment;
    }
  }
  return result.trim() || documentText;
}

function buildPageGroups(pageMap: PageMap): { groupA: number[]; groupB: number[]; groupC: number[] } {
  const totalPages = pageMap.total_pages || 999;
  const withBuffer = (pages: number[]) => {
    const s = new Set<number>();
    pages.forEach(p => { s.add(p - 1); s.add(p); s.add(p + 1); });
    return Array.from(s).filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  };
  return {
    groupA: withBuffer([...pageMap.parties, ...pageMap.financials, ...pageMap.key_dates]),
    groupB: withBuffer([...pageMap.escalation, ...pageMap.renewal, ...pageMap.termination]),
    groupC: withBuffer(pageMap.covenants),
  };
}

const CORE_SYSTEM = `You are an expert commercial lease abstraction specialist. Extract the following fields from the provided pages only.

TERM MAPPINGS:
- "Base Rent" / "Minimum Rent" / "Fixed Rent" / "Monthly Rent" → current_monthly_rent
- "Commencement Date" / "Effective Date" / "Start Date" → lease_start
- "Expiration Date" / "Termination Date" / "End Date" / "Term End" → lease_end
- "Landlord" / "Lessor" / "Owner" (interchangeable)
- "Tenant" / "Lessee" / "Renter" (interchangeable)
- "Premises" / "Demised Premises" / "Leased Premises" → property_address
- "Security Deposit" / "Damage Deposit" / "Good Faith Deposit"

RULES:
1. Extract ONLY what is explicitly stated. NEVER guess or infer.
2. If not found: value null, confidence 0.0
3. Dates in YYYY-MM-DD. Numbers without $ or commas.
4. If multiple rent periods exist, extract ALL in rent_schedule.
5. DO NOT confuse security deposit with first month's rent.
6. DO NOT use placeholder dates like TBD.

Return ONLY valid JSON:
{
  "landlord_name": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "tenant_name": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "property_address": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "lease_start": {"value": "YYYY-MM-DD|null","confidence":0.0,"page":1,"source_text":"quote"},
  "lease_end": {"value": "YYYY-MM-DD|null","confidence":0.0,"page":1,"source_text":"quote"},
  "current_monthly_rent": {"value": null,"confidence":0.0,"page":1,"source_text":"quote"},
  "rent_commencement_date": {"value": "YYYY-MM-DD|null","confidence":0.0,"page":1,"source_text":"quote"},
  "base_rent_amount": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "base_rent_frequency": {"value": "monthly|quarterly|annually|null","confidence":0.0,"page":1,"source_text":"quote"},
  "security_deposit": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "rent_schedule": [{"period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD|null","monthly_amount":null,"annual_amount":null,"notes":"string","confidence":0.0}],
  "key_dates": [{"date":"YYYY-MM-DD","description":"string","confidence":0.0}]
}`;

const CLAUSES_SYSTEM = `You are an expert commercial lease abstraction specialist. Extract clause information from the provided pages only.

TERM MAPPINGS:
- "CPI" / "Consumer Price Index" / "inflation-based" → index escalation
- "Fixed Increase" / "Step Rent" / "3% annual" → percent escalation
- "Option to Renew" / "Extension Option" → renewal_options
- "Early Termination" / "Break Clause" → termination_clauses

RULES:
1. Extract ONLY what is explicitly stated. If not found: value null, confidence 0.0.
2. Quote exact terms and notice periods.
3. DO NOT default CPI/index leases to a percent — describe them as index-based.

Return ONLY valid JSON:
{
  "rent_escalation_type": {"value": "e.g. '3% annual'|'CPI adjustment'|'None'|null","confidence":0.0,"page":1,"source_text":"quote"},
  "escalation_clauses": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "renewal_options": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "termination_clauses": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"}
}`;

const RISKS_SYSTEM = `You are an expert commercial lease risk analyst. Identify risks from the provided pages only.

Flag these issues:
- Rent escalations exceeding 5% annually (HIGH)
- Automatic renewal without advance notice requirement (MEDIUM-HIGH)
- Personal guarantee requirements (MEDIUM)
- Restrictions on assignment or subletting (MEDIUM)
- Unclear or missing termination provisions (MEDIUM)
- Landlord can terminate without cause (HIGH)
- Missing force majeure clauses (LOW-MEDIUM)
- Ambiguous rent calculation methodology (MEDIUM)

Return ONLY valid JSON:
{
  "risks": [{"title":"string","severity":"low|medium|high","explanation":"string","citation_snippet":"quote","citation_page":1,"confidence":0.0}]
}`;

async function extractLeaseDataWithClaude(documentText: string): Promise<LeaseExtractionResult> {
  console.log('[Claude] Starting two-pass extraction...');

  const pageMap = await callHaikuForPageMap(documentText);
  const { groupA, groupB, groupC } = buildPageGroups(pageMap);
  console.log(`[Claude] Groups — A:${groupA.length}pp B:${groupB.length}pp C:${groupC.length}pp`);

  const textA = slicePagesByNumbers(documentText, groupA);
  const textB = groupB.length > 0 ? slicePagesByNumbers(documentText, groupB) : documentText;
  const textC = groupC.length > 0 ? slicePagesByNumbers(documentText, groupC) : textB;

  const [rawA, rawB, rawC] = await Promise.all([
    callAnthropicAPI('claude-opus-4-6', CORE_SYSTEM,    `Extract core lease terms from these pages:\n\n${textA}`, 6144),
    callAnthropicAPI('claude-opus-4-6', CLAUSES_SYSTEM, `Extract clause information from these pages:\n\n${textB}`, 4096),
    callAnthropicAPI('claude-opus-4-6', RISKS_SYSTEM,   `Identify risks from these pages:\n\n${textC}`,            4096),
  ]);

  console.log('[Claude] All Opus calls complete, merging...');

  const [parsedA, parsedB, parsedC] = await Promise.all([
    repairJsonObject(rawA),
    repairJsonObject(rawB),
    repairJsonObject(rawC),
  ]);

  const merged = { ...(parsedA as any), ...(parsedB as any) } as any;
  const risksData = (parsedC as any).risks || [];

  const haikuWarnings: string[] = [];
  if (pageMap.financials.length > 0 && !extractValue(merged.current_monthly_rent)) {
    haikuWarnings.push(`Haiku mapped rent to pages [${pageMap.financials.join(',')}] but Opus found nothing — review required`);
  }
  if (pageMap.parties.length > 0 && !extractValue(merged.landlord_name)) {
    haikuWarnings.push(`Haiku mapped parties to pages [${pageMap.parties.join(',')}] but landlord not found`);
  }
  if (haikuWarnings.length > 0) {
    merged._haiku_warnings = haikuWarnings;
    console.log('[Claude] Haiku/Opus disagreements:', haikuWarnings);
  }

  merged._extraction_model = 'claude-opus-4-6';
  merged._haiku_page_map = pageMap;

  return {
    landlord_name:          merged.landlord_name          || null,
    tenant_name:            merged.tenant_name            || null,
    property_address:       merged.property_address       || null,
    lease_start:            merged.lease_start            || null,
    lease_end:              merged.lease_end              || null,
    current_monthly_rent:   merged.current_monthly_rent   || null,
    rent_escalation_type:   merged.rent_escalation_type   || null,
    rent_schedule:          merged.rent_schedule          || [],
    rent_commencement_date: merged.rent_commencement_date || null,
    base_rent_amount:       merged.base_rent_amount       || null,
    base_rent_frequency:    merged.base_rent_frequency    || null,
    security_deposit:       merged.security_deposit       || null,
    renewal_options:        merged.renewal_options        || null,
    escalation_clauses:     merged.escalation_clauses     || null,
    termination_clauses:    merged.termination_clauses    || null,
    key_dates:              merged.key_dates              || [],
    risks:                  risksData,
  };
}

serve(async (req) => {
  const requestOrigin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(requestOrigin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('[retry_lease] Request received');

    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[retry_lease] User authenticated: ${user.id}`);

    // Accept either JSON ({ leaseId }) — the existing retry-from-stored-file
    // path — or multipart/form-data ({ file, leaseId }) for in-place
    // re-upload when a failed lease has no stored source file (#C1). The file
    // (if any) is validated + stored below, after the permission checks.
    let leaseId: unknown;
    let uploadedFile: File | null = null;
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      let formData: FormData;
      try {
        formData = await req.formData();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid form data in request body' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const f = formData.get('file');
      uploadedFile = f instanceof File ? f : null;
      leaseId = formData.get('leaseId');
    } else {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!body || typeof body !== 'object') {
        return new Response(JSON.stringify({ error: 'Request body must be an object' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      leaseId = (body as { leaseId?: unknown }).leaseId;
    }

    if (!leaseId || typeof leaseId !== 'string') {
      return new Response(JSON.stringify({ error: 'leaseId must be a non-empty string' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!isValidUUID(leaseId)) {
      return new Response(JSON.stringify({ error: 'Invalid leaseId format. Must be a valid UUID.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch the existing lease
    const { data: lease, error: fetchError } = await supabaseAdmin
      .from('leases')
      .select('*')
      .eq('id', leaseId)
      .maybeSingle();

    if (fetchError || !lease) {
      return new Response(JSON.stringify({ error: 'Lease not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Permission check
    let canRetry = lease.user_id === user.id;
    if (!canRetry && lease.workspace_id) {
      const { data: roleData } = await supabaseAdmin
        .from('workspace_roles')
        .select('role')
        .eq('workspace_id', lease.workspace_id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (roleData && ['financial_approver', 'admin'].includes(roleData.role)) {
        canRetry = true;
      }

      if (!canRetry) {
        const { data: ownedWorkspace } = await supabaseAdmin
          .from('workspaces')
          .select('id')
          .eq('id', lease.workspace_id)
          .eq('owner_id', user.id)
          .maybeSingle();

        if (ownedWorkspace) canRetry = true;
      }
    }

    if (!canRetry) {
      return new Response(JSON.stringify({ error: 'Unauthorized to retry this lease.' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Wave 5 viewer gate: canRetry admits the lease's own creator — but if
    // that user's role has since been reduced to viewer, a retry would still
    // burn paid Opus from a "read-only" seat. Same shared gate as
    // process_lease so the two paid-AI entry points stay in lockstep
    // (mirrors the monetization pairing). Workspace-less personal leases
    // have no role to check and pass through.
    if (lease.workspace_id && !(await callerCanProcessLeases(supabaseAdmin, lease.workspace_id, user.id))) {
      return new Response(
        JSON.stringify({ error: READ_ONLY_ROLE_ERROR, reason: READ_ONLY_ROLE_REASON }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Integrity gate: retry / re-upload only operates on FAILED leases. The
    // reprocess below is destructive (clears risks + rent_schedules and
    // overwrites every extracted field), and the optional source-document
    // replacement swaps the stored PDF — neither must ever touch a confirmed
    // or locked lease. The UI only surfaces retry for failed leases; this
    // enforces it server-side (a permitted caller could otherwise POST against
    // any of their leases, including a confirmed one, via the API directly).
    if (lease.status !== 'Failed') {
      return new Response(
        JSON.stringify({ error: 'Only failed leases can be retried or re-uploaded.', reason: 'not_failed' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    if (lease.model_locked) {
      return new Response(
        JSON.stringify({ error: 'This lease is locked and cannot be reprocessed.', reason: 'model_locked' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Cancellation lifecycle (2026-06-12): a canceled workspace is
    // read-only — retries burn paid Opus tokens just like first-pass
    // extraction, so they get the same backstop process_lease has.
    if (lease.workspace_id) {
      const { data: wsLifecycle } = await supabaseAdmin
        .from('workspaces')
        .select('canceled_at, soft_deleted_at, plan, subscription_status, stripe_subscription_id, created_at, firm_id')
        .eq('id', lease.workspace_id)
        .maybeSingle();
      const wsLiveRow = wsLifecycle as {
        canceled_at?: string | null;
        soft_deleted_at?: string | null;
        plan?: string | null;
        subscription_status?: string | null;
        stripe_subscription_id?: string | null;
        created_at?: string | null;
        firm_id?: string | null;
      } | null;
      if (wsLiveRow?.canceled_at) {
        return new Response(
          JSON.stringify({
            error: 'This workspace\'s subscription has ended and it is in read-only mode. Renew the subscription to process documents again.',
            reason: 'subscription_canceled',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      // Vault V1 (2026-06-12): soft-deleted and vault-plan workspaces are
      // equally read-only — semantics mirror _shared/workspace_live.ts.
      if (wsLiveRow?.soft_deleted_at || wsLiveRow?.plan === 'vault') {
        return new Response(
          JSON.stringify({
            error: 'This workspace\'s subscription is inactive and it is in read-only mode. Renew the subscription to process documents again.',
            reason: 'subscription_inactive',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      // Starter monetization (Decision 1, 2026-07-16): a never-subscribed
      // workspace must start a subscription before ANY paid-AI processing. A
      // retry burns Opus tokens exactly like a first pass, so it gets the same
      // gate as process_lease — shared helper keeps the two in lockstep.
      // #201: firm-bound children inherit entitlement from the firm sub.
      const subGate = await resolveProcessingSubscriptionGate(supabaseAdmin, wsLiveRow);
      if (subGate.blocked) {
        return new Response(
          JSON.stringify({ error: subGate.error, reason: subGate.reason }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
    }

    // No stored file AND no replacement uploaded -> nothing to process.
    if (!lease.storage_path && !uploadedFile) {
      return new Response(JSON.stringify({ error: 'No file found for this lease. Upload a document to retry.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[retry_lease] Retrying lease: ${leaseId}`);

    // P1-04: AI consent gate — retry hits Claude same as initial extraction.
    const consentBlock = await assertAiConsent(supabaseAdmin, user.id, requestOrigin);
    if (consentBlock) return consentBlock;

    const rateLimitResponse = await enforceWorkspaceRateLimit(
      supabaseAdmin,
      lease.workspace_id,
      'retry_lease',
      requestOrigin,
    );
    if (rateLimitResponse) return rateLimitResponse;

    // #C1 — in-place re-upload: if the caller attached a replacement file,
    // store it server-side under the lease's canonical path and point the
    // lease at it, then fall through to the normal reprocess. Service-role
    // write keeps the privileged storage mutation off the client; mirrors
    // process_lease's storage convention (bucket 'leases', upsert).
    if (uploadedFile) {
      if (uploadedFile.size > MAX_FILE_SIZE) {
        return new Response(JSON.stringify({ error: 'File too large. Maximum size is 50MB.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const newFileBytes = await uploadedFile.arrayBuffer();
      if (!isPdfFile(newFileBytes)) {
        return new Response(JSON.stringify({ error: 'Invalid file type. Only PDF files are allowed.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const sanitizedFilename = sanitizeFilename(uploadedFile.name);
      const previousStoragePath = lease.storage_path ?? null;
      const newStoragePath = `${lease.user_id}/${leaseId}/${sanitizedFilename}`;
      const { error: reuploadError } = await supabaseAdmin.storage
        .from('leases')
        .upload(newStoragePath, newFileBytes, { contentType: 'application/pdf', upsert: true });
      if (reuploadError) {
        // Don't leak the raw storage/vendor error to the client.
        console.error(`[retry_lease] Storage upload failed for ${leaseId}: ${reuploadError.message}`);
        return new Response(JSON.stringify({ error: 'Failed to store the uploaded file.' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const { error: pathUpdateError } = await supabaseAdmin
        .from('leases')
        .update({ storage_path: newStoragePath, filename: sanitizedFilename })
        .eq('id', leaseId);
      if (pathUpdateError) {
        // The file is stored but the row didn't repoint — fail rather than
        // reprocess against an inconsistent record.
        console.error(`[retry_lease] storage_path update failed for ${leaseId}: ${pathUpdateError.message}`);
        return new Response(JSON.stringify({ error: 'Failed to record the uploaded file.' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Attribute the source-document replacement ("every change is
      // attributable"). Best-effort: a logging failure must not undo the
      // already-stored file, but it IS surfaced server-side.
      const { error: logError } = await supabaseAdmin.from('lease_activity_log').insert({
        lease_id: leaseId,
        workspace_id: lease.workspace_id ?? null,
        user_id: user.id,
        activity_type: 'source_document_replaced',
        details: {
          filename: sanitizedFilename,
          storage_path: newStoragePath,
          previous_storage_path: previousStoragePath,
          reason: 'retry_reupload_missing_source',
        },
      });
      if (logError) {
        console.error(`[retry_lease] activity-log insert failed for ${leaseId}: ${logError.message}`);
      }
      // Point the in-memory record at the new file so the existing download +
      // reprocess path below picks it up.
      lease.storage_path = newStoragePath;
      console.log(`[retry_lease] In-place re-upload stored at ${newStoragePath}`);
    }

    // Update status to Processing. Stamp processing_started_at so the
    // reclaim-stuck-extractions sweep measures "stuck" from when THIS retry
    // began, not from the original upload — otherwise a lease retried >30 min
    // after its first upload could be failed mid-retry by the next sweep.
    await supabaseAdmin
      .from('leases')
      .update({ status: 'Processing', error_message: null, processing_started_at: new Date().toISOString() })
      .eq('id', leaseId);

    // Clear derived artifacts before regenerating
    await supabaseAdmin.from('risks').delete().eq('lease_id', leaseId);
    await supabaseAdmin.from('rent_schedules').delete().eq('lease_id', leaseId);

    // Download file from storage
    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('leases')
      .download(lease.storage_path);

    if (downloadError || !fileData) {
      await supabaseAdmin.from('leases').update({
        status: 'Failed',
        error_message: 'Could not download file from storage'
      }).eq('id', leaseId);
      throw new Error('Failed to download file');
    }

    const fileBytes = await fileData.arrayBuffer();
    console.log(`[retry_lease] Downloaded file: ${fileBytes.byteLength} bytes`);

    // Guard the storage-download path: a 0-byte object downloads "successfully"
    // (downloadError null, fileData truthy) and would otherwise flow into the AI
    // call as an empty payload. Validate non-empty + PDF magic bytes here.
    if (fileBytes.byteLength === 0 || !isPdfFile(fileBytes)) {
      await supabaseAdmin.from('leases').update({
        status: 'Failed',
        error_message: 'Stored document is empty or not a valid PDF. Please re-upload the file.',
      }).eq('id', leaseId);
      throw new Error('Stored file is empty or not a valid PDF');
    }

    // OCR with Azure DI (with page delimiters for Haiku mapping)
    let extractedText: string;
    try {
      extractedText = await analyzeWithAzureDI(fileBytes);
      console.log(`[retry_lease] Extracted ${extractedText.length} characters`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabaseAdmin.from('leases').update({
        status: 'Failed',
        error_message: `Document analysis failed: ${errorMessage}`
      }).eq('id', leaseId);
      throw error;
    }

    // Two-pass Claude extraction
    let leaseData: LeaseExtractionResult;
    try {
      leaseData = await extractLeaseDataWithClaude(extractedText);
      console.log('[retry_lease] Claude extraction complete');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabaseAdmin.from('leases').update({
        status: 'Failed',
        error_message: `AI extraction failed: ${errorMessage}`
      }).eq('id', leaseId);
      throw error;
    }

    const { escalationType, escalationRate, needsEscalationReview } =
      normalizeEscalation(extractValue(leaseData.rent_escalation_type));
    console.log(`[retry_lease] Escalation normalized: type=${escalationType}, rate=${escalationRate}, review=${needsEscalationReview}`);

    const extractedStart = safeDate(extractValue(leaseData.lease_start));
    const extractedEnd   = safeDate(extractValue(leaseData.lease_end));
    const termMonths = extractedStart && extractedEnd
      ? Math.round((new Date(extractedEnd).getTime() - new Date(extractedStart).getTime()) / (1000 * 60 * 60 * 24 * 30.4375))
      : null;

    // Update lease record
    await supabaseAdmin
      .from('leases')
      .update({
        status: 'Ready',
        landlord_name:           extractValue(leaseData.landlord_name),
        tenant_name:             extractValue(leaseData.tenant_name),
        lease_start:             extractedStart,
        lease_end:               extractedEnd,
        term_months:             termMonths,
        base_rent_amount:        extractValue(leaseData.base_rent_amount),
        base_rent_frequency:     extractValue(leaseData.base_rent_frequency),
        current_monthly_rent:    extractValue(leaseData.current_monthly_rent),
        rent_escalation_type:    extractValue(leaseData.rent_escalation_type),
        escalation_type:         escalationType,
        escalation_rate:         escalationRate,
        needs_escalation_review: needsEscalationReview,
        extracted_json:          leaseData,
        processed_at:            new Date().toISOString(),
        error_message:           null,
      })
      .eq('id', leaseId);

    // Post-extraction financial recalculation
    if (extractedStart && termMonths && termMonths > 0) {
      const rawRent = extractValue(leaseData.current_monthly_rent);
      const monthlyRent = typeof rawRent === 'number' ? rawRent
        : typeof rawRent === 'string' ? parseFloat(rawRent.replace(/[^0-9.]/g, '')) || 0 : 0;
      if (monthlyRent > 0) {
        const { data: wsData } = await supabaseAdmin
          .from('workspaces').select('discount_rate').eq('id', lease.workspace_id).single();
        const discountRate: number = (wsData as any)?.discount_rate ?? 5.5;
        const annualEscRate: number = escalationRate ?? 0;
        const monthlyDiscountRate = Math.pow(1 + discountRate / 100, 1 / 12) - 1;
        const payments: number[] = [];
        for (let m = 1; m <= termMonths; m++) {
          const yearIndex = Math.floor((m - 1) / 12);
          payments.push(monthlyRent * Math.pow(1 + annualEscRate / 100, yearIndex));
        }
        const calcTotalCommitment = payments.reduce((s, p) => s + p, 0);
        const calcPvLiability = payments.reduce((s, p, idx) => s + p / Math.pow(1 + monthlyDiscountRate, idx + 1), 0);
        const calcStraightLineExp = calcTotalCommitment / termMonths;
        const midpoint = Math.max(1, Math.floor(termMonths / 2));
        const calcCashPlDelta = payments.slice(0, midpoint).reduce((s, p) => s + p, 0) - calcStraightLineExp * midpoint;
        await supabaseAdmin.from('leases').update({
          calc_total_commitment:  Math.round(calcTotalCommitment * 100) / 100,
          calc_pv_liability:      Math.round(calcPvLiability * 100) / 100,
          calc_straight_line_exp: Math.round(calcStraightLineExp * 100) / 100,
          calc_cash_pl_delta:     Math.round(calcCashPlDelta * 100) / 100,
        }).eq('id', leaseId);
        console.log(`[retry_lease] Financials recalculated: commitment=${Math.round(calcTotalCommitment)}`);
      }
    }

    // Insert rent schedule entries
    if (leaseData.rent_schedule && leaseData.rent_schedule.length > 0) {
      const rentScheduleToInsert = leaseData.rent_schedule
        .filter(period => period.period_start)
        .map(period => ({
          lease_id:     leaseId,
          period_start: safeDate(period.period_start),
          period_end:   safeDate(period.period_end),
          monthly_amount: period.monthly_amount,
          annual_amount:  period.annual_amount,
          notes:          period.notes,
        }));

      if (rentScheduleToInsert.length > 0) {
        await supabaseAdmin.from('rent_schedules').insert(rentScheduleToInsert);
        console.log(`[retry_lease] Inserted ${rentScheduleToInsert.length} rent schedule entries`);
      }
    }

    // Insert risks
    if (leaseData.risks && leaseData.risks.length > 0) {
      const risksToInsert = leaseData.risks.map(risk => ({
        lease_id:         leaseId,
        title:            risk.title,
        severity:         risk.severity,
        explanation:      risk.explanation,
        citation_snippet: risk.citation_snippet || null,
        citation_page:    risk.citation_page || null,
      }));

      await supabaseAdmin.from('risks').insert(risksToInsert);
      console.log(`[retry_lease] Inserted ${risksToInsert.length} risks`);
    }

    console.log('[retry_lease] Retry complete');

    return new Response(JSON.stringify({
      success: true,
      leaseId,
      data: leaseData
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Retry failed';
    console.error('[retry_lease] Error:', error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
