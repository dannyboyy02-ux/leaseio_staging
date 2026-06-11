import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  enforceWorkspaceRateLimit,
  repairJsonObject,
} from "../_shared/audit.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

// Anthropic (intelligence layer)
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');

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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function normalizeConfidenceScore(value: number): number {
  // The lease_field_confidence.confidence_score column is NUMERIC(3,2)
  // — it stores values on the 0.00–1.00 scale. Historical OpenAI-era
  // rows confirm: confidence_score=1.00 (not 100). The Claude pipeline
  // emits 0–1 directly (e.g., 0.99), so most calls are passthroughs.
  // Inputs that come in 0–100 form (legacy paths) get rescaled.
  // Prior version multiplied 0–1 inputs by 100 → 99 → numeric overflow
  // → silent upsert failure → empty lease_field_confidence. Fixed 2026-05-13.
  const onZeroOneScale = value > 1 ? value / 100 : value;
  return Math.min(Math.max(onZeroOneScale, 0), 1);
}

async function resolveAuthorizedWorkspaceId(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  requestedWorkspaceId: string | null,
): Promise<string | null> {
  if (requestedWorkspaceId) {
    if (!isValidUUID(requestedWorkspaceId)) {
      throw new Error('Invalid workspace ID format.');
    }

    const { data: ownedWorkspace, error: ownedError } = await supabaseAdmin
      .from('workspaces')
      .select('id')
      .eq('id', requestedWorkspaceId)
      .eq('owner_id', userId)
      .maybeSingle();

    if (ownedError) throw new Error(`Failed to validate workspace ownership: ${ownedError.message}`);
    if (ownedWorkspace) return ownedWorkspace.id;

    const { data: membership, error: membershipError } = await supabaseAdmin
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', requestedWorkspaceId)
      .eq('user_id', userId)
      .maybeSingle();

    if (membershipError) throw new Error(`Failed to validate workspace membership: ${membershipError.message}`);
    if (!membership) throw new Error('Unauthorized workspace access.');
    return membership.workspace_id;
  }

  // Fallback when the caller didn't specify a workspace. The original
  // implementation did `.limit(1)` with no ORDER BY — nondeterministic
  // when a user owns or is a member of multiple workspaces. Caught
  // 2026-05-13 when a lease silently landed in the wrong workspace.
  //
  // Policy: pick the most-recently-created workspace as a stable
  // default, AND log a warning so callers know they're depending on
  // a fallback they shouldn't.
  const { data: ownedWorkspaces, error: ownedError } = await supabaseAdmin
    .from('workspaces')
    .select('id, created_at')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(2);

  if (ownedError) throw new Error(`Failed to resolve workspace ownership: ${ownedError.message}`);
  if (ownedWorkspaces && ownedWorkspaces.length > 0) {
    if (ownedWorkspaces.length > 1) {
      console.warn(`[process_lease] User ${userId} owns multiple workspaces and no workspaceId was provided; defaulting to most-recently-created. Callers should always pass workspaceId.`);
    }
    return ownedWorkspaces[0].id;
  }

  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from('workspace_members')
    .select('workspace_id, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(2);

  if (membershipError) throw new Error(`Failed to resolve workspace membership: ${membershipError.message}`);
  if (memberships && memberships.length > 1) {
    console.warn(`[process_lease] User ${userId} is a member of multiple workspaces and no workspaceId was provided; defaulting to most-recently-joined.`);
  }
  return memberships?.[0]?.workspace_id ?? null;
}

// ================================================================
// ANTHROPIC TWO-PASS EXTRACTION
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

async function callAnthropicAPIWithPDF(
  model: string,
  system: string,
  pdfBase64: string,
  textPrompt: string,
  maxTokens: number,
  timeoutMs = 110_000,
): Promise<string> {
  // Single attempt — no retries on PDF calls. Under the 150s wall clock,
  // a failed retry + sleep would exceed the budget anyway.
  let lastError: Error | null = null;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            { type: 'text', text: textPrompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      lastError = new Error(`Anthropic PDF API error: ${response.status} - ${errorText}`);
      throw lastError;
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    if (!content) throw new Error('Anthropic PDF response missing content');

    console.log(`[Anthropic PDF:${model}] tokens in=${data.usage?.input_tokens} out=${data.usage?.output_tokens}`);
    return content;
  } catch (error) {
    lastError = error instanceof Error ? error : new Error(String(error));
    throw lastError;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tier 2 classification (Phase 1: hard gate on is_lease=false)
// ─────────────────────────────────────────────────────────────────────
//
// Runs BEFORE Tier 1 two-pass extraction. Cheap (~$0.01) Haiku call
// to determine whether the uploaded document is actually a lease.
// Hard-rejects only when confidence > TIER2_REJECT_CONFIDENCE_THRESHOLD,
// to minimize false-negative risk (rejecting a real lease).
//
// Phase 2-5 will add: soft warnings on asset/lease-type mismatch,
// auto-detection of parent leases for amendments, override path with
// correction recording, in-context learning from prior corrections.

interface Tier2Classification {
  is_lease: boolean;
  confidence: number;
  asset_type: 'real_estate' | 'equipment' | 'vehicle' | 'other' | null;
  lease_type: 'master' | 'amendment' | null;
  non_lease_reason: string | null;
}

const TIER2_REJECT_CONFIDENCE_THRESHOLD = 0.85;
// Soft-warning threshold (Phase 2). Lower bar than rejection: if
// Haiku has at least moderate confidence about a mismatch, surface
// the warning. Below this threshold the classifier's view is too
// noisy to be useful guidance.
const TIER2_WARNING_CONFIDENCE_THRESHOLD = 0.6;

// ─────────────────────────────────────────────────────────────────────
// Tier 2 Phase 3: parent-lease auto-detection for amendments
// ─────────────────────────────────────────────────────────────────────
//
// When an upload is classified as an amendment (declared by the user
// OR detected by Haiku with sufficient confidence), search the same
// workspace for active master leases whose parties + property
// plausibly match the extracted ones. Surface top candidates in the
// review UI so the user can confirm or reassign the parent.
//
// Matching strategy:
//   - Pull all non-archived master leases in the workspace (lease_type
//     is null OR = 'master'). RLS bypass via service-role; filter
//     workspace_id explicitly to prevent cross-workspace leakage.
//   - For each candidate, normalize tenant_name / landlord_name /
//     property_address (lowercase, strip corp suffixes, collapse
//     whitespace) and compare against the extracted values. Match
//     when normalized strings are equal OR one is a substring of the
//     other (length >= 5 to avoid noise).
//   - Score = number of matching fields (1, 2, or 3). Filter out
//     score 0. Return top 5 by score desc.

const CORPORATE_SUFFIX_RE = /\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|gmbh|sa|nv|bv|trust)\b\.?/gi;

function normalizeForMatch(s: string | null | undefined): string {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[,.&'\-]/g, ' ')
    .replace(CORPORATE_SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring containment for partial matches (e.g., "ABC Properties" vs
  // "ABC Properties Holdings"). Min length 5 to avoid 3-char false positives.
  if (na.length >= 5 && nb.includes(na)) return true;
  if (nb.length >= 5 && na.includes(nb)) return true;
  return false;
}

interface ParentLeaseCandidate {
  id: string;
  request_title: string | null;
  tenant_name: string | null;
  landlord_name: string | null;
  property_address: string | null;
  lifecycle_status: string | null;
  match_score: number;
  match_reasons: string[];
}

async function findParentLeaseCandidates(
  // Passed explicitly because supabaseAdmin is request-scoped (declared
  // inside serve()) — matches the pattern used by resolveAuthorizedWorkspaceId.
  // Other helpers in this file reference module-level supabaseAdmin which
  // has been a latent scope bug; new code uses the safe injection pattern.
  supabaseAdmin: ReturnType<typeof createClient>,
  workspaceId: string,
  extractedJson: Record<string, unknown>,
  currentLeaseId: string,
  maxResults: number = 5,
): Promise<ParentLeaseCandidate[]> {
  const tenantNew   = extractValue(extractedJson?.tenant_name      as any) as string | null;
  const landlordNew = extractValue(extractedJson?.landlord_name    as any) as string | null;
  const propertyNew = extractValue(extractedJson?.property_address as any) as string | null;

  if (!tenantNew && !landlordNew && !propertyNew) return [];

  const { data: candidates, error } = await supabaseAdmin
    .from('leases')
    .select('id, request_title, tenant_name, landlord_name, property_address, lifecycle_status')
    .eq('workspace_id', workspaceId)
    .or('lease_type.is.null,lease_type.eq.master')
    .eq('archived', false)
    .neq('id', currentLeaseId)
    .limit(200);

  if (error || !candidates) {
    console.warn('[Phase3] candidate query failed:', error?.message);
    return [];
  }

  const scored: ParentLeaseCandidate[] = [];
  for (const c of candidates as any[]) {
    const reasons: string[] = [];
    if (fieldsMatch(tenantNew, c.tenant_name)) reasons.push('tenant');
    if (fieldsMatch(landlordNew, c.landlord_name)) reasons.push('landlord');
    if (fieldsMatch(propertyNew, c.property_address)) reasons.push('property');
    if (reasons.length === 0) continue;
    scored.push({
      id: c.id,
      request_title: c.request_title,
      tenant_name: c.tenant_name,
      landlord_name: c.landlord_name,
      property_address: c.property_address,
      lifecycle_status: c.lifecycle_status,
      match_score: reasons.length,
      match_reasons: reasons,
    });
  }

  scored.sort((a, b) => b.match_score - a.match_score);
  return scored.slice(0, maxResults);
}

// Build human-readable mismatch warnings between Haiku's detected
// classification and what the workflow / user already declared.
// Empty array if no mismatch or confidence too low. Surfaced in the
// review UI via extracted_json._tier2_warnings.
function buildTier2Warnings(
  classification: Tier2Classification,
  userLeaseType: string | null,
  existingLeaseAssetType: string | null,
): string[] {
  const warnings: string[] = [];
  if (classification.confidence < TIER2_WARNING_CONFIDENCE_THRESHOLD) return warnings;

  // lease_type mismatch ('master' vs 'amendment')
  if (
    classification.lease_type &&
    userLeaseType &&
    classification.lease_type !== userLeaseType
  ) {
    if (classification.lease_type === 'amendment' && userLeaseType === 'master') {
      warnings.push(
        'This document references an existing lease and looks like an amendment, but it was uploaded as a master lease. Confirm before finalizing.',
      );
    } else if (classification.lease_type === 'master' && userLeaseType === 'amendment') {
      warnings.push(
        'This document looks like a standalone master lease, but it was uploaded as an amendment. Confirm the parent-lease relationship before finalizing.',
      );
    }
  }

  // asset_type mismatch (only meaningful when we have an existing
  // workflow-set asset_type to compare against)
  if (
    classification.asset_type &&
    existingLeaseAssetType &&
    classification.asset_type !== existingLeaseAssetType
  ) {
    const friendly = (raw: string) =>
      raw === 'real_estate' ? 'real estate'
      : raw === 'equipment' ? 'equipment'
      : raw === 'vehicle' ? 'vehicle'
      : raw;
    warnings.push(
      `Lease record is set to ${friendly(existingLeaseAssetType)} but this document looks like a ${friendly(classification.asset_type)} lease. Confirm the asset type before finalizing.`,
    );
  }

  return warnings;
}

const TIER2_CLASSIFY_SYSTEM = `You are a document classifier specialized in commercial leases. Your job is to determine whether the document is a lease (rental agreement for real estate, equipment, or vehicles) or some other type of document.

Return ONLY valid JSON with this exact shape:
{
  "is_lease": boolean,
  "confidence": number,
  "asset_type": "real_estate" | "equipment" | "vehicle" | "other" | null,
  "lease_type": "master" | "amendment" | null,
  "non_lease_reason": string | null
}

GUIDANCE:
- A "lease" is a contract granting one party (lessee/tenant) the right to use property owned by another party (lessor/landlord) in exchange for payment.
- "master" = standalone primary lease. "amendment" = a document that references and modifies a prior lease.
- Asset type: real_estate (offices, warehouses, retail, land), equipment (machinery, IT hardware, copiers), vehicles (cars, trucks, fleet).
- Common NON-leases: invoices, master service agreements (MSAs), NDAs, lease applications (offers to lease, not the lease itself), letters of intent, lease termination/surrender notices, sublease consents, side letters with no lease text, broker agreements, lease audit reports.
- If a document is partially relevant (e.g., an LOI for a future lease, or a surrender notice for an expiring lease), set is_lease=false with a clear reason.
- Confidence reflects your certainty. Use lower values when the document is borderline. False negatives (rejecting a real lease) are worse than false positives — when in doubt, set confidence below 0.85.
- non_lease_reason: ONE short sentence (under 150 chars) that a finance user would understand. Required when is_lease=false; null otherwise.`;

// Phase 4: fetch recent classification corrections for the workspace
// to augment the system prompt as few-shot examples. Per-workspace
// in-context learning at zero retraining cost. Capped at 10 most
// recent corrections to keep prompt size bounded.
const MAX_FEW_SHOT_CORRECTIONS = 10;

interface ClassificationCorrectionRow {
  original_classification: any;
  corrected_classification: any;
  correction_type: string;
  user_note: string | null;
  document_summary: string | null;
}

async function fetchRecentClassificationCorrections(
  supabaseAdmin: ReturnType<typeof createClient>,
  workspaceId: string,
): Promise<ClassificationCorrectionRow[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('classification_corrections')
      .select('original_classification, corrected_classification, correction_type, user_note, document_summary')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(MAX_FEW_SHOT_CORRECTIONS);
    if (error) {
      console.warn('[Phase4] correction fetch failed:', error.message);
      return [];
    }
    return (data ?? []) as ClassificationCorrectionRow[];
  } catch (err) {
    console.warn('[Phase4] correction fetch threw:', err);
    return [];
  }
}

function buildCorrectionsAddendum(corrections: ClassificationCorrectionRow[]): string {
  if (corrections.length === 0) return '';

  const examples = corrections
    .map((c, i) => {
      const orig = c.original_classification ?? {};
      const corr = c.corrected_classification ?? {};
      const docSummary = c.document_summary ? ` (document: "${c.document_summary}")` : '';
      const note = c.user_note ? `\n     Reviewer reasoning: ${c.user_note}` : '';
      return `  ${i + 1}.${docSummary}\n     AI said: ${JSON.stringify({
        is_lease: orig.is_lease,
        asset_type: orig.asset_type,
        lease_type: orig.lease_type,
      })}\n     Corrected to: ${JSON.stringify({
        is_lease: corr.is_lease,
        asset_type: corr.asset_type,
        lease_type: corr.lease_type,
      })}${note}`;
    })
    .join('\n');

  return `\n\nWORKSPACE CORRECTION HISTORY — recent classifications from this team that reviewers corrected. These reflect this workspace's specific conventions and document patterns. Adjust your judgment for similar documents from this team:\n${examples}\n`;
}

async function callHaikuForClassification(
  pdfBase64: string,
  // Optional: when provided, recent corrections from this workspace
  // are fetched and injected as few-shot examples. Per-workspace
  // in-context learning. supabaseAdmin is required for the lookup;
  // when omitted, classification proceeds without history.
  supabaseAdmin: ReturnType<typeof createClient> | null = null,
  workspaceId: string | null = null,
): Promise<Tier2Classification> {
  console.log('[Haiku:classify] Running Tier 2 classification...');

  let systemPrompt = TIER2_CLASSIFY_SYSTEM;
  if (supabaseAdmin && workspaceId) {
    const corrections = await fetchRecentClassificationCorrections(supabaseAdmin, workspaceId);
    if (corrections.length > 0) {
      systemPrompt = systemPrompt + buildCorrectionsAddendum(corrections);
      console.log(`[Haiku:classify] Augmented prompt with ${corrections.length} workspace corrections`);
    }
  }

  const content = await callAnthropicAPIWithPDF(
    'claude-haiku-4-5-20251001',
    systemPrompt,
    pdfBase64,
    'Classify this document and return the JSON.',
    256,
    30_000,
  );

  try {
    const parsed = await repairJsonObject(content) as any;
    const result: Tier2Classification = {
      is_lease: typeof parsed.is_lease === 'boolean' ? parsed.is_lease : true,
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0,
      asset_type:
        ['real_estate', 'equipment', 'vehicle', 'other'].includes(parsed.asset_type)
          ? parsed.asset_type
          : null,
      lease_type:
        ['master', 'amendment'].includes(parsed.lease_type)
          ? parsed.lease_type
          : null,
      non_lease_reason: typeof parsed.non_lease_reason === 'string'
        ? parsed.non_lease_reason.slice(0, 200)
        : null,
    };
    console.log('[Haiku:classify]', JSON.stringify(result));
    return result;
  } catch (error) {
    // On parse failure, fail open (treat as lease, log) rather than
    // blocking a real upload. Subsequent extraction will catch any
    // genuine non-lease via empty fields.
    console.error('[Haiku:classify] Parse failed, failing open:', error);
    return {
      is_lease: true,
      confidence: 0,
      asset_type: null,
      lease_type: null,
      non_lease_reason: null,
    };
  }
}

async function callHaikuForPageMap(pdfBase64: string): Promise<PageMap> {
  console.log('[Haiku] Building page map from native PDF...');
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

  const content = await callAnthropicAPIWithPDF(
    'claude-haiku-4-5-20251001',
    system,
    pdfBase64,
    'Read this lease document and return the page map JSON.',
    1024,
    30_000,
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
      total_pages: typeof parsed.total_pages === 'number' ? parsed.total_pages : 1,
    };
  } catch (error) {
    console.error('[Haiku] Page map parse failed, using full-document fallback:', error);
    return { parties: [], financials: [], escalation: [], renewal: [], termination: [], covenants: [], key_dates: [], total_pages: 1 };
  }
}

function slicePagesByNumbers(documentText: string, pageNumbers: number[]): string {
  if (pageNumbers.length === 0) return documentText;
  const pageSet = new Set(pageNumbers);
  const segments = documentText.split(/(\[PAGE \d+\])/);
  let result = '';
  let currentPage = 1;
  let inTarget = pageSet.has(1);
  for (const segment of segments) {
    const m = segment.match(/\[PAGE (\d+)\]/);
    if (m) {
      currentPage = parseInt(m[1]);
      inTarget = pageSet.has(currentPage);
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

const COMBINED_SYSTEM = `You are an expert commercial lease abstraction specialist and risk analyst. Extract all fields from the provided lease document in a single pass.

TERM MAPPINGS:
- "Base Rent" / "Minimum Rent" / "Fixed Rent" / "Monthly Rent" → current_monthly_rent
- "Commencement Date" / "Effective Date" / "Start Date" → lease_start
- "Expiration Date" / "Termination Date" / "End Date" / "Term End" → lease_end
- "Landlord" / "Lessor" / "Owner" (interchangeable)
- "Tenant" / "Lessee" / "Renter" (interchangeable)
- "Premises" / "Demised Premises" / "Leased Premises" → property_address
- "NRA" / "Rentable Square Feet" / "RSF" → square_footage
- "Security Deposit" / "Damage Deposit" / "Good Faith Deposit"
- "CPI" / "Consumer Price Index" / "inflation-based" → index escalation
- "Fixed Increase" / "Step Rent" / "3% annual" → percent escalation
- "Option to Renew" / "Extension Option" → renewal_options
- "Early Termination" / "Break Clause" → termination_clauses
- "Permitted Use" / "Use Clause" / "Permitted Purpose" → permitted_use
- "Insurance" / "Required Coverage" / "Tenant Insurance" → insurance_requirements
- "Repairs and Maintenance" / "Maintenance Obligations" → maintenance_responsibilities
- "Holdover" / "Holding Over" / "Tenancy at Sufferance" → holdover_terms
- "Assignment" / "Sublease" / "Sublet" / "Transfer" → assignment_consent
- "Personal Guaranty" / "Guarantor" / "Corporate Guaranty" → personal_guarantees
- "Estoppel Certificate" / "SNDA" / "Subordination" / "Non-Disturbance" → estoppel_snda

RULES:
1. Extract ONLY what is explicitly stated. NEVER guess or infer.
2. If not found: value null, confidence 0.0
3. Dates in YYYY-MM-DD. Numbers without $ or commas.
4. If multiple rent periods exist, extract ALL in rent_schedule.
5. DO NOT confuse security deposit with first month's rent.
6. DO NOT use placeholder dates like TBD.
7. Prefer rentable/RSF square footage over usable.
8. DO NOT default CPI/index leases to a percent — describe them as index-based.

RISK FLAGS TO IDENTIFY:
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
  "landlord_name": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "tenant_name": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "property_address": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "lease_start": {"value": "YYYY-MM-DD|null","confidence":0.0,"page":1,"source_text":"quote"},
  "lease_end": {"value": "YYYY-MM-DD|null","confidence":0.0,"page":1,"source_text":"quote"},
  "square_footage": {"value": null,"confidence":0.0,"page":1,"source_text":"quote"},
  "current_monthly_rent": {"value": null,"confidence":0.0,"page":1,"source_text":"quote"},
  "rent_commencement_date": {"value": "YYYY-MM-DD|null","confidence":0.0,"page":1,"source_text":"quote"},
  "base_rent_amount": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "base_rent_frequency": {"value": "monthly|quarterly|annually|null","confidence":0.0,"page":1,"source_text":"quote"},
  "security_deposit": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "rent_escalation_type": {"value": "e.g. '3% annual'|'CPI adjustment'|'None'|null","confidence":0.0,"page":1,"source_text":"quote"},
  "escalation_clauses": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "renewal_options": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "termination_clauses": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "permitted_use": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "insurance_requirements": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "maintenance_responsibilities": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "holdover_terms": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "assignment_consent": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "personal_guarantees": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "estoppel_snda": {"value": "string|null","confidence":0.0,"page":1,"source_text":"quote"},
  "rent_schedule": [{"period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD|null","monthly_amount":null,"annual_amount":null,"notes":"string","confidence":0.0}],
  "key_dates": [{"date":"YYYY-MM-DD","description":"string","confidence":0.0}],
  "risks": [{"title":"string","severity":"low|medium|high","explanation":"string","citation_snippet":"quote","citation_page":1,"confidence":0.0}],
  "uncertain_fields": ["list field names where you encountered ambiguous, cross-referenced, or multi-hop language — e.g. 'escalation_clauses', 'renewal_options', 'termination_clauses', 'risks'"],
  "complex_clause_flags": ["list complex clause types identified — e.g. 'percentage_rent', 'snda_provision', 'ground_rent', 'sale_leaseback', 'cpi_floor_cap', 'exhibit_cross_reference', 'personal_guarantee']"
}`;

// System prompt for the conditional Opus pass — targets only uncertain/complex fields
const OPUS_TARGETED_SYSTEM = `You are an expert commercial lease abstraction specialist. A prior extraction pass has already captured most lease fields. Your task is to re-examine ONLY the fields explicitly listed in the user prompt, which had low confidence or complex language.

Apply maximum precision. For each field requested:
- Read the relevant clause language carefully, including any cross-references to exhibits or addendums
- Resolve ambiguous language (e.g. CPI floor/cap mechanics, multi-hop references, percentage rent formulas)
- If a field genuinely cannot be determined, return null — do not guess

Return ONLY valid JSON using the same schema as the original extraction (each field as {value, confidence, page, source_text}). Include only the fields explicitly listed in the prompt, plus an updated "risks" array if complex clause types were flagged.`;

// Fields that can have low confidence and trigger Opus fallback
const OPUS_FALLBACK_FIELDS = [
  'escalation_clauses',
  'rent_escalation_type',
  'renewal_options',
  'termination_clauses',
  'security_deposit',
  'permitted_use',
  'insurance_requirements',
  'maintenance_responsibilities',
];

function getUncertainFields(merged: any, threshold: number): string[] {
  return OPUS_FALLBACK_FIELDS.filter(field => {
    const fieldData = merged[field];
    if (!fieldData || typeof fieldData !== 'object') return false;
    const conf = fieldData.confidence;
    // Only flag if a value was extracted but with low confidence (ambiguous, not just missing)
    return typeof conf === 'number' && conf < threshold && extractValue(fieldData) !== null;
  });
}

function mergeOpusOverrides(sonnetMerged: any, opusMerged: any, targetFields: string[], hadComplexFlags: boolean): void {
  for (const field of targetFields) {
    if (opusMerged[field] !== undefined && extractValue(opusMerged[field]) !== null) {
      const opusConf = opusMerged[field]?.confidence ?? 0;
      const sonnetConf = sonnetMerged[field]?.confidence ?? 0;
      // Only override if Opus is more confident
      if (opusConf >= sonnetConf) {
        sonnetMerged[field] = opusMerged[field];
        console.log(`[Claude] Opus override: ${field} (${sonnetConf.toFixed(2)} → ${opusConf.toFixed(2)})`);
      }
    }
  }
  // Override risks when complex clause flags triggered the call — Opus risk analysis is deeper
  if (hadComplexFlags && opusMerged.risks && opusMerged.risks.length > 0) {
    sonnetMerged.risks = opusMerged.risks;
    console.log(`[Claude] Opus risks override: ${opusMerged.risks.length} risks`);
  }
}

/**
 * Privacy gate. Reads profiles.ai_processing_consent_at for the calling
 * user; throws if null. Signup records consent automatically, so all
 * current users have it — but a revoke flow exists in Settings → Privacy
 * and that revoke must block subsequent extractions.
 */
/**
 * MIRROR of _shared/audit.ts:assertAiConsent — kept here as a throw-based
 * variant because process_lease's main flow wraps everything in a single
 * try/catch and formats errors uniformly. The shared helper returns a
 * Response which is the right shape for the other 4 AI functions
 * (ai-assistant, retry_lease) that are built
 * around early-return-Response control flow.
 *
 * If you change consent semantics (column name, error message), update
 * BOTH this function AND _shared/audit.ts:assertAiConsent.
 *
 * supabaseAdmin is passed explicitly because it's request-scoped (declared
 * inside serve()). Verified empirically by a Deno scope test (2026-05-08).
 */
async function assertAiConsent(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('ai_processing_consent_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('[process_lease] consent check failed:', error.message);
    throw new Error('Could not verify AI processing consent');
  }
  if (!data?.ai_processing_consent_at) {
    throw new Error(
      'AI processing consent has not been granted. Re-enable consent in Settings → Privacy before uploading documents.'
    );
  }
}

/**
 * P1-03 backend quota gate. Enforces:
 *   - active_leases cap (only when isNewLease=true; re-extracting an
 *     existing lease doesn't add to the active count)
 *   - monthly_extractions cap (always; an extraction always costs AI)
 *
 * Limits mirror src/config/pricing.ts. starter: 15 active / 15 mo.
 * business: 50 active / 50 mo. Unknown/null plan defaults to starter.
 *
 * Returns a 402 Payment Required response when the workspace would
 * exceed the cap, with a structured body the frontend renders as an
 * upgrade prompt. Returns null when the call may proceed.
 *
 * "Monthly" = trailing 30 days, matching the soft-quota poller in
 * _shared/monitoring/workspace_quotas.ts. Uses leases.uploaded_at —
 * leases.created_at does not exist on this schema.
 */
interface PlanQuotaLimits {
  active_leases: number;
  monthly_extractions: number;
}
const PLAN_QUOTAS: Record<string, PlanQuotaLimits> = {
  starter:  { active_leases: 15, monthly_extractions: 15 },
  business: { active_leases: 50, monthly_extractions: 50 },
};

async function assertProcessingQuota(
  supabaseAdmin: ReturnType<typeof createClient>,
  workspaceId: string | null,
  corsHeaders: Record<string, string>,
  opts: { isNewLease: boolean },
): Promise<Response | null> {
  if (!workspaceId) return null;

  const { data: ws } = await supabaseAdmin
    .from('workspaces')
    .select('plan, addon_document_capacity')
    .eq('id', workspaceId)
    .maybeSingle();
  const plan = ((ws as { plan?: string } | null)?.plan === 'business') ? 'business' : 'starter';
  const base = PLAN_QUOTAS[plan];

  // Document packs raise BOTH the monthly-abstraction allowance and the
  // active-lease cap by the workspace's total active pack capacity (written
  // only by the Stripe webhook, guarded by the #29 entitlement trigger).
  // Defensive: clamp to >= 0 so a bad value can never shrink the base cap.
  const addon = Math.max(0, Number((ws as { addon_document_capacity?: number } | null)?.addon_document_capacity ?? 0));
  const limits = {
    active_leases: base.active_leases + addon,
    monthly_extractions: base.monthly_extractions + addon,
  };

  // Monthly extractions — always checked.
  const since30dIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count: monthlyExtractionCount, error: extractionErr } = await supabaseAdmin
    .from('leases')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('uploaded_at', since30dIso)
    .not('extracted_json', 'is', null);
  if (extractionErr) {
    console.error('[process_lease] quota: extraction count failed:', extractionErr.message);
    // Fail open on a count error — same posture as the rate-limit
    // helper. We don't want a transient DB blip to block paying
    // customers; the soft-quota dashboard catches drift over time.
    return null;
  }
  const monthlyExtractions = monthlyExtractionCount ?? 0;
  const overMonthly = monthlyExtractions >= limits.monthly_extractions;

  // Active leases — only for genuinely new uploads. Re-extracting an
  // executed document on an existing lease doesn't add to the count.
  let overActive = false;
  let active = 0;
  if (opts.isNewLease) {
    const { count: activeCount, error: activeErr } = await supabaseAdmin
      .from('leases')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('lifecycle_status', 'active')
      .eq('archived', false);
    if (activeErr) {
      console.error('[process_lease] quota: active count failed:', activeErr.message);
      return null;
    }
    active = activeCount ?? 0;
    overActive = active >= limits.active_leases;
  }

  if (overMonthly || overActive) {
    // A purchased single-lease credit ("buy 1 lease" at the overage rate)
    // covers this ONE upload through both caps. consume_lease_credit is an
    // atomic claim (UPDATE guarded by > 0, service_role-only RPC), so two
    // concurrent uploads can never spend the same credit. Exactly one credit
    // is spent per upload regardless of which cap(s) tripped.
    const { data: claimed, error: claimErr } = await supabaseAdmin.rpc(
      'consume_lease_credit',
      { p_workspace_id: workspaceId },
    );
    if (claimErr) {
      console.error('[process_lease] quota: credit claim failed:', claimErr.message);
      // Fall through to the block response — never extract unpaid over-cap.
    } else if (claimed === true) {
      console.log(`[process_lease] quota: single-lease credit consumed for ${workspaceId}`);
      return null;
    }

    // 200 + structured body, same pattern as tier2_classification_failed —
    // the frontend's `supabase.functions.invoke` swallows non-2xx into a
    // generic FunctionsHttpError, but parses the body cleanly on 200.
    const body = overMonthly
      ? {
          ok: false,
          error: `This workspace has reached its monthly AI extraction limit (${limits.monthly_extractions}/mo on ${plan}). Buy more capacity or wait for the rolling 30-day window to roll over.`,
          reason: 'quota_exceeded',
          metric: 'monthly_extractions',
          plan,
          current: monthlyExtractions,
          limit: limits.monthly_extractions,
        }
      : {
          ok: false,
          error: `This workspace has reached its active-lease limit (${limits.active_leases} on ${plan}). Archive an existing lease or buy more capacity before uploading more.`,
          reason: 'quota_exceeded',
          metric: 'active_leases',
          plan,
          current: active,
          limit: limits.active_leases,
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return null;
}

async function extractLeaseDataWithClaude(
  // See assertAiConsent docstring — supabaseAdmin is request-scoped
  // and must be passed explicitly. The internal risk_templates lookup
  // below references it; without this parameter the reference would
  // ReferenceError (silently caught by the try/catch around the
  // lookup, with the side-effect of always running extraction
  // without the workspace-specific risk watchlist).
  supabaseAdmin: ReturnType<typeof createClient>,
  pdfBase64: string,
  workspaceId: string | null = null,
  // Return type is a permissive Record because Opus extracts 7+
  // additional clause fields (permitted_use, insurance_requirements,
  // maintenance_responsibilities, holdover_terms, assignment_consent,
  // personal_guarantees, estoppel_snda, complex_clause_flags,
  // uncertain_fields) plus 3 forensic underscore fields
  // (_haiku_warnings, _extraction_model, _haiku_page_map) that the
  // strict LeaseExtractionResult type doesn't model. The previous
  // destructured return dropped all of them silently — paying Opus
  // for data we then threw away. Downstream code uses extractValue()
  // and field-shape-agnostic access, so the wider type is safe.
): Promise<Record<string, any>> {
  console.log('[Claude] Starting two-pass native-PDF extraction...');
  const extractionStart = Date.now();

  // Pass 1: Haiku page map (native PDF)
  const pageMap = await callHaikuForPageMap(pdfBase64);

  // Build page groups with ±1 buffer
  const { groupA, groupB, groupC } = buildPageGroups(pageMap);
  console.log(`[Claude] Groups — A:${groupA.length}pp B:${groupB.length}pp C:${groupC.length}pp total:${pageMap.total_pages}`);

  // Combine all page hints into a single focus instruction
  const allPages = [...new Set([...groupA, ...groupB, ...groupC])].sort((a, b) => a - b);
  const focusHint = allPages.length > 0 ? ` Key pages identified: ${allPages.join(', ')}.` : '';

  // Workspace-specific "risk watchlist" — risks the team has flagged as
  // relevant on prior leases get appended to the user prompt so Opus
  // explicitly checks for them in this lease.
  let watchlistHint = '';
  if (workspaceId) {
    try {
      const { data: tmpls } = await supabaseAdmin
        .from('risk_templates')
        .select('title, severity, default_explanation, asset_type')
        .eq('workspace_id', workspaceId)
        .eq('is_system', false);
      if (tmpls && tmpls.length > 0) {
        const lines = tmpls.map((t: any) => `  - [${t.severity}] ${t.title}: ${t.default_explanation}`).join('\n');
        watchlistHint = `\n\nWORKSPACE RISK WATCHLIST — these patterns are explicitly flagged by this team and MUST be checked against this lease. If you find a clause matching any of them, include it in the risks array using the watchlist title verbatim and the supporting source quote:\n${lines}`;
        console.log(`[Claude] Injecting ${tmpls.length} workspace watchlist templates`);
      }
    } catch (err) {
      console.warn('[Claude] Could not fetch workspace risk_templates (continuing without):', (err as Error).message);
    }
  }

  // Pass 2: Opus extraction — single combined call, sends PDF once
  console.log('[Claude] Sending Opus extraction call...');
  const rawCombined = await callAnthropicAPIWithPDF(
    'claude-opus-4-6',
    COMBINED_SYSTEM,
    pdfBase64,
    `Extract all lease terms, clauses, and risks from this document.${focusHint}${watchlistHint}`,
    4096,
    100_000,
  );

  console.log('[Claude] Opus extraction complete, parsing...');

  const merged = await repairJsonObject(rawCombined) as any;

  // Haiku/Opus disagreement warnings
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

  // Default array fields so downstream code that iterates without a
  // null check (rent_schedule.filter, key_dates.map, risks.map)
  // doesn't TypeError when Opus omitted an array entirely.
  if (!Array.isArray(merged.rent_schedule)) merged.rent_schedule = [];
  if (!Array.isArray(merged.key_dates))     merged.key_dates = [];
  if (!Array.isArray(merged.risks))         merged.risks = [];

  return merged;
}

// Legacy stub — unused, retained for reference only. Signature kept
// loose; if ever called, the module-level supabaseAdmin reference
// inside extractLeaseDataWithClaude would have already thrown, which
// is the existing dead-code-path behavior.
async function _extractLeaseDataWithOpenAI_STUB(pdfBase64: string): Promise<LeaseExtractionResult> {
  // @ts-expect-error — legacy stub; supabaseAdmin would be undefined here
  return extractLeaseDataWithClaude(undefined, pdfBase64);
}

// Original OpenAI implementation below — retained for reference, not called
async function _extractLeaseDataWithOpenAI_DEPRECATED(documentText: string): Promise<LeaseExtractionResult> {
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

  async function extractJsonFromResponse(content: string): Promise<object> {
    try {
      return await repairJsonObject(content);
    } catch (error) {
      console.error('[OpenAI] JSON repair failed:', error);
      console.error('[OpenAI] Failed content preview:', content.substring(0, 500));
      throw error;
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
          max_tokens: OPENAI_MAX_TOKENS,
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
      console.log(`[OpenAI] Tokens - prompt: ${data.usage?.prompt_tokens || 'N/A'}, completion: ${data.usage?.completion_tokens || 'N/A'}`);
      try {
        const parsed = await extractJsonFromResponse(content);
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
  const requestOrigin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(requestOrigin);

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
    const rawParentLeaseId = formData.get('parentLeaseId') as string | null;
    // Phase 5: when set to 'true', skip the Tier 2 hard-gate. Used by
    // the LeaseUploadModal "Override and proceed" path after a
    // tier2_classification_failed rejection. Records an
    // is_lease_override correction so future classifications for this
    // workspace learn from the disagreement.
    const forceTier2Override = formData.get('forceTier2Override') === 'true';
    const parentLeaseId = rawParentLeaseId?.trim() || null;
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
        .select('id, user_id, workspace_id, lifecycle_status, current_monthly_rent, monthly_payment, lease_start, lease_end, tenant_name, landlord_name, model_locked, asset_type')
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
          if (!roleData || !['financial_approver', 'admin'].includes(roleData.role)) {
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

      const rateLimitResponse = await enforceWorkspaceRateLimit(
        supabaseAdmin,
        existingLease.workspace_id,
        'process_lease',
        requestOrigin,
      );
      if (rateLimitResponse) return rateLimitResponse;

      // P1-03 quota gate on executed-upload path: only monthly extraction
      // cap applies (the underlying lease already exists).
      const quotaResp = await assertProcessingQuota(
        supabaseAdmin,
        existingLease.workspace_id,
        corsHeaders,
        { isNewLease: false },
      );
      if (quotaResp) return quotaResp;

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

      const executedPdfBase64 = arrayBufferToBase64(fileBytes);
      console.log('[process_lease] Executed: PDF encoded for native extraction');

      // Privacy gate before invoking AI extraction.
      await assertAiConsent(supabaseAdmin, user.id);

      // Tier 2 gate on the executed-document path. Same threshold and
      // fail-open semantics as the new-upload path. Catches users who
      // accidentally upload an MSA / invoice / wrong PDF as their
      // "final executed lease" — saves the Opus extraction cost and
      // gives a clear error before the workspace member realizes the
      // upload was a mistake.
      let executedTier2: Tier2Classification;
      try {
        executedTier2 = await callHaikuForClassification(
          executedPdfBase64,
          supabaseAdmin,
          existingLease.workspace_id ?? null,
        );
      } catch (err) {
        console.warn('[process_lease] Executed-path Tier 2 classification failed, failing open:', err);
        executedTier2 = {
          is_lease: true,
          confidence: 0,
          asset_type: null,
          lease_type: null,
          non_lease_reason: null,
        };
      }

      if (
        executedTier2.is_lease === false &&
        executedTier2.confidence > TIER2_REJECT_CONFIDENCE_THRESHOLD
      ) {
        const reason = executedTier2.non_lease_reason || 'Document does not appear to be a lease.';
        console.log(`[process_lease] Executed-path Tier 2 rejected lease ${targetLeaseId}: ${reason}`);

        try {
          const { error: activityErr } = await supabaseAdmin.from('lease_activity_log').insert({
            lease_id: targetLeaseId,
            user_id: user.id,
            activity_type: 'tier2_classification_rejected',
            details: {
              classification: executedTier2,
              threshold: TIER2_REJECT_CONFIDENCE_THRESHOLD,
              path: 'executed',
            },
          });
          if (activityErr) {
            console.warn('[process_lease] Executed-path Tier 2 activity-log insert failed:', activityErr.message);
          }
        } catch (e) {
          console.warn('[process_lease] Executed-path Tier 2 activity-log insert threw:', e);
        }

        // Note: do NOT mark the existing lease 'Failed' — the in-flight
        // lease should remain workable; only the executed-upload step
        // is rejected. User can retry with the correct PDF.
        return new Response(JSON.stringify({
          ok: false,
          error: `This document doesn't appear to be a lease. ${reason}`,
          reason: 'tier2_classification_failed',
          detail: reason,
          classification: executedTier2,
          leaseId: targetLeaseId,
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let leaseData: LeaseExtractionResult;
      try {
        leaseData = await extractLeaseDataWithClaude(supabaseAdmin, executedPdfBase64, existingLease.workspace_id ?? null);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Executed AI extraction failed: ${msg}`);
      }

      // Stamp Tier 2 classification + warnings onto the executed
      // extraction result so the review UI surfaces mismatches.
      (leaseData as any)._tier2_classification = executedTier2;
      const executedWarnings = buildTier2Warnings(
        executedTier2,
        null, // executed path doesn't carry a user-declared leaseType (the lease was already created)
        existingLease.asset_type ?? null,
      );
      if (executedWarnings.length > 0) {
        (leaseData as any)._tier2_warnings = executedWarnings;
        console.log('[process_lease] Executed-path Tier 2 warnings:', executedWarnings);
      }

      // Best-effort passed activity log
      try {
        const { error: activityErr } = await supabaseAdmin.from('lease_activity_log').insert({
          lease_id: targetLeaseId,
          user_id: user.id,
          activity_type: 'tier2_classification_passed',
          details: { classification: executedTier2, path: 'executed', warnings: executedWarnings },
        });
        if (activityErr) {
          console.warn('[process_lease] Executed-path Tier 2 passed activity-log insert failed:', activityErr.message);
        }
      } catch (e) {
        console.warn('[process_lease] Executed-path Tier 2 passed activity-log insert threw:', e);
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
        if (conf !== null) executedConfidence[key] = normalizeConfidenceScore(conf);
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

    if (leaseType === 'amendment' && !parentLeaseId) {
      return new Response(JSON.stringify({ error: 'parentLeaseId is required for amendment uploads.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (leaseType === 'master' && parentLeaseId) {
      return new Response(JSON.stringify({ error: 'parentLeaseId is only allowed for amendment uploads.' }), {
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

    let resolvedWorkspaceId: string | null;
    try {
      resolvedWorkspaceId = await resolveAuthorizedWorkspaceId(
        supabaseAdmin,
        user.id,
        workspaceIdFromRequest,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Workspace validation failed.';
      const status = errorMessage === 'Invalid workspace ID format.'
        ? 400
        : errorMessage === 'Unauthorized workspace access.'
        ? 403
        : 500;
      return new Response(JSON.stringify({ error: errorMessage }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    console.log(`[process_lease] Resolved workspace_id: ${resolvedWorkspaceId}`);

    if (!resolvedWorkspaceId) {
      return jsonResponse(
        { error: 'No workspace found. Please complete account setup before uploading.' },
        400,
        requestOrigin,
      );
    }

    let parentLeaseForComparison: { extracted_json: Record<string, unknown> | null } | null = null;
    if (parentLeaseId) {
      const { data: parentLease, error: parentLeaseError } = await supabaseAdmin
        .from('leases')
        .select('id, workspace_id, lifecycle_status, extracted_json')
        .eq('id', parentLeaseId)
        .eq('workspace_id', resolvedWorkspaceId)
        .maybeSingle();

      if (parentLeaseError) {
        return new Response(JSON.stringify({ error: `Failed to validate parent lease: ${parentLeaseError.message}` }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!parentLease) {
        return new Response(JSON.stringify({ error: 'Parent lease not found in the selected workspace.' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if ((parentLease as any).lifecycle_status !== 'active') {
        return new Response(JSON.stringify({ error: 'Parent lease must be active before uploading an amendment.' }), {
          status: 422,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      parentLeaseForComparison = {
        extracted_json: ((parentLease as any).extracted_json ?? null) as Record<string, unknown> | null,
      };
    }

    const rateLimitResponse = await enforceWorkspaceRateLimit(
      supabaseAdmin,
      resolvedWorkspaceId,
      'process_lease',
      requestOrigin,
    );
    if (rateLimitResponse) return rateLimitResponse;

    // P1-03 quota gate on new-upload path: both active-lease cap and
    // monthly extraction cap apply. Runs BEFORE storage upload + AI
    // calls so the workspace sees an upgrade prompt instead of a
    // partially-created record.
    const quotaResp = await assertProcessingQuota(
      supabaseAdmin,
      resolvedWorkspaceId,
      corsHeaders,
      { isNewLease: true },
    );
    if (quotaResp) return quotaResp;

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

    const pdfBase64 = arrayBufferToBase64(fileBytes);
    console.log('[process_lease] PDF encoded for native Claude extraction');

    // Privacy gate before invoking AI extraction.
    await assertAiConsent(supabaseAdmin, user.id);

    // ── Tier 2 classification (hard gate) ─────────────────────────
    // Cheap Haiku call before Tier 1 to short-circuit non-lease
    // uploads (invoices, MSAs, NDAs, etc.) at ~$0.01 instead of
    // burning $0.50+ on Opus extraction. Threshold 0.85 — false
    // negatives are worse than false positives. Phases 2-5 add
    // soft warnings, parent-lease detection, override + corrections.
    let tier2Classification: Tier2Classification;
    try {
      tier2Classification = await callHaikuForClassification(
        pdfBase64,
        supabaseAdmin,
        resolvedWorkspaceId ?? null,
      );
    } catch (err) {
      // Network or API failure on the classification call — fail
      // open. Tier 1 will run and catch genuine non-leases via
      // empty fields. Don't block the user on a Haiku outage.
      console.warn('[process_lease] Tier 2 classification failed, failing open:', err);
      tier2Classification = {
        is_lease: true,
        confidence: 0,
        asset_type: null,
        lease_type: null,
        non_lease_reason: null,
      };
    }

    if (
      tier2Classification.is_lease === false &&
      tier2Classification.confidence > TIER2_REJECT_CONFIDENCE_THRESHOLD &&
      !forceTier2Override
    ) {
      const reason = tier2Classification.non_lease_reason || 'Document does not appear to be a lease.';
      console.log(`[process_lease] Tier 2 rejected lease ${leaseId}: ${reason}`);

      await supabaseAdmin.from('leases').update({
        status: 'Failed',
        error_message: `[Tier 2] ${reason}`,
      }).eq('id', leaseId);

      // Activity-log insert is best-effort. The CHECK constraint
      // requires migration 20260507240000 — until that's applied to
      // live, the insert will fail (CHECK violation). Don't block
      // the rejection response on it.
      try {
        const { error: activityErr } = await supabaseAdmin.from('lease_activity_log').insert({
          lease_id: leaseId,
          user_id: user.id,
          activity_type: 'tier2_classification_rejected',
          details: {
            classification: tier2Classification,
            threshold: TIER2_REJECT_CONFIDENCE_THRESHOLD,
          },
        });
        if (activityErr) {
          console.warn('[process_lease] Tier 2 rejection activity-log insert failed (migration likely not applied):', activityErr.message);
        }
      } catch (e) {
        console.warn('[process_lease] Tier 2 rejection activity-log insert threw:', e);
      }

      // Status 200 (not 422) so supabase-js surfaces the body via
      // `data` instead of swallowing the message into a generic
      // FunctionsHttpError. The frontend (LeaseUploadModal etc.)
      // already checks `result?.error` and throws with the message —
      // matches the pattern used by create-checkout and other
      // user-facing edge functions in this codebase.
      return new Response(JSON.stringify({
        ok: false,
        error: `This document doesn't appear to be a lease. ${reason}`,
        reason: 'tier2_classification_failed',
        detail: reason,
        classification: tier2Classification,
        leaseId,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Passed the gate (or failed open due to Haiku outage). Log it
    // best-effort — see migration-drift note above.
    try {
      const { error: activityErr } = await supabaseAdmin.from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: 'tier2_classification_passed',
        details: { classification: tier2Classification },
      });
      if (activityErr) {
        console.warn('[process_lease] Tier 2 passed activity-log insert failed (migration likely not applied):', activityErr.message);
      }
    } catch (e) {
      console.warn('[process_lease] Tier 2 passed activity-log insert threw:', e);
    }

    let leaseData: LeaseExtractionResult;
    try {
      leaseData = await extractLeaseDataWithClaude(supabaseAdmin, pdfBase64, resolvedWorkspaceId ?? null);
      console.log('[process_lease] Lease data extracted successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabaseAdmin.from('leases').update({ status: 'Failed', error_message: `AI extraction failed: ${errorMessage}` }).eq('id', leaseId);
      throw error;
    }

    // Stamp the Tier 2 classification + soft warnings onto the
    // extracted JSON for forensics + review UI surfacing + Phase 4
    // correction-recording.
    (leaseData as any)._tier2_classification = tier2Classification;
    const tier2Warnings = buildTier2Warnings(
      tier2Classification,
      leaseType, // user-declared via FormData ('master' | 'amendment')
      // New-upload path doesn't have an existingLease asset_type to
      // compare against (the lease row was just created); pass null
      // so only lease_type mismatch warnings surface here. Asset-type
      // mismatch detection runs on the executed path.
      null,
    );
    if (tier2Warnings.length > 0) {
      (leaseData as any)._tier2_warnings = tier2Warnings;
      console.log('[process_lease] Tier 2 warnings:', tier2Warnings);
    }

    // ── Phase 3: parent-lease auto-detection ──────────────────────
    // If this upload is an amendment (declared by user OR detected by
    // Haiku with sufficient confidence), search the workspace for
    // candidate parent leases by matching tenant + landlord + property.
    // Surfaces in the review UI; the user remains the authority on
    // which parent (if any) is correct.
    const looksLikeAmendment =
      leaseType === 'amendment' ||
      (tier2Classification.lease_type === 'amendment' &&
        tier2Classification.confidence > TIER2_WARNING_CONFIDENCE_THRESHOLD);

    if (looksLikeAmendment && resolvedWorkspaceId) {
      try {
        const candidates = await findParentLeaseCandidates(
          supabaseAdmin,
          resolvedWorkspaceId,
          leaseData as unknown as Record<string, unknown>,
          leaseId,
        );
        if (candidates.length > 0) {
          (leaseData as any)._parent_lease_candidates = candidates;
          console.log(`[process_lease] Phase 3: ${candidates.length} parent-lease candidates found`);
        }
      } catch (err) {
        console.warn('[process_lease] Phase 3 parent-lease search failed:', err);
      }
    }

    // ── Phase 5: record is_lease_override correction ──────────────
    // When the user overrode a Tier 2 hard-rejection ("I disagree,
    // this IS a lease"), record the correction now that the
    // extraction has succeeded. Feeds Phase 4's in-context-learning
    // loop — future Haiku classifications for this workspace will
    // see this as a few-shot example and adjust accordingly.
    if (forceTier2Override && resolvedWorkspaceId) {
      try {
        const { error: corrErr } = await supabaseAdmin
          .from('classification_corrections')
          .insert({
            workspace_id: resolvedWorkspaceId,
            lease_id: leaseId,
            original_classification: tier2Classification,
            corrected_classification: { is_lease: true },
            correction_type: 'is_lease_override',
            user_note: null,
            document_summary: sanitizedFilename,
            corrected_by: user.id,
          });
        if (corrErr) {
          console.warn('[process_lease] Phase 5 override correction insert failed:', corrErr.message);
        } else {
          console.log('[process_lease] Phase 5: is_lease_override correction recorded for future learning');
        }
        // Best-effort activity log
        const { error: actErr } = await supabaseAdmin.from('lease_activity_log').insert({
          lease_id: leaseId,
          user_id: user.id,
          activity_type: 'tier2_classification_overridden',
          details: {
            classification: tier2Classification,
            forced: true,
          },
        });
        if (actErr) {
          console.warn('[process_lease] Phase 5 activity log insert failed:', actErr.message);
        }
      } catch (e) {
        console.warn('[process_lease] Phase 5 override recording threw:', e);
      }
      (leaseData as any)._tier2_override = true;
    }

    const { warnings: validationWarnings, suggestions: validationSuggestions } = validateLeaseData(leaseData);
    if (validationWarnings.length > 0) {
      console.log('[process_lease] Validation warnings:', validationWarnings);
      (leaseData as any)._validation_warnings = validationWarnings;
      (leaseData as any)._validation_suggestions = validationSuggestions;
    }

    // ----------------------------------------------------------------
    // Amendment comparison — populate _amendment_changes
    // Only runs when this document is an amendment to an existing lease.
    // ----------------------------------------------------------------
    if (parentLeaseForComparison?.extracted_json) {
      try {
        const parentJson = parentLeaseForComparison.extracted_json;
        const COMPARABLE_FIELDS = [
            'landlord_name',
            'tenant_name',
            'property_address',
            'lease_start',
            'lease_end',
            'current_monthly_rent',
            'rent_escalation_type',
            'security_deposit',
            'renewal_options',
            'termination_clauses',
            'escalation_clauses',
            'square_footage',
        ];

        const amendmentChanges: Array<{
          field: string;
          old_value: string | null;
          new_value: string | null;
          change_type: 'modified' | 'added' | 'removed';
        }> = [];

        for (const field of COMPARABLE_FIELDS) {
            const oldRaw = extractValue(parentJson[field]);
            const newRaw = extractValue((leaseData as any)[field]);
            const oldVal = oldRaw != null && String(oldRaw).trim() !== '' ? String(oldRaw).trim() : null;
            const newVal = newRaw != null && String(newRaw).trim() !== '' ? String(newRaw).trim() : null;

            if (oldVal === newVal) continue;
            if (!oldVal && !newVal) continue;

            const change_type: 'modified' | 'added' | 'removed' = !oldVal ? 'added' : !newVal ? 'removed' : 'modified';
            amendmentChanges.push({ field, old_value: oldVal, new_value: newVal, change_type });
        }

        (leaseData as any)._amendment_changes = amendmentChanges;
        console.log(`[process_lease] Amendment comparison: ${amendmentChanges.length} changes detected`);
      } catch (err) {
        // Non-fatal — continue without comparison data
        console.error('[process_lease] Amendment comparison failed:', err instanceof Error ? err.message : err);
      }
    }

    // ----------------------------------------------------------------
    // Step 1 — Escalation normalization
    // Parse rent_escalation_type exactly once here.
    // Downstream code must use escalation_type and escalation_rate only.
    // ----------------------------------------------------------------
    const rawRentEscalationType = extractValue(leaseData.rent_escalation_type) as string | null;
    const { escalationType, escalationRate, needsEscalationReview } = normalizeEscalation(rawRentEscalationType);
    console.log(`[process_lease] Escalation normalized: type=${escalationType}, rate=${escalationRate}, review=${needsEscalationReview}`);

    // Derive term_months from extracted dates
    const extractedStart = safeDate(extractValue(leaseData.lease_start));
    const extractedEnd   = safeDate(extractValue(leaseData.lease_end));
    const termMonths = extractedStart && extractedEnd
      ? Math.round((new Date(extractedEnd).getTime() - new Date(extractedStart).getTime()) / (86400 * 30.4375 * 1000))
      : null;

    // Lifecycle Transition Convention (CLAUDE.md): capture prior status
    // before the UPDATE so we can emit a faithful from/to status_change
    // row; set status_changed_at in the same UPDATE.
    const { data: priorLeaseForLifecycle } = await supabaseAdmin
      .from('leases')
      .select('lifecycle_status')
      .eq('id', leaseId)
      .single();
    const previousLifecycleStatus = (priorLeaseForLifecycle as { lifecycle_status?: string } | null)?.lifecycle_status ?? null;
    const lifecycleChangedAt = new Date().toISOString();

    const { error: updateError } = await supabaseAdmin
      .from('leases')
      .update({
        status: 'Ready',
        lifecycle_status:       'executed',
        status_changed_at:      lifecycleChangedAt,
        parent_lease_id:        parentLeaseId || null,
        landlord_name:          extractValue(leaseData.landlord_name),
        tenant_name:            extractValue(leaseData.tenant_name),
        property_address:       extractValue(leaseData.property_address),
        lease_start:            extractedStart,
        lease_end:              extractedEnd,
        rent_commencement_date: safeDate(extractValue(leaseData.rent_commencement_date)),
        base_rent_amount:       extractValue(leaseData.base_rent_amount),
        base_rent_frequency:    extractValue(leaseData.base_rent_frequency),
        current_monthly_rent:   extractValue(leaseData.current_monthly_rent),
        security_deposit:       extractValue(leaseData.security_deposit),
        renewal_options:        extractValue(leaseData.renewal_options),
        escalation_clauses:     extractValue(leaseData.escalation_clauses),
        termination_clauses:    extractValue(leaseData.termination_clauses),
        rent_escalation_type:   rawRentEscalationType, // stored for reference; use escalation_type downstream
        escalation_type:        escalationType,
        escalation_rate:        escalationRate,
        needs_escalation_review: needsEscalationReview,
        square_footage:         extractValue(leaseData.square_footage),
        term_months:            termMonths,
        extracted_json:         leaseData,
        processed_at:           lifecycleChangedAt,
      })
      .eq('id', leaseId);

    if (updateError) throw new Error(`Failed to update lease: ${updateError.message}`);

    const { error: statusLogError } = await supabaseAdmin.from('lease_activity_log').insert({
      lease_id: leaseId,
      user_id: user.id,
      activity_type: 'status_change',
      from_status: previousLifecycleStatus,
      to_status: 'executed',
      details: {
        from: previousLifecycleStatus,
        to: 'executed',
        routing_path: 'extraction',
        triggered_by: 'process_lease',
      },
    });
    if (statusLogError) console.error('[process_lease] status_change log error:', statusLogError.message);

    // Recalculate financial projections using AI-extracted values so the
    // portfolio numbers stay accurate even when the request form was left blank.
    if (extractedStart && termMonths && termMonths > 0) {
      const rawRent = extractValue(leaseData.current_monthly_rent);
      const monthlyRent = typeof rawRent === 'number'
        ? rawRent
        : typeof rawRent === 'string'
          ? parseFloat(rawRent.replace(/[^0-9.]/g, '')) || 0
          : 0;

      if (monthlyRent > 0) {
        const { data: wsData } = await supabaseAdmin
          .from('workspaces')
          .select('discount_rate')
          .eq('id', resolvedWorkspaceId)
          .single();
        const discountRate: number = (wsData as any)?.discount_rate ?? 5.5;
        const annualEscRate: number = escalationRate ?? 0;

        // Replicate leaseCalculations.ts logic inline (no TS imports in Deno edge fn)
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

        const { error: calcUpdateError } = await supabaseAdmin
          .from('leases')
          .update({
            calc_total_commitment:  Math.round(calcTotalCommitment * 100) / 100,
            calc_pv_liability:      Math.round(calcPvLiability * 100) / 100,
            calc_straight_line_exp: Math.round(calcStraightLineExp * 100) / 100,
            calc_cash_pl_delta:     Math.round(calcCashPlDelta * 100) / 100,
          })
          .eq('id', leaseId);
        if (calcUpdateError) {
          console.error('[process_lease] Failed to update calc fields:', calcUpdateError.message);
        } else {
          console.log(`[process_lease] Recalculated financials: total=${calcTotalCommitment.toFixed(2)}, pv=${calcPvLiability.toFixed(2)}`);
        }
      }
    }

    const fieldsToTrack = ['landlord_name', 'tenant_name', 'property_address', 'lease_start', 'lease_end', 'square_footage', 'current_monthly_rent', 'rent_escalation_type'];
    const confidenceEntries: { lease_id: string; field_name: string; confidence_score: number }[] = [];
    for (const fieldName of fieldsToTrack) {
      const fieldData = (leaseData as any)[fieldName];
      const confidence = extractConfidence(fieldData);
      if (confidence !== null) {
        confidenceEntries.push({
          lease_id: leaseId,
          field_name: fieldName,
          confidence_score: normalizeConfidenceScore(confidence),
        });
      }
    }
    if (confidenceEntries.length > 0) {
      const { error: confError } = await supabaseAdmin.from('lease_field_confidence').upsert(confidenceEntries, { onConflict: 'lease_id,field_name' });
      if (confError) console.error('[process_lease] Confidence insert error:', confError);
      else console.log(`[process_lease] Stored ${confidenceEntries.length} confidence scores`);
    }

    if (leaseData.rent_schedule && leaseData.rent_schedule.length > 0) {
      await supabaseAdmin.from('rent_schedules').delete().eq('lease_id', leaseId);
      const rentScheduleToInsert = leaseData.rent_schedule
        .filter(period => period.period_start)
        .map(period => ({
          lease_id: leaseId,
          period_start: safeDate(period.period_start),
          period_end: safeDate(period.period_end),
          monthly_amount: period.monthly_amount,
          annual_amount:
            period.annual_amount ??
            (period.monthly_amount != null ? Math.round(period.monthly_amount * 12 * 100) / 100 : null),
          notes: period.notes,
        }));
      if (rentScheduleToInsert.length > 0) {
        const { error: rentError } = await supabaseAdmin.from('rent_schedules').insert(rentScheduleToInsert);
        if (rentError) console.error('[process_lease] Rent schedule insert error:', rentError);
        else console.log(`[process_lease] Inserted ${rentScheduleToInsert.length} rent schedule entries`);
      }
    }

    if (leaseData.risks && leaseData.risks.length > 0) {
      await supabaseAdmin.from('risks').delete().eq('lease_id', leaseId);
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

    // Fire-and-forget email notification — never throw
    try {
      const { data: profileData } = await supabaseAdmin
        .from('profiles')
        .select('notify_abstraction_complete, email_notifications_enabled')
        .eq('id', user.id)
        .single();

      if ((profileData as any)?.notify_abstraction_complete && (profileData as any)?.email_notifications_enabled) {
        const { data: authData } = await supabaseAdmin.auth.admin.getUserById(user.id);
        const userEmail = authData?.user?.email;
        if (userEmail) {
          const siteUrl = Deno.env.get('SITE_URL') ?? 'https://theleaseio.com';
          // P2-05: tenant_name + filename come from AI extraction / user
          // upload and can contain arbitrary text. Escape before
          // interpolating into the email HTML body. Subject stays as-is
          // (email clients render subjects as text, not HTML).
          const rawDisplayName = String(extractValue(leaseData.tenant_name) || sanitizedFilename || '');
          const escapeEmailHtml = (s: string) => s.replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
          }[m]!));
          const safeDisplayName = escapeEmailHtml(rawDisplayName);
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
            },
            body: JSON.stringify({
              from: Deno.env.get('RESEND_FROM_EMAIL') ?? 'LeaseIO <noreply@notifications.theleaseio.com>',
              to: [userEmail],
              subject: `${rawDisplayName} is ready for review`,
              html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
                <h2>Lease ready for review</h2>
                <p><strong>${safeDisplayName}</strong> has been abstracted by AI and is ready for your review.</p>
                <p style="margin:24px 0">
                  <a href="${siteUrl}/app/leases/${leaseId}/review"
                     style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px">
                    Review Now →
                  </a>
                </p>
              </div>`,
              text: `${rawDisplayName} is ready for review: ${siteUrl}/app/leases/${leaseId}/review`,
            }),
          });
        }
      }
    } catch (emailErr) {
      console.error('[process_lease] notification email failed:', emailErr);
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
