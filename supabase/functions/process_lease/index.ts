import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

// Secure CORS configuration
const ALLOWED_ORIGINS = [
  'https://theleaseio.com',
  'https://www.theleaseio.com',
  'https://app.theleaseio.com',
  'https://theleaseio.lovable.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const isLovablePreview = requestOrigin && (
    requestOrigin.includes('lovableproject.com') ||
    requestOrigin.includes('lovable.app')
  );
  const isProductionDomain = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin);
  const isAllowed = isProductionDomain || isLovablePreview;
  
  const origin = isAllowed ? requestOrigin : ALLOWED_ORIGINS[0];
    
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

// Default CORS headers for backwards compatibility
const corsHeaders = getCorsHeaders(null);

// Azure Document Intelligence
const AZURE_DI_ENDPOINT = Deno.env.get('AZURE_DI_ENDPOINT');
const AZURE_DI_KEY = Deno.env.get('AZURE_DI_KEY');

// OpenAI
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') || 'gpt-4o';

// Supabase
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Constants for validation
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const ALLOWED_LEASE_TYPES = ['master', 'amendment'] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PDF magic bytes: %PDF (0x25 0x50 0x44 0x46)
const PDF_MAGIC_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

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
  square_footage: number | null;
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

function isPdfFile(bytes: ArrayBuffer): boolean {
  const header = new Uint8Array(bytes.slice(0, 4));
  return header.every((byte, index) => byte === PDF_MAGIC_BYTES[index]);
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
  if (!trimmed) return null;
  if (trimmed.includes('_')) {
    console.log(`[safeDate] Rejecting placeholder date: ${trimmed}`);
    return null;
  }
  const invalidTokens = ['tbd', 'n/a', 'unknown', 'pending', 'none', 'null', 'undefined'];
  if (invalidTokens.includes(trimmed.toLowerCase())) {
    console.log(`[safeDate] Rejecting non-date token: ${trimmed}`);
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  try {
    const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
      const [, month, day, year] = slashMatch;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    const monthNames: Record<string, string> = {
      'january': '01', 'jan': '01', 'february': '02', 'feb': '02',
      'march': '03', 'mar': '03', 'april': '04', 'apr': '04', 'may': '05',
      'june': '06', 'jun': '06', 'july': '07', 'jul': '07',
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
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      if (year >= 1900 && year <= 2100) return `${year}-${month}-${day}`;
    }
  } catch (e) {
    console.log(`[safeDate] Parse error for: ${trimmed}`, e);
  }
  console.log(`[safeDate] Could not parse, returning null: ${trimmed}`);
  return null;
}

function extractValue(field: any): any {
  if (field && typeof field === 'object' && 'value' in field) return field.value;
  return field;
}

function extractConfidence(field: any): number | null {
  if (field && typeof field === 'object' && 'confidence' in field) return field.confidence;
  return null;
}

function validateMonthlyRent(value: number | null): { valid: boolean; issue?: string; suggestion?: string } {
  if (value === null) return { valid: true };
  if (value < 0) return { valid: false, issue: 'Negative rent', suggestion: 'Check if credit/refund instead' };
  if (value < 100) return { valid: false, issue: `Low rent ($${value})`, suggestion: 'Verify monthly not daily/hourly' };
  if (value > 500000) return { valid: false, issue: `High rent ($${value.toLocaleString()})`, suggestion: 'Check if annual not monthly or $/sqft' };
  return { valid: true };
}

function validateDate(dateStr: string | null): { valid: boolean; issue?: string } {
  if (!dateStr) return { valid: true };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { valid: false, issue: 'Invalid format' };
  const year = new Date(dateStr).getFullYear();
  if (year < 1950 || year > 2100) return { valid: false, issue: `Year ${year} out of range` };
  return { valid: true };
}

function validateSquareFootage(value: number | null): { valid: boolean; issue?: string } {
  if (value === null) return { valid: true };
  if (value < 0) return { valid: false, issue: 'Negative sqft' };
  if (value < 100) return { valid: false, issue: 'Too small (< 100)' };
  if (value > 10000000) return { valid: false, issue: 'Too large (> 10M)' };
  return { valid: true };
}

function validateAddress(address: string | null): { valid: boolean; issue?: string } {
  if (!address) return { valid: true };
  const hasCity = /,\s*[A-Z][a-z]+/.test(address);
  const hasState = /\b[A-Z]{2}\b/.test(address);
  const hasZip = /\b\d{5}(-\d{4})?\b/.test(address);
  if (!hasCity && !hasState && !hasZip) return { valid: false, issue: 'Incomplete address - missing city/state/ZIP' };
  return { valid: true };
}

function validateLeaseData(data: any): { warnings: string[]; suggestions: string[] } {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const rentCheck = validateMonthlyRent(extractValue(data.current_monthly_rent));
  if (!rentCheck.valid) { warnings.push(rentCheck.issue || 'Rent validation failed'); if (rentCheck.suggestion) suggestions.push(rentCheck.suggestion); }
  const addressCheck = validateAddress(extractValue(data.property_address));
  if (!addressCheck.valid) warnings.push(addressCheck.issue || 'Address incomplete');
  const startCheck = validateDate(extractValue(data.lease_start));
  if (!startCheck.valid) warnings.push(`Start: ${startCheck.issue}`);
  const endCheck = validateDate(extractValue(data.lease_end));
  if (!endCheck.valid) warnings.push(`End: ${endCheck.issue}`);
  const leaseStart = extractValue(data.lease_start);
  const leaseEnd = extractValue(data.lease_end);
  if (leaseStart && leaseEnd && new Date(leaseEnd) <= new Date(leaseStart)) warnings.push('End must be after start');
  const sqftCheck = validateSquareFootage(extractValue(data.square_footage));
  if (!sqftCheck.valid) warnings.push(`Sqft: ${sqftCheck.issue}`);
  if (!extractValue(data.landlord_name)) warnings.push('Missing landlord');
  if (!extractValue(data.tenant_name)) warnings.push('Missing tenant');
  return { warnings, suggestions };
}

/**
 * Step 1 — Escalation Rate Normalization
 *
 * Parsing boundary: rent_escalation_type is parsed ONLY here, inside process_lease.
 * All downstream code (analytics, dashboard, reports) must use escalation_rate
 * and escalation_type exclusively. Never parse rent_escalation_type elsewhere.
 *
 * ASC 842 hard rule: CPI/index leases must NEVER be silently defaulted to 0.
 * escalationRate is returned as null for index leases to make the gap explicit.
 */
function normalizeEscalation(rentEscalationTypeRaw: string | null): {
  escalationType: string;
  escalationRate: number | null;
  needsEscalationReview: boolean;
} {
  if (rentEscalationTypeRaw) {
    const raw = rentEscalationTypeRaw.trim();

    // Extract numeric percent (e.g. "3% annual", "2.5%", "fixed 3%")
    const percentMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) {
      return {
        escalationType: 'percent',
        escalationRate: parseFloat(percentMatch[1]),
        needsEscalationReview: false,
      };
    }

    // Detect CPI / index-based escalation
    // ASC 842: these must not be defaulted to 0 — flag for manual review
    const cpiPattern = /\b(cpi|index|consumer\s+price|inflation[- ]based)\b/i;
    if (cpiPattern.test(raw)) {
      return {
        escalationType: 'index',
        escalationRate: null, // explicitly null — never silently 0
        needsEscalationReview: true,
      };
    }
  }

  // No escalation information found
  return {
    escalationType: 'none',
    escalationRate: 0,
    needsEscalationReview: false,
  };
}

