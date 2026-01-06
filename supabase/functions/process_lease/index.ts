import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Azure Document Intelligence
const AZURE_DI_ENDPOINT = Deno.env.get('AZURE_DI_ENDPOINT');
const AZURE_DI_KEY = Deno.env.get('AZURE_DI_KEY');

// OpenAI
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') || 'gpt-4o-mini';

// Supabase
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
  // New rent schedule fields
  current_monthly_rent: number | null;
  rent_escalation_type: string | null;
  rent_schedule: RentPeriod[];
  rent_commencement_date: string | null;
  // Legacy fields for backwards compatibility
  base_rent_amount: string | null;
  base_rent_frequency: string | null;
  security_deposit: string | null;
  renewal_options: string | null;
  escalation_clauses: string | null;
  termination_clauses: string | null;
  key_dates: { date: string; description: string }[];
  risks: { title: string; severity: 'low' | 'medium' | 'high'; explanation: string; citation_snippet?: string; citation_page?: number }[];
}

// Helper to sanitize date strings before inserting into Postgres DATE columns
function safeDate(input: string | null | undefined): string | null {
  // Return null for falsy values
  if (!input || typeof input !== 'string') {
    return null;
  }
  
  const trimmed = input.trim();
  
  // Return null for empty strings
  if (!trimmed) {
    return null;
  }
  
  // Return null if contains underscores (placeholder like 20__-__-__ or ____-__-__)
  if (trimmed.includes('_')) {
    console.log(`[safeDate] Rejecting placeholder date: ${trimmed}`);
    return null;
  }
  
  // Return null for common non-date tokens
  const invalidTokens = ['tbd', 'n/a', 'unknown', 'pending', 'none', 'null', 'undefined'];
  if (invalidTokens.includes(trimmed.toLowerCase())) {
    console.log(`[safeDate] Rejecting non-date token: ${trimmed}`);
    return null;
  }
  
  // If already in YYYY-MM-DD format, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  
  // Try to parse common date formats
  try {
    // MM/DD/YYYY or M/D/YYYY
    const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashMatch) {
      const [, month, day, year] = slashMatch;
      const formatted = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      console.log(`[safeDate] Parsed MM/DD/YYYY: ${trimmed} -> ${formatted}`);
      return formatted;
    }
    
    // Month D, YYYY or Month DD, YYYY (e.g., "January 1, 2024" or "Jan 15, 2024")
    const monthNames: Record<string, string> = {
      'january': '01', 'jan': '01',
      'february': '02', 'feb': '02',
      'march': '03', 'mar': '03',
      'april': '04', 'apr': '04',
      'may': '05',
      'june': '06', 'jun': '06',
      'july': '07', 'jul': '07',
      'august': '08', 'aug': '08',
      'september': '09', 'sep': '09', 'sept': '09',
      'october': '10', 'oct': '10',
      'november': '11', 'nov': '11',
      'december': '12', 'dec': '12',
    };
    
    const monthMatch = trimmed.match(/^([a-zA-Z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (monthMatch) {
      const [, monthStr, day, year] = monthMatch;
      const monthNum = monthNames[monthStr.toLowerCase()];
      if (monthNum) {
        const formatted = `${year}-${monthNum}-${day.padStart(2, '0')}`;
        console.log(`[safeDate] Parsed Month D, YYYY: ${trimmed} -> ${formatted}`);
        return formatted;
      }
    }
    
    // Try JavaScript Date parsing as last resort
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      // Only accept if year is reasonable (1900-2100)
      if (year >= 1900 && year <= 2100) {
        const formatted = `${year}-${month}-${day}`;
        console.log(`[safeDate] Parsed via Date(): ${trimmed} -> ${formatted}`);
        return formatted;
      }
    }
  } catch (e) {
    console.log(`[safeDate] Parse error for: ${trimmed}`, e);
  }
  
  console.log(`[safeDate] Could not parse, returning null: ${trimmed}`);
  return null;
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
    console.error('[Azure DI] Analyze request failed:', errorText);
    throw new Error(`Azure DI analyze failed: ${analyzeResponse.status} - ${errorText}`);
  }

  const operationLocation = analyzeResponse.headers.get('Operation-Location');
  if (!operationLocation) {
    throw new Error('Azure DI did not return Operation-Location header');
  }

  console.log('[Azure DI] Polling for results...');
  
  // Poll for results
  let result = null;
  let attempts = 0;
  const maxAttempts = 60; // 60 seconds max
  
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const pollResponse = await fetch(operationLocation, {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_DI_KEY!,
      },
    });

    if (!pollResponse.ok) {
      const errorText = await pollResponse.text();
      console.error('[Azure DI] Poll failed:', errorText);
      throw new Error(`Azure DI poll failed: ${pollResponse.status}`);
    }

    const pollResult = await pollResponse.json();
    
    if (pollResult.status === 'succeeded') {
      result = pollResult.analyzeResult;
      break;
    } else if (pollResult.status === 'failed') {
      console.error('[Azure DI] Analysis failed:', pollResult.error);
      throw new Error(`Azure DI analysis failed: ${JSON.stringify(pollResult.error)}`);
    }
    
    attempts++;
  }

  if (!result) {
    throw new Error('Azure DI analysis timed out');
  }

  console.log(`[Azure DI] Extracted ${result.pages?.length || 0} pages`);
  
  // Extract text content from paragraphs and tables
  let extractedText = '';
  
  // Get paragraphs
  if (result.paragraphs) {
    for (const paragraph of result.paragraphs) {
      extractedText += paragraph.content + '\n\n';
    }
  }
  
  // Get tables
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
  
  const systemPrompt = `You are an expert commercial lease analyst. Your task is to extract key information from lease documents following industry-standard lease abstraction practices.

Extract the following information and return as JSON:
- landlord_name: The landlord/lessor name
- tenant_name: The tenant/lessee name  
- property_address: Full property address
- lease_start: Lease commencement date (ISO format YYYY-MM-DD if possible)
- lease_end: Lease expiration date (ISO format YYYY-MM-DD if possible)

RENT SCHEDULE (CRITICAL - extract complete rent history):
- current_monthly_rent: The current monthly rent amount as of today (number only, no currency symbol)
- rent_escalation_type: How rent increases over time. Examples: "3% annual increase", "CPI adjustment", "Fixed schedule", "Step increases", "None"
- rent_commencement_date: When rent payments begin (may differ from lease start)
- rent_schedule: Array of ALL rent periods found in the document. For each period:
  - period_start: Start date of this rent period (YYYY-MM-DD)
  - period_end: End date of this rent period (YYYY-MM-DD), null if ongoing
  - monthly_amount: Monthly rent for this period (number only)
  - annual_amount: Annual rent for this period (number only)
  - notes: Any special notes about this period (e.g., "Year 1", "After CPI adjustment")

For leases with escalations, extract EACH rent period separately. For example:
Year 1: $5,000/month -> { period_start: "2024-01-01", period_end: "2024-12-31", monthly_amount: 5000 }
Year 2: $5,150/month -> { period_start: "2025-01-01", period_end: "2025-12-31", monthly_amount: 5150 }

- base_rent_amount: Initial base rent (legacy field, use current_monthly_rent for new logic)
- base_rent_frequency: "monthly", "quarterly", or "annually"
- security_deposit: Security deposit amount
- renewal_options: Summary of renewal options
- escalation_clauses: Summary of rent escalation terms (text description)
- termination_clauses: Summary of termination provisions
- key_dates: Array of important dates [{date, description}]
- risks: Array of identified risks [{title, severity (low/medium/high), explanation, citation_snippet, citation_page}]

For risks, look for:
- Unfavorable termination clauses
- Automatic renewal without notice
- Excessive rent escalations (flag if >5% annual)
- Limited assignment/subletting rights
- Personal guarantee requirements
- Missing or unclear provisions
- Unclear rent escalation methodology

Return ONLY valid JSON, no markdown or explanation.`;

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
        { role: 'user', content: `Please analyze this lease document and extract the key information:\n\n${documentText.substring(0, 50000)}` }
      ],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[OpenAI] Request failed:', errorText);
    throw new Error(`OpenAI request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  
  console.log('[OpenAI] Raw response:', content.substring(0, 500));
  
  // Parse JSON from response (handle markdown code blocks)
  let jsonStr = content;
  if (content.includes('```json')) {
    jsonStr = content.split('```json')[1].split('```')[0];
  } else if (content.includes('```')) {
    jsonStr = content.split('```')[1].split('```')[0];
  }
  
  try {
    return JSON.parse(jsonStr.trim());
  } catch (e) {
    console.error('[OpenAI] Failed to parse JSON:', e);
    throw new Error('Failed to parse OpenAI response as JSON');
  }
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('[process_lease] Request received');
    
    // Get authorization header
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Create Supabase client with service role for DB operations
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // Create Supabase client with user token to verify auth
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3a3dveHhjcHJuamp1ZmtiemFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczMjIzNzAsImV4cCI6MjA4Mjg5ODM3MH0.6ymyHJ5yDoLxnEHupdhcLUnile__H8HxN3bZ5x77jto';
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } }
    });
    
    // Get authenticated user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      console.error('[process_lease] Auth error:', authError);
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    console.log(`[process_lease] User authenticated: ${user.id}`);

    // Parse form data
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const leaseType = formData.get('leaseType') as string || 'master';
    const parentLeaseId = formData.get('parentLeaseId') as string | null;
    
    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[process_lease] Processing file: ${file.name}, size: ${file.size}`);

    // Create initial lease record
    const leaseId = crypto.randomUUID();
    const storagePath = `${user.id}/${leaseId}/${file.name}`;
    
    const { error: insertError } = await supabaseAdmin
      .from('leases')
      .insert({
        id: leaseId,
        user_id: user.id,
        filename: file.name,
        storage_path: storagePath,
        status: 'Processing',
      });

    if (insertError) {
      console.error('[process_lease] Insert error:', insertError);
      throw new Error(`Failed to create lease record: ${insertError.message}`);
    }

    console.log(`[process_lease] Created lease record: ${leaseId}`);

    // Upload file to storage
    const fileBytes = await file.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from('leases')
      .upload(storagePath, fileBytes, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      console.error('[process_lease] Upload error:', uploadError);
      await supabaseAdmin.from('leases').update({ 
        status: 'Failed', 
        error_message: `Upload failed: ${uploadError.message}` 
      }).eq('id', leaseId);
      throw new Error(`Failed to upload file: ${uploadError.message}`);
    }

    console.log('[process_lease] File uploaded to storage');

    // Step 1: Analyze with Azure Document Intelligence
    let extractedText: string;
    try {
      extractedText = await analyzeWithAzureDI(fileBytes);
      console.log(`[process_lease] Extracted ${extractedText.length} characters`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[process_lease] Azure DI error:', error);
      await supabaseAdmin.from('leases').update({ 
        status: 'Failed', 
        error_message: `Document analysis failed: ${errorMessage}` 
      }).eq('id', leaseId);
      throw error;
    }

    // Step 2: Extract lease data with OpenAI
    let leaseData: LeaseExtractionResult;
    try {
      leaseData = await extractLeaseDataWithOpenAI(extractedText);
      console.log('[process_lease] Lease data extracted:', JSON.stringify(leaseData).substring(0, 500));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[process_lease] OpenAI error:', error);
      await supabaseAdmin.from('leases').update({ 
        status: 'Failed', 
        error_message: `AI extraction failed: ${errorMessage}` 
      }).eq('id', leaseId);
      throw error;
    }

    // Step 3: Update lease record with extracted data
    const { error: updateError } = await supabaseAdmin
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
        rent_escalation_type: leaseData.rent_escalation_type,
        extracted_json: leaseData,
        processed_at: new Date().toISOString(),
      })
      .eq('id', leaseId);

    if (updateError) {
      console.error('[process_lease] Update error:', updateError);
      throw new Error(`Failed to update lease: ${updateError.message}`);
    }

    // Step 3.5: Insert rent schedule entries
    if (leaseData.rent_schedule && leaseData.rent_schedule.length > 0) {
      const rentScheduleToInsert = leaseData.rent_schedule
        .filter(period => period.period_start) // Only insert periods with a start date
        .map(period => ({
          lease_id: leaseId,
          period_start: safeDate(period.period_start),
          period_end: safeDate(period.period_end),
          monthly_amount: period.monthly_amount,
          annual_amount: period.annual_amount,
          notes: period.notes,
        }));

      if (rentScheduleToInsert.length > 0) {
        const { error: rentError } = await supabaseAdmin
          .from('rent_schedules')
          .insert(rentScheduleToInsert);

        if (rentError) {
          console.error('[process_lease] Rent schedule insert error:', rentError);
          // Don't fail the whole operation for rent schedule
        } else {
          console.log(`[process_lease] Inserted ${rentScheduleToInsert.length} rent schedule entries`);
        }
      }
    }

    // Step 4: Insert risks
    if (leaseData.risks && leaseData.risks.length > 0) {
      const risksToInsert = leaseData.risks.map(risk => ({
        lease_id: leaseId,
        title: risk.title,
        severity: risk.severity,
        explanation: risk.explanation,
        citation_snippet: risk.citation_snippet || null,
        citation_page: risk.citation_page || null,
      }));

      const { error: risksError } = await supabaseAdmin
        .from('risks')
        .insert(risksToInsert);

      if (risksError) {
        console.error('[process_lease] Risks insert error:', risksError);
        // Don't fail the whole operation for risks
      } else {
        console.log(`[process_lease] Inserted ${risksToInsert.length} risks`);
      }
    }

    console.log('[process_lease] Processing complete');

    return new Response(JSON.stringify({ 
      success: true, 
      leaseId,
      data: leaseData 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Processing failed';
    console.error('[process_lease] Error:', error);
    return new Response(JSON.stringify({ 
      error: errorMessage 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
