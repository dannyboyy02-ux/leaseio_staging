import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

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
  const isAllowed = (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) || isLovablePreview;
  const origin = isAllowed ? requestOrigin! : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const ANALYSIS_SYSTEM = `You are a professional commercial real estate analyst writing a lease analysis report for a finance team.

You will receive structured JSON data extracted from a lease. Write concise, professional narrative paragraphs for each section below. Write in third person. Use plain financial language — no jargon, no legalese.

Rules:
- Base every statement strictly on the provided data. Never fabricate terms.
- If a field is null or missing, omit it from that section rather than noting its absence.
- Keep each section to 2–4 sentences maximum.
- For risks: explain WHY each risk matters and its practical implication, not just what it says.

Return ONLY valid JSON with these keys:
{
  "financial_summary": "2-4 sentence narrative about rent, escalation, total commitment, and PV liability",
  "key_clauses_summary": "2-4 sentence narrative covering renewal options, termination rights, and security deposit provisions",
  "risk_narrative": [{"title": "risk title", "narrative": "1-2 sentence plain-language explanation of why this risk matters"}],
  "executive_notes": "1-2 sentence high-level summary of the most important thing a finance reviewer should know about this lease"
}`;

serve(async (req) => {
  const requestOrigin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(requestOrigin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { leaseId } = await req.json();
    if (!leaseId || typeof leaseId !== 'string') {
      return new Response(JSON.stringify({ error: 'leaseId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch lease data — RLS-scoped via workspace membership check
    const { data: lease, error: leaseError } = await supabaseAdmin
      .from('leases')
      .select(`
        id, request_title, filename, asset_type,
        landlord_name, tenant_name, property_address,
        lease_start, lease_end, term_months,
        current_monthly_rent, executed_monthly_payment,
        escalation_type, escalation_rate, needs_escalation_review,
        renewal_options, termination_clauses, escalation_clauses,
        security_deposit, square_footage,
        calc_total_commitment, calc_pv_liability,
        extracted_json, workspace_id
      `)
      .eq('id', leaseId)
      .single();

    if (leaseError || !lease) {
      return new Response(JSON.stringify({ error: 'Lease not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify user has access to this workspace
    const { data: membership } = await supabaseAdmin
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', lease.workspace_id)
      .eq('user_id', user.id)
      .maybeSingle();

    const { data: ownedWorkspace } = await supabaseAdmin
      .from('workspaces')
      .select('id')
      .eq('id', lease.workspace_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!membership && !ownedWorkspace) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch rent schedule
    const { data: rentSchedule } = await supabaseAdmin
      .from('rent_schedules')
      .select('period_start, period_end, monthly_amount, annual_amount, notes')
      .eq('lease_id', leaseId)
      .order('period_start');

    // Fetch risks
    const { data: risks } = await supabaseAdmin
      .from('risks')
      .select('title, severity, explanation, citation_snippet, citation_page')
      .eq('lease_id', leaseId)
      .order('severity');

    // Build the structured data payload for Sonnet
    const leaseContext = {
      display_name: lease.request_title || lease.filename,
      asset_type: lease.asset_type,
      landlord: lease.landlord_name,
      tenant: lease.tenant_name,
      property_address: lease.property_address,
      lease_start: lease.lease_start,
      lease_end: lease.lease_end,
      term_months: lease.term_months,
      monthly_rent: lease.executed_monthly_payment ?? lease.current_monthly_rent,
      escalation_type: lease.escalation_type,
      escalation_rate: lease.escalation_rate,
      needs_escalation_review: lease.needs_escalation_review,
      renewal_options: lease.renewal_options,
      termination_clauses: lease.termination_clauses,
      escalation_clauses: lease.escalation_clauses,
      security_deposit: lease.security_deposit,
      square_footage: lease.square_footage,
      total_commitment: lease.calc_total_commitment,
      pv_liability: lease.calc_pv_liability,
      rent_schedule: rentSchedule || [],
      risks: risks || [],
    };

    console.log(`[generate-lease-analysis] Calling Sonnet for lease ${leaseId}`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: ANALYSIS_SYSTEM,
        messages: [{
          role: 'user',
          content: `Generate the analysis narrative for this lease:\n\n${JSON.stringify(leaseContext, null, 2)}`,
        }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[generate-lease-analysis] Anthropic error:', errorText);
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const aiData = await response.json();
    const rawContent = aiData.content?.[0]?.text || '{}';
    console.log(`[generate-lease-analysis] Sonnet tokens in=${aiData.usage?.input_tokens} out=${aiData.usage?.output_tokens}`);

    // Parse the JSON response from Sonnet
    let prose: Record<string, unknown>;
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      prose = JSON.parse(jsonMatch ? jsonMatch[0] : rawContent);
    } catch {
      console.error('[generate-lease-analysis] JSON parse failed, using raw content');
      prose = { financial_summary: rawContent };
    }

    return new Response(JSON.stringify({
      success: true,
      leaseId,
      lease: leaseContext,
      prose,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analysis generation failed';
    console.error('[generate-lease-analysis] Error:', error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