async function analyzeWithAzureDI(pdfBytes: ArrayBuffer): Promise<string> {
  console.log('[Azure DI] Starting document analysis...');
  const analyzeUrl = `${AZURE_DI_ENDPOINT}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30`;
  const analyzeResponse = await fetch(analyzeUrl, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': AZURE_DI_KEY!, 'Content-Type': 'application/pdf' },
    body: new Blob([pdfBytes], { type: 'application/pdf' }),
  });
  if (!analyzeResponse.ok) {
    const errorText = await analyzeResponse.text();
    throw new Error(`Azure DI analyze failed: ${analyzeResponse.status} - ${errorText}`);
  }
  const operationLocation = analyzeResponse.headers.get('Operation-Location');
  if (!operationLocation) throw new Error('Azure DI did not return Operation-Location header');
  console.log('[Azure DI] Polling for results...');
  let result = null;
  let attempts = 0;
  const maxAttempts = 60;
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const pollResponse = await fetch(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': AZURE_DI_KEY! },
    });
    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      throw new Error(`Azure DI poll failed: ${pollResponse.status}`);
    }
    const pollResult = await pollResponse.json();
    if (pollResult.status === 'succeeded') { result = pollResult.analyzeResult; break; }
    else if (pollResult.status === 'failed') throw new Error(`Azure DI analysis failed: ${JSON.stringify(pollResult.error)}`);
    attempts++;
  }
  if (!result) throw new Error('Azure DI analysis timed out');
  console.log(`[Azure DI] Extracted ${result.pages?.length || 0} pages`);
  let extractedText = '';
  if (result.paragraphs) {
    for (const paragraph of result.paragraphs) extractedText += paragraph.content + '\n\n';
  }
  if (result.tables) {
    for (const table of result.tables) {
      extractedText += '\n[TABLE]\n';
      const rows: Record<number, Record<number, string>> = {};
      for (const cell of table.cells) {
        if (!rows[cell.rowIndex]) rows[cell.rowIndex] = {};
        rows[cell.rowIndex][cell.columnIndex] = cell.content;
      }
      for (const rowIdx of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
        const row = rows[rowIdx];
        const cells = Object.keys(row).map(Number).sort((a, b) => a - b).map(colIdx => row[colIdx]);
        extractedText += cells.join(' | ') + '\n';
      }
      extractedText += '[/TABLE]\n\n';
    }
  }
  return extractedText;
}

