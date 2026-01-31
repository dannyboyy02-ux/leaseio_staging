import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

// Secure CORS configuration
const ALLOWED_ORIGINS = [
  'https://leaseflow.ai',
  'https://www.leaseflow.ai',
  'https://app.leaseflow.ai',
  'https://theleaseio.lovable.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin = requestOrigin && (
    ALLOWED_ORIGINS.includes(requestOrigin) || 
    requestOrigin.endsWith('.lovable.app')
  )
    ? requestOrigin 
    : ALLOWED_ORIGINS[0];
    
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
  // Square footage
  square_footage: number | null;
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

// Validate UUID format
function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

// Check if file is a PDF by examining magic bytes
function isPdfFile(bytes: ArrayBuffer): boolean {
  const header = new Uint8Array(bytes.slice(0, 4));
  return header.every((byte, index) => byte === PDF_MAGIC_BYTES[index]);
}

// Sanitize filename to prevent path traversal
function sanitizeFilename(filename: string): string {
  // Remove path components and dangerous characters
  const sanitized = filename
    .replace(/[\/\\]/g, '_')  // Replace path separators
    .replace(/\.\./g, '_')     // Remove parent directory references
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')  // Remove invalid chars
    .trim();
  
  // Ensure it's not empty and has reasonable length
  if (!sanitized || sanitized.length > 255) {
    return `lease_${Date.now()}.pdf`;
  }
  
  return sanitized;
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

EXAMPLE EXTRACTIONS FROM REAL COMMERCIAL LEASES:

Example 1 - Office Lease:

Document: "This Lease Agreement is made between XYZ Properties LLC ('Landlord') and Acme Corporation ('Tenant') for premises at 123 Main Street, Suite 500, Chicago, IL 60601. Term: January 1, 2024 to December 31, 2028. Base monthly rent: Ten Thousand Dollars ($10,000.00)."

Extraction: {"landlord_name": {"value": "XYZ Properties LLC", "confidence": 0.98, "page": 1, "source_text": "XYZ Properties LLC ('Landlord')"}, "tenant_name": {"value": "Acme Corporation", "confidence": 0.98, "page": 1}, "property_address": {"value": "123 Main Street, Suite 500, Chicago, IL 60601", "confidence": 0.97, "page": 1}, "lease_start": {"value": "2024-01-01", "confidence": 0.99, "page": 1}, "lease_end": {"value": "2028-12-31", "confidence": 0.99, "page": 1}, "current_monthly_rent": {"value": 10000, "confidence": 0.99, "page": 1}}

Example 2 - Retail Lease with Escalations:

Document: "Year 1 rent (Jan 1, 2024 - Dec 31, 2024): $5,000/month. Year 2: $5,150/month (3% increase). Year 3: $5,305/month (3% increase). Premises: 2,500 RSF."

Extraction: {"current_monthly_rent": {"value": 5000, "confidence": 0.96, "page": 2}, "rent_escalation_type": {"value": "3% annual increase", "confidence": 0.95, "page": 2}, "square_footage": {"value": 2500, "confidence": 0.94, "page": 2}, "rent_schedule": [{"period_start": "2024-01-01", "period_end": "2024-12-31", "monthly_amount": 5000, "annual_amount": 60000, "notes": "Year 1", "confidence": 0.96}, {"period_start": "2025-01-01", "period_end": "2025-12-31", "monthly_amount": 5150, "annual_amount": 61800, "notes": "Year 2 - 3% increase", "confidence": 0.95}]}

Example 3 - Equipment Lease:

Document: "Lessor: ABC Equipment Leasing Inc. Lessee: Manufacturing Co. Equipment: Forklift Model XL-2000. Monthly payment: $850. Term: 36 months from March 15, 2024."

Extraction: {"landlord_name": {"value": "ABC Equipment Leasing Inc", "confidence": 0.97, "page": 1}, "tenant_name": {"value": "Manufacturing Co", "confidence": 0.96, "page": 1}, "lease_start": {"value": "2024-03-15", "confidence": 0.98, "page": 1}, "current_monthly_rent": {"value": 850, "confidence": 0.98, "page": 1}}

Example 4 - Missing Information:

Document: "Property in downtown area. Market rate rent."

Extraction: {"property_address": {"value": null, "confidence": 0.0, "page": 1, "source_text": "downtown area"}, "current_monthly_rent": {"value": null, "confidence": 0.0, "page": 1, "source_text": "market rate rent"}}

Example 5 - Complex Rent with CPI:

Document: "Base rent Year 1: $8,000/month. Years 2-5: Annual increase equal to CPI, min 2%, max 4%. Premises: 3,200 RSF."

Extraction: {"current_monthly_rent": {"value": 8000, "confidence": 0.97}, "rent_escalation_type": {"value": "CPI adjustment, 2% floor, 4% ceiling", "confidence": 0.93}, "square_footage": {"value": 3200, "confidence": 0.96}}

Example 6 - Percentage Rent:

Document: "Minimum rent: $5,000/month. Plus 6% of gross sales over $1M annually."

Extraction: {"current_monthly_rent": {"value": 5000, "confidence": 0.98}, "rent_escalation_type": {"value": "Min rent plus 6% of sales over $1M", "confidence": 0.90}}

Example 7 - Triple Net:

Document: "Base: $12/sqft/year. Tenant pays taxes, insurance, CAM ~$4.50/sqft. 5,000 RSF."

Extraction: {"current_monthly_rent": {"value": 5000, "confidence": 0.92}, "square_footage": {"value": 5000, "confidence": 0.98}, "rent_escalation_type": {"value": "NNN - tenant pays separately", "confidence": 0.95}}

Example 8 - Equipment Lease with Calculated End:

Document: "Tech Rental LLC to Startup Inc. $1,250/mo for Dell R740. 24mo from April 1, 2024."

Extraction: {"landlord_name": {"value": "Tech Rental LLC", "confidence": 0.97}, "tenant_name": {"value": "Startup Inc", "confidence": 0.96}, "current_monthly_rent": {"value": 1250, "confidence": 0.98}, "lease_start": {"value": "2024-04-01", "confidence": 0.98}, "lease_end": {"value": "2026-03-31", "confidence": 0.90}}

Example 9 - Incomplete Data:

Document: "Property at ~456 Oak St, downtown area."

Extraction: {"property_address": {"value": "456 Oak Street, downtown", "confidence": 0.55}}

Return ONLY valid JSON. No markdown formatting, no explanation, no preamble.`;

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
        { role: 'user', content: `Please analyze this lease document and extract the key information:\n\n${documentText}` }
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

// Helper function to extract value from confidence-scored field
function extractValue(field: any): any {
  if (field && typeof field === 'object' && 'value' in field) {
    return field.value;
  }
  return field; // Fallback for legacy format
}

// Helper function to extract confidence from field
function extractConfidence(field: any): number | null {
  if (field && typeof field === 'object' && 'confidence' in field) {
    return field.confidence;
  }
  return null;
}

// Validation helpers with suggestions
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
  if (!hasCity && !hasState && !hasZip) {
    return { valid: false, issue: 'Incomplete address - missing city/state/ZIP' };
  }
  return { valid: true };
}

function validateLeaseData(data: any): { warnings: string[]; suggestions: string[] } {
  const warnings: string[] = [];
  const suggestions: string[] = [];
  
  const rentCheck = validateMonthlyRent(extractValue(data.current_monthly_rent));
  if (!rentCheck.valid) {
    warnings.push(rentCheck.issue || 'Rent validation failed');
    if (rentCheck.suggestion) suggestions.push(rentCheck.suggestion);
  }
  
  const addressCheck = validateAddress(extractValue(data.property_address));
  if (!addressCheck.valid) warnings.push(addressCheck.issue || 'Address incomplete');
  
  const startCheck = validateDate(extractValue(data.lease_start));
  if (!startCheck.valid) warnings.push(`Start: ${startCheck.issue}`);
  
  const endCheck = validateDate(extractValue(data.lease_end));
  if (!endCheck.valid) warnings.push(`End: ${endCheck.issue}`);
  
  const leaseStart = extractValue(data.lease_start);
  const leaseEnd = extractValue(data.lease_end);
  if (leaseStart && leaseEnd) {
    if (new Date(leaseEnd) <= new Date(leaseStart)) {
      warnings.push('End must be after start');
    }
  }
  
  const sqftCheck = validateSquareFootage(extractValue(data.square_footage));
  if (!sqftCheck.valid) warnings.push(`Sqft: ${sqftCheck.issue}`);
  
  if (!extractValue(data.landlord_name)) warnings.push('Missing landlord');
  if (!extractValue(data.tenant_name)) warnings.push('Missing tenant');
  
  return { warnings, suggestions };
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
    
    // Validate file exists
    if (!file) {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      console.log(`[process_lease] File too large: ${file.size} bytes`);
      return new Response(JSON.stringify({ error: 'File too large. Maximum size is 50MB.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Read file bytes for validation
    const fileBytes = await file.arrayBuffer();
    
    // Validate file is actually a PDF using magic bytes
    if (!isPdfFile(fileBytes)) {
      console.log('[process_lease] File is not a valid PDF');
      return new Response(JSON.stringify({ error: 'Invalid file type. Only PDF files are allowed.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate lease type
    if (!ALLOWED_LEASE_TYPES.includes(leaseType as typeof ALLOWED_LEASE_TYPES[number])) {
      console.log(`[process_lease] Invalid lease type: ${leaseType}`);
      return new Response(JSON.stringify({ error: 'Invalid lease type. Must be "master" or "amendment".' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate parentLeaseId if provided
    if (parentLeaseId && !isValidUUID(parentLeaseId)) {
      console.log(`[process_lease] Invalid parentLeaseId format: ${parentLeaseId}`);
      return new Response(JSON.stringify({ error: 'Invalid parent lease ID format.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Sanitize filename
    const sanitizedFilename = sanitizeFilename(file.name);
    console.log(`[process_lease] Processing file: ${sanitizedFilename}, size: ${file.size}`);

    // Create initial lease record
    const leaseId = crypto.randomUUID();
    const storagePath = `${user.id}/${leaseId}/${sanitizedFilename}`;
    
    const { error: insertError } = await supabaseAdmin
      .from('leases')
      .insert({
        id: leaseId,
        user_id: user.id,
        filename: sanitizedFilename,
        storage_path: storagePath,
        status: 'Processing',
      });

    if (insertError) {
      console.error('[process_lease] Insert error:', insertError);
      throw new Error(`Failed to create lease record: ${insertError.message}`);
    }

    console.log(`[process_lease] Created lease record: ${leaseId}`);

    // Upload file to storage
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

    // Step 2.5: Validate extracted data
    const { warnings: validationWarnings, suggestions: validationSuggestions } = validateLeaseData(leaseData);
    if (validationWarnings.length > 0) {
      console.log('[process_lease] Validation warnings:', validationWarnings);
      (leaseData as any)._validation_warnings = validationWarnings;
      (leaseData as any)._validation_suggestions = validationSuggestions;
    }

    // Step 3: Update lease record with extracted data
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
        rent_escalation_type: extractValue(leaseData.rent_escalation_type),
        square_footage: extractValue(leaseData.square_footage),
        extracted_json: leaseData, // Store full structured data including confidence scores
        processed_at: new Date().toISOString(),
      })
      .eq('id', leaseId);

    if (updateError) {
      console.error('[process_lease] Update error:', updateError);
      throw new Error(`Failed to update lease: ${updateError.message}`);
    }

    // Step 3.25: Store field-level confidence scores
    const fieldsToTrack = ['landlord_name', 'tenant_name', 'property_address', 'lease_start', 'lease_end', 'square_footage', 'current_monthly_rent', 'rent_escalation_type'];
    const confidenceEntries: { lease_id: string; field_name: string; confidence_score: number }[] = [];
    
    for (const fieldName of fieldsToTrack) {
      const fieldData = (leaseData as any)[fieldName];
      const confidence = extractConfidence(fieldData);
      if (confidence !== null) {
        confidenceEntries.push({ 
          lease_id: leaseId, 
          field_name: fieldName, 
          confidence_score: Math.min(confidence, 1.0) // Ensure max is 1.0
        });
      }
    }

    if (confidenceEntries.length > 0) {
      const { error: confError } = await supabaseAdmin
        .from('lease_field_confidence')
        .upsert(confidenceEntries, { onConflict: 'lease_id,field_name' });
      
      if (confError) {
        console.error('[process_lease] Confidence insert error:', confError);
      } else {
        console.log(`[process_lease] Stored ${confidenceEntries.length} confidence scores`);
      }
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
