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
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') || 'gpt-4o-mini';

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

// Validate UUID format
function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
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

/**
 * Escalation Rate Normalization
 *
 * Parsing boundary: rent_escalation_type is parsed ONLY in ingestion functions
 * (process_lease and retry_lease). Downstream code must use escalation_rate
 * and escalation_type exclusively.
 *
 * ASC 842 hard rule: CPI/index leases must NEVER be silently defaulted to 0.
 * escalationRate is returned as null for index leases to make the gap explicit.
 *
 * Keep this function in sync with the copy in process_lease/index.ts.
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
    const cpiPattern = /\b(cpi|index|consumer\s+price|inflation[- ]based)\b/i;
    if (cpiPattern.test(raw)) {
      return {
        escalationType: 'index',
        escalationRate: null, // explicitly null — never silently 0
        needsEscalationReview: true,
      };
    }
  }

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
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_DI_KEY!,
      'Content-Type': 'application/pdf',
    },
    body: new Blob([pdfBytes], { type: 'application/pdf' }),
  });

  if (!analyzeResponse.ok) {
    const errorText = await analyzeResponse.text();
    throw new Error(`Azure DI analyze failed: ${analyzeResponse.status} - ${errorText}`);
  }

  const operationLocation = analyzeResponse.headers.get('Operation-Location');
  if (!operationLocation) {
    throw new Error('Azure DI did not return Operation-Location header');
  }

  let result = null;
  let attempts = 0;
  const maxAttempts = 60;
  
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const pollResponse = await fetch(operationLocation, {
      headers: { 'Ocp-Apim-Subscription-Key': AZURE_DI_KEY! },
    });

    if (!pollResponse.ok) {
      throw new Error(`Azure DI poll failed: ${pollResponse.status}`);
    }

    const pollResult = await pollResponse.json();
    
    if (pollResult.status === 'succeeded') {
      result = pollResult.analyzeResult;
      break;
    } else if (pollResult.status === 'failed') {
      throw new Error(`Azure DI analysis failed: ${JSON.stringify(pollResult.error)}`);
    }
    
    attempts++;
  }

  if (!result) throw new Error('Azure DI analysis timed out');

  let extractedText = '';
  if (result.paragraphs) {
    for (const paragraph of result.paragraphs) {
      extractedText += paragraph.content + '\n\n';
    }
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
  const systemPrompt = `You are an expert commercial lease analyst. Extract key information following industry-standard lease abstraction.

Extract and return as JSON:
- landlord_name, tenant_name, property_address
- lease_start, lease_end (ISO format YYYY-MM-DD)

RENT SCHEDULE (extract complete rent history):
- current_monthly_rent: Current monthly rent (number only)
- rent_escalation_type: How rent increases (e.g., "3% annual", "CPI", "Step increases", "None")
- rent_commencement_date: When rent payments begin (YYYY-MM-DD)
- rent_schedule: Array of ALL rent periods [{
    period_start: YYYY-MM-DD,
    period_end: YYYY-MM-DD or null,
    monthly_amount: number,
    annual_amount: number,
    notes: string
  }]

For leases with escalations, extract EACH rent period separately.

- base_rent_amount (string with currency), base_rent_frequency
- security_deposit, renewal_options, escalation_clauses, termination_clauses
- key_dates: Array of [{date, description}]
- risks: Array of [{title, severity (low/medium/high), explanation, citation_snippet, citation_page}]

Return ONLY valid JSON, no markdown.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze this lease:\n\n${documentText.substring(0, 50000)}` }
      ],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  let content = data.choices[0].message.content;
  
  if (content.includes('```json')) {
    content = content.split('```json')[1].split('```')[0];
  } else if (content.includes('```')) {
    content = content.split('```')[1].split('```')[0];
  }
  
  return JSON.parse(content.trim());
}

serve(async (req) => {
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

    const { leaseId } = body as { leaseId?: unknown };
    
    if (!leaseId) {
      return new Response(JSON.stringify({ error: 'Missing leaseId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (typeof leaseId !== 'string') {
      return new Response(JSON.stringify({ error: 'leaseId must be a string' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!isValidUUID(leaseId)) {
      console.log(`[retry_lease] Invalid leaseId format: ${leaseId}`);
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
      .eq('user_id', user.id)
      .single();

    if (fetchError || !lease) {
      return new Response(JSON.stringify({ error: 'Lease not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!lease.storage_path) {
      return new Response(JSON.stringify({ error: 'No file found for this lease' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[retry_lease] Retrying lease: ${leaseId}`);

    // Update status to Processing
    await supabaseAdmin
      .from('leases')
      .update({ status: 'Processing', error_message: null })
      .eq('id', leaseId);

    // Delete derived artifacts before regenerating to prevent duplicates
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

    // Re-process with Azure DI
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

    // Extract with OpenAI
    let leaseData: LeaseExtractionResult;
    try {
      leaseData = await extractLeaseDataWithOpenAI(extractedText);
      console.log('[retry_lease] Data extracted successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabaseAdmin.from('leases').update({ 
        status: 'Failed', 
        error_message: `AI extraction failed: ${errorMessage}` 
      }).eq('id', leaseId);
      throw error;
    }

    // Normalize escalation fields — same contract as process_lease
    // Parsing boundary: rent_escalation_type is read here and nowhere else downstream.
    const { escalationType, escalationRate, needsEscalationReview } =
      normalizeEscalation(leaseData.rent_escalation_type);
    console.log(`[retry_lease] Escalation normalized: type=${escalationType}, rate=${escalationRate}, review=${needsEscalationReview}`);

    // Update lease record with normalized fields
    await supabaseAdmin
      .from('leases')
      .update({
        status: 'Ready',
        landlord_name: leaseData.landlord_name,
        tenant_name: leaseData.tenant_name,
        lease_start: safeDate(leaseData.lease_start),
        lease_end: safeDate(leaseData.lease_end),
        base_rent_amount: leaseData.base_rent_amount,
        base_rent_frequency: leaseData.base_rent_frequency,
        current_monthly_rent: leaseData.current_monthly_rent,
        rent_escalation_type: leaseData.rent_escalation_type, // stored for reference
        escalation_type: escalationType,
        escalation_rate: escalationRate,
        needs_escalation_review: needsEscalationReview,
        extracted_json: leaseData,
        processed_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('id', leaseId);

    // Insert rent schedule entries
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
        await supabaseAdmin.from('rent_schedules').insert(rentScheduleToInsert);
        console.log(`[retry_lease] Inserted ${rentScheduleToInsert.length} rent schedule entries`);
      }
    }

    // Insert risks
    if (leaseData.risks && leaseData.risks.length > 0) {
      const risksToInsert = leaseData.risks.map(risk => ({
        lease_id: leaseId,
        title: risk.title,
        severity: risk.severity,
        explanation: risk.explanation,
        citation_snippet: risk.citation_snippet || null,
        citation_page: risk.citation_page || null,
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