async function extractLeaseDataWithOpenAI(documentText: string): Promise<LeaseExtractionResult> {
  console.log('[OpenAI] Extracting lease data...');
  const systemPrompt = `You are an expert commercial lease abstraction specialist with 20+ years of experience analyzing real estate and equipment leases. Your task is to extract key information with the highest possible accuracy.

DOMAIN KNOWLEDGE - CRITICAL LEASE TERMINOLOGY:

Common term mappings you MUST recognize:

- "Base Rent" / "Minimum Rent" / "Fixed Rent" / "Monthly Rent" → monthly_rent

- "Commencement Date" / "Effective Date" / "Start Date" → lease_start  

- "Expiration Date" / "Termination Date" / "End Date" / "Term End" → lease_end

- "Landlord" / "Lessor" / "Owner" (interchangeable)

- "Tenant" / "Lessee" / "Renter" (interchangeable)

- "Premises" / "Demised Premises" / "Leased Premises" → property_address

- "NRA" / "Rentable Square Feet" / "RSF" / "Usable Square Feet" → square_footage

- "CAM" / "Common Area Maintenance" / "Operating Expenses" / "Additional Rent"

- "Security Deposit" / "Damage Deposit" / "Good Faith Deposit"

- "Triple Net" / "NNN" → tenant pays taxes, insurance, maintenance separately

- "Gross Lease" → all-inclusive rent

- "CPI" / "Consumer Price Index" → inflation-based rent increases

EXTRACTION RULES - FOLLOW EXACTLY:

1. Extract ONLY information explicitly stated in the document

2. NEVER guess, infer, or make assumptions

3. If information is not found, set value to null and confidence to 0.0

4. For ambiguous data, set lower confidence score

5. Dates MUST be in YYYY-MM-DD format

6. Numbers should be extracted WITHOUT currency symbols or commas

7. If multiple values exist (e.g., escalating rent), extract ALL periods

Return data as JSON with this EXACT structure:

{

  "landlord_name": {

    "value": "Exact legal entity name as written",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote from document (max 100 chars)"

  },

  "tenant_name": {

    "value": "Exact legal entity name as written",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "property_address": {

    "value": "Full address including city, state, zip",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "lease_start": {

    "value": "YYYY-MM-DD or null",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "lease_end": {

    "value": "YYYY-MM-DD or null",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "square_footage": {

    "value": numeric_value_only,

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "current_monthly_rent": {

    "value": numeric_amount_only,

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "rent_escalation_type": {

    "value": "Description of how rent increases (e.g., '3% annual', 'CPI adjustment', 'Fixed schedule', 'None')",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "rent_commencement_date": {

    "value": "YYYY-MM-DD or null",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "rent_schedule": [

    {

      "period_start": "YYYY-MM-DD",

      "period_end": "YYYY-MM-DD or null if ongoing",

      "monthly_amount": numeric_value,

      "annual_amount": numeric_value,

      "notes": "e.g., 'Year 1', 'After CPI adjustment'",

      "confidence": 0.0-1.0

    }

  ],

  "base_rent_amount": {

    "value": "Initial base rent as string for legacy compatibility",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "base_rent_frequency": {

    "value": "monthly, quarterly, or annually",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "security_deposit": {

    "value": "Amount as string",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "renewal_options": {

    "value": "Summary of renewal terms",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "escalation_clauses": {

    "value": "Detailed description of rent escalation methodology",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "termination_clauses": {

    "value": "Summary of termination provisions",

    "confidence": 0.0-1.0,

    "page": page_number,

    "source_text": "verbatim quote"

  },

  "key_dates": [

    {

      "date": "YYYY-MM-DD",

      "description": "Description of date significance",

      "confidence": 0.0-1.0

    }

  ],

  "risks": [

    {

      "title": "Brief risk title",

      "severity": "low, medium, or high",

      "explanation": "Detailed explanation of risk",

      "citation_snippet": "Relevant quote from document",

      "citation_page": page_number,

      "confidence": 0.0-1.0

    }

  ]

}

CONFIDENCE SCORING GUIDELINES:

- 0.95-1.0: Information clearly stated, no ambiguity

- 0.85-0.94: Information found but slightly ambiguous format

- 0.70-0.84: Information inferred from context, not explicitly stated

- 0.50-0.69: Multiple possible interpretations, best guess selected

- 0.00-0.49: Very uncertain or not found

RISK IDENTIFICATION - Flag these issues:

- Rent escalations exceeding 5% annually (HIGH severity)

- Automatic renewal without advance notice requirements (MEDIUM-HIGH)

- Personal guarantee requirements (MEDIUM)

- Restrictions on assignment/subletting (MEDIUM)

- Unclear or missing termination provisions (MEDIUM)

- Landlord can terminate without cause (HIGH)

- Missing force majeure clauses (LOW-MEDIUM)

- Ambiguous rent calculation methodology (MEDIUM)

COMMON EXTRACTION ERRORS TO AVOID:

- DO NOT confuse "security deposit" with "first month's rent"

- DO NOT extract partial addresses (need full address with city/state/zip)

- DO NOT use placeholder dates like "TBD" or "____-__-__"

- DO NOT extract dollar signs or commas in numeric amounts

- DO NOT assume lease end date = start date + term (extract actual end date)

- DO NOT confuse "rentable" vs "usable" square footage (prefer rentable/RSF)

- DO NOT miss rent escalations buried in addendums or exhibits

- DO NOT overlook percentage rent clauses in retail leases

Return ONLY valid JSON. No markdown formatting, no explanation, no preamble.`;

  function extractJsonFromResponse(content: string): object {
    let jsonStr = content;
    if (content.includes('```json')) {
      const match = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (match) jsonStr = match[1];
    } else if (content.includes('```')) {
      const match = content.match(/```\s*([\s\S]*?)\s*```/);
      if (match) jsonStr = match[1];
    }
    const trimmed = jsonStr.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
    }
    jsonStr = jsonStr
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/[\x00-\x1F\x7F]/g, ' ')
      .replace(/\n\s*\n/g, '\n');
    try {
      return JSON.parse(jsonStr.trim());
    } catch (e) {
      console.log('[OpenAI] First parse attempt failed, trying cleanup...');
      const fixedJson = jsonStr
        .replace(/(\w+)\s*:/g, '"$1":')
        .replace(/:\s*'([^']*)'/g, ':"$1"')
        .replace(/""/g, '"');
      try {
        return JSON.parse(fixedJson.trim());
      } catch (e2) {
        console.error('[OpenAI] JSON cleanup failed:', e2);
        console.error('[OpenAI] Failed content preview:', jsonStr.substring(0, 500));
        throw e;
      }
    }
  }

  const maxRetries = 2;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Please analyze this lease document and extract the key information:\n\n${documentText}` }
          ],
          temperature: attempt === 0 ? 0.1 : 0.0,
          max_tokens: 4000,
          response_format: { type: "json_object" },
        }),
      });
      const contentType = response.headers.get('content-type');
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[OpenAI] Request failed (attempt ${attempt + 1}):`, errorText);
        if (errorText.trim().startsWith('<!') || errorText.includes('<html')) {
          lastError = new Error(`OpenAI returned HTML error page (status ${response.status})`);
          if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
          throw lastError;
        }
        throw new Error(`OpenAI request failed: ${response.status} - ${errorText}`);
      }
      if (!contentType?.includes('application/json')) {
        const textResponse = await response.text();
        lastError = new Error(`OpenAI returned non-JSON response: ${contentType}`);
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
        throw lastError;
      }
      const data = await response.json();
      if (!data.choices?.[0]?.message?.content) {
        lastError = new Error('OpenAI response missing content');
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
        throw lastError;
      }
      const content = data.choices[0].message.content;
      console.log('[OpenAI] Raw response:', content.substring(0, 500));
      console.log(`[OpenAI] Tokens - prompt: ${data.usage?.prompt_tokens || 'N/A'}, completion: ${data.usage?.completion_tokens || 'N/A'}`);
      try {
        const parsed = extractJsonFromResponse(content);
        console.log('[OpenAI] Successfully parsed JSON response');
        return parsed as LeaseExtractionResult;
      } catch (parseError) {
        lastError = new Error(`Failed to parse OpenAI response as JSON: ${parseError}`);
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
        throw lastError;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    }
  }
  throw lastError || new Error('All OpenAI extraction attempts failed');
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('[process_lease] Request received');

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
      console.error('[process_lease] Auth error:', authError);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    console.log(`[process_lease] User authenticated: ${user.id}`);

    const formData = await req.formData();
    const file = formData.get('file') as File;
    const leaseType = formData.get('leaseType') as string || 'master';
    const parentLeaseId = formData.get('parentLeaseId') as string | null;
    const extractionMode = (formData.get('extractionMode') as string) || 'pipeline';
    const targetLeaseId = formData.get('leaseId') as string | null;
    const workspaceIdFromRequest = formData.get('workspaceId') as string | null;

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: 'File too large. Maximum size is 50MB.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const fileBytes = await file.arrayBuffer();

    if (!isPdfFile(fileBytes)) {
      return new Response(JSON.stringify({ error: 'Invalid file type. Only PDF files are allowed.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sanitizedFilename = sanitizeFilename(file.name);
    console.log(`[process_lease] Processing file: ${sanitizedFilename}, size: ${file.size}, mode: ${extractionMode}`);

    // ================================================================
    // PHASE 4 — EXECUTED MODE
    // ================================================================
    if (extractionMode === 'executed') {
      if (!targetLeaseId || !isValidUUID(targetLeaseId)) {
        return new Response(JSON.stringify({ error: 'leaseId is required for executed mode and must be a valid UUID.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const { data: existingLease, error: fetchError } = await supabaseAdmin
        .from('leases')
        .select('id, user_id, workspace_id, lifecycle_status, current_monthly_rent, monthly_payment, lease_start, lease_end, tenant_name, landlord_name, model_locked')
        .eq('id', targetLeaseId)
        .single();

      if (fetchError || !existingLease) {
        return new Response(JSON.stringify({ error: 'Lease not found.' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (existingLease.user_id !== user.id) {
        if (existingLease.workspace_id) {
          const { data: roleData } = await supabaseAdmin
            .from('workspace_roles')
            .select('role')
            .eq('workspace_id', existingLease.workspace_id)
            .eq('user_id', user.id)
            .single();
          if (!roleData || !['financial_approver', 'admin', 'editor'].includes(roleData.role)) {
            return new Response(JSON.stringify({ error: 'Unauthorized to upload executed document for this lease.' }), {
              status: 403,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        } else {
          return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (existingLease.model_locked) {
        return new Response(JSON.stringify({ error: 'Cannot upload executed document on a locked lease record.' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const timestamp = Date.now();
      const bucketPrefix = existingLease.workspace_id
        ? `${existingLease.workspace_id}/${targetLeaseId}/executed`
        : `${user.id}/${targetLeaseId}/executed`;
      const executedStoragePath = `${bucketPrefix}/${timestamp}-${sanitizedFilename}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from('executed-leases')
        .upload(executedStoragePath, fileBytes, { contentType: 'application/pdf', upsert: true });

      if (uploadError) throw new Error(`Failed to upload executed document: ${uploadError.message}`);
      console.log('[process_lease] Executed document uploaded to storage');

      await supabaseAdmin.from('lease_activity_log').insert({
        lease_id: targetLeaseId,
        user_id: user.id,
        activity_type: 'executed_uploaded',
        details: { filename: sanitizedFilename, storage_path: executedStoragePath },
      });

      let executedText: string;
      try {
        executedText = await analyzeWithAzureDI(fileBytes);
        console.log(`[process_lease] Executed: extracted ${executedText.length} characters`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Executed document analysis failed: ${msg}`);
      }

      let leaseData: LeaseExtractionResult;
      try {
        leaseData = await extractLeaseDataWithOpenAI(executedText);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Executed AI extraction failed: ${msg}`);
      }

      const execMonthlyPayment   = extractValue(leaseData.current_monthly_rent) as number | null;
      const execCommencementDate = safeDate(extractValue(leaseData.lease_start));
      const execExpiryDate       = safeDate(extractValue(leaseData.lease_end));
      const execTenantName       = extractValue(leaseData.tenant_name) as string | null;
      const execLandlordName     = extractValue(leaseData.landlord_name) as string | null;
      const execRentReviewClause = extractValue(leaseData.escalation_clauses) as string | null;
      const execBreakClause      = extractValue(leaseData.termination_clauses) as string | null;

      const execFieldMap: [string, any][] = [
        ['monthly_payment',    leaseData.current_monthly_rent],
        ['commencement_date',  leaseData.lease_start],
        ['expiry_date',        leaseData.lease_end],
        ['tenant_name',        leaseData.tenant_name],
        ['landlord_name',      leaseData.landlord_name],
        ['rent_review_clause', leaseData.escalation_clauses],
        ['break_clause',       leaseData.termination_clauses],
      ];
      const executedConfidence: Record<string, number> = {};
      for (const [key, field] of execFieldMap) {
        const conf = extractConfidence(field);
        if (conf !== null) executedConfidence[key] = conf;
      }

      const pipelineMonthly = (existingLease.current_monthly_rent ?? existingLease.monthly_payment ?? null) as number | null;
      const varianceMonthly = execMonthlyPayment !== null && pipelineMonthly !== null
        ? execMonthlyPayment - pipelineMonthly : null;
      const varianceCommencementDays = execCommencementDate && existingLease.lease_start
        ? Math.round((new Date(execCommencementDate).getTime() - new Date(existingLease.lease_start as string).getTime()) / 86400000)
        : null;
      const varianceExpiryDays = execExpiryDate && existingLease.lease_end
        ? Math.round((new Date(execExpiryDate).getTime() - new Date(existingLease.lease_end as string).getTime()) / 86400000)
        : null;
      const varianceTenantMatch = execTenantName && existingLease.tenant_name
        ? execTenantName.toLowerCase().trim() === (existingLease.tenant_name as string).toLowerCase().trim()
        : null;
      const varianceLandlordMatch = execLandlordName && existingLease.landlord_name
        ? execLandlordName.toLowerCase().trim() === (existingLease.landlord_name as string).toLowerCase().trim()
        : null;

      const { error: updateError } = await supabaseAdmin
        .from('leases')
        .update({
          executed_storage_path:          executedStoragePath,
          executed_filename:              sanitizedFilename,
          executed_extracted_json:        leaseData,
          executed_extraction_confidence: executedConfidence,
          executed_uploaded_at:           new Date().toISOString(),
          executed_uploaded_by:           user.id,
          executed_monthly_payment:       execMonthlyPayment,
          executed_commencement_date:     execCommencementDate,
          executed_expiry_date:           execExpiryDate,
          executed_tenant_name:           execTenantName,
          executed_landlord_name:         execLandlordName,
          executed_rent_review_clause:    execRentReviewClause,
          executed_break_clause:          execBreakClause,
          variance_monthly_payment:       varianceMonthly,
          variance_commencement_days:     varianceCommencementDays,
          variance_expiry_days:           varianceExpiryDays,
          variance_tenant_name_match:     varianceTenantMatch,
          variance_landlord_name_match:   varianceLandlordMatch,
        })
        .eq('id', targetLeaseId);

      if (updateError) throw new Error(`Failed to update lease with executed data: ${updateError.message}`);

      await supabaseAdmin.from('lease_activity_log').insert({
        lease_id: targetLeaseId,
        user_id: user.id,
        activity_type: 'executed_terms_extracted',
        details: {
          fields_extracted:           execFieldMap.filter(([, f]) => extractValue(f) !== null).length,
          variance_monthly:           varianceMonthly,
          variance_commencement_days: varianceCommencementDays,
          variance_expiry_days:       varianceExpiryDays,
          tenant_match:               varianceTenantMatch,
          landlord_match:             varianceLandlordMatch,
        },
      });

      console.log('[process_lease] Executed mode complete');

      return new Response(JSON.stringify({
        success: true,
        leaseId: targetLeaseId,
        executedData: {
          executed_monthly_payment:    execMonthlyPayment,
          executed_commencement_date:  execCommencementDate,
          executed_expiry_date:        execExpiryDate,
          executed_tenant_name:        execTenantName,
          executed_landlord_name:      execLandlordName,
          executed_rent_review_clause: execRentReviewClause,
          executed_break_clause:       execBreakClause,
          executed_storage_path:       executedStoragePath,
          executed_filename:           sanitizedFilename,
        },
        variance: {
          variance_monthly_payment:     varianceMonthly,
          variance_commencement_days:   varianceCommencementDays,
          variance_expiry_days:         varianceExpiryDays,
          variance_tenant_name_match:   varianceTenantMatch,
          variance_landlord_name_match: varianceLandlordMatch,
        },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ================================================================
    // PIPELINE MODE
    // ================================================================

    if (!ALLOWED_LEASE_TYPES.includes(leaseType as typeof ALLOWED_LEASE_TYPES[number])) {
      return new Response(JSON.stringify({ error: 'Invalid lease type. Must be "master" or "amendment".' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (parentLeaseId && !isValidUUID(parentLeaseId)) {
      return new Response(JSON.stringify({ error: 'Invalid parent lease ID format.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve workspace_id: prefer request param, fall back to user's first membership
    let resolvedWorkspaceId: string | null = workspaceIdFromRequest || null;
    if (!resolvedWorkspaceId) {
      const { data: membership } = await supabaseAdmin
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .limit(1)
        .single();
      resolvedWorkspaceId = membership?.workspace_id ?? null;
    }
    console.log(`[process_lease] Resolved workspace_id: ${resolvedWorkspaceId}`);

    const leaseId = crypto.randomUUID();
    const storagePath = `${user.id}/${leaseId}/${sanitizedFilename}`;

    const { error: insertError } = await supabaseAdmin
      .from('leases')
      .insert({ id: leaseId, user_id: user.id, workspace_id: resolvedWorkspaceId, filename: sanitizedFilename, storage_path: storagePath, status: 'Processing', intake_source: 'manual_upload' });

    if (insertError) throw new Error(`Failed to create lease record: ${insertError.message}`);
    console.log(`[process_lease] Created lease record: ${leaseId}`);

    const { error: uploadError } = await supabaseAdmin.storage
      .from('leases')
      .upload(storagePath, fileBytes, { contentType: 'application/pdf', upsert: true });

    if (uploadError) {
      await supabaseAdmin.from('leases').update({ status: 'Failed', error_message: `Upload failed: ${uploadError.message}` }).eq('id', leaseId);
      throw new Error(`Failed to upload file: ${uploadError.message}`);
    }
    console.log('[process_lease] File uploaded to storage');

    let extractedText: string;
    try {
      extractedText = await analyzeWithAzureDI(fileBytes);
      console.log(`[process_lease] Extracted ${extractedText.length} characters`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabaseAdmin.from('leases').update({ status: 'Failed', error_message: `Document analysis failed: ${errorMessage}` }).eq('id', leaseId);
      throw error;
    }

    let leaseData: LeaseExtractionResult;
    try {
      leaseData = await extractLeaseDataWithOpenAI(extractedText);
      console.log('[process_lease] Lease data extracted:', JSON.stringify(leaseData).substring(0, 500));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabaseAdmin.from('leases').update({ status: 'Failed', error_message: `AI extraction failed: ${errorMessage}` }).eq('id', leaseId);
      throw error;
    }

    const { warnings: validationWarnings, suggestions: validationSuggestions } = validateLeaseData(leaseData);
    if (validationWarnings.length > 0) {
      console.log('[process_lease] Validation warnings:', validationWarnings);
      (leaseData as any)._validation_warnings = validationWarnings;
      (leaseData as any)._validation_suggestions = validationSuggestions;
    }

    // ----------------------------------------------------------------
    // Step 1 — Escalation normalization
    // Parse rent_escalation_type exactly once here.
    // Downstream code must use escalation_type and escalation_rate only.
    // ----------------------------------------------------------------
    const rawRentEscalationType = extractValue(leaseData.rent_escalation_type) as string | null;
    const { escalationType, escalationRate, needsEscalationReview } = normalizeEscalation(rawRentEscalationType);
    console.log(`[process_lease] Escalation normalized: type=${escalationType}, rate=${escalationRate}, review=${needsEscalationReview}`);

    const { error: updateError } = await supabaseAdmin
      .from('leases')
      .update({
        status: 'Ready',
        landlord_name: extractValue(leaseData.landlord_name),
        tenant_name: extractValue(leaseData.tenant_name),
        lease_start: safeDate(extractValue(leaseData.lease_start)),
        lease_end: safeDate(extractValue(leaseData.lease_end)),
        base_rent_amount: extractValue(leaseData.base_rent_amount),
        base_rent_frequency: extractValue(leaseData.base_rent_frequency),
        current_monthly_rent: extractValue(leaseData.current_monthly_rent),
        rent_escalation_type: rawRentEscalationType, // stored for reference; use escalation_type downstream
        escalation_type: escalationType,
        escalation_rate: escalationRate,
        needs_escalation_review: needsEscalationReview,
        square_footage: extractValue(leaseData.square_footage),
        extracted_json: leaseData,
        processed_at: new Date().toISOString(),
      })
      .eq('id', leaseId);

    if (updateError) throw new Error(`Failed to update lease: ${updateError.message}`);

    const fieldsToTrack = ['landlord_name', 'tenant_name', 'property_address', 'lease_start', 'lease_end', 'square_footage', 'current_monthly_rent', 'rent_escalation_type'];
    const confidenceEntries: { lease_id: string; field_name: string; confidence_score: number }[] = [];
    for (const fieldName of fieldsToTrack) {
      const fieldData = (leaseData as any)[fieldName];
      const confidence = extractConfidence(fieldData);
      if (confidence !== null) confidenceEntries.push({ lease_id: leaseId, field_name: fieldName, confidence_score: Math.min(confidence, 1.0) });
    }
    if (confidenceEntries.length > 0) {
      const { error: confError } = await supabaseAdmin.from('lease_field_confidence').upsert(confidenceEntries, { onConflict: 'lease_id,field_name' });
      if (confError) console.error('[process_lease] Confidence insert error:', confError);
      else console.log(`[process_lease] Stored ${confidenceEntries.length} confidence scores`);
    }

    if (leaseData.rent_schedule && leaseData.rent_schedule.length > 0) {
      const rentScheduleToInsert = leaseData.rent_schedule
        .filter(period => period.period_start)
        .map(period => ({
          lease_id: leaseId,
          period_start: safeDate(period.period_start),
          period_end: safeDate(period.period_end),
          monthly_amount: period.monthly_amount,
          annual_amount: period.annual_amount,
          notes: period.notes,
        }));
      if (rentScheduleToInsert.length > 0) {
        const { error: rentError } = await supabaseAdmin.from('rent_schedules').insert(rentScheduleToInsert);
        if (rentError) console.error('[process_lease] Rent schedule insert error:', rentError);
        else console.log(`[process_lease] Inserted ${rentScheduleToInsert.length} rent schedule entries`);
      }
    }

    if (leaseData.risks && leaseData.risks.length > 0) {
      const risksToInsert = leaseData.risks.map(risk => ({
        lease_id: leaseId,
        title: risk.title,
        severity: risk.severity,
        explanation: risk.explanation,
        citation_snippet: risk.citation_snippet || null,
        citation_page: risk.citation_page || null,
      }));
      const { error: risksError } = await supabaseAdmin.from('risks').insert(risksToInsert);
      if (risksError) console.error('[process_lease] Risks insert error:', risksError);
      else console.log(`[process_lease] Inserted ${risksToInsert.length} risks`);
    }

    console.log('[process_lease] Processing complete');
    return new Response(JSON.stringify({ success: true, leaseId, data: leaseData }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Processing failed';
    console.error('[process_lease] Error:', error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
