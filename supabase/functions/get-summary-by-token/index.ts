import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// INTENTIONAL CORS DIVERGENCE FROM _shared/cors.ts:
// This is a public, token-protected endpoint that vendors and external
// finance reviewers access from arbitrary origins (their own webmail, a
// CFO's iPad browser, etc). The shared helper restricts to a workspace
// allowlist and would break the public-summary use case. Authentication
// is enforced via the unguessable `summary_share_token` query param +
// 30-day expiry + revocability (see line 56), NOT via origin restriction.
// Do NOT replace this with `getCorsHeaders` from `_shared/cors.ts`.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Token required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Look up lease by token — only fetch fields needed for summary
    const { data: lease, error: leaseError } = await supabase
      .from('leases')
      .select(
        'id, workspace_id, request_title, asset_type, request_description, vendor_name, ' +
        'requesting_department, uploaded_at, lifecycle_status, monthly_payment, term_months, ' +
        'lease_start, escalation_rate, calc_total_commitment, calc_pv_liability, ' +
        'calc_straight_line_exp, calc_cash_pl_delta, lease_classification, covenant_flagged, ' +
        'financial_approved_at, financial_approved_by, requestor_id, ' +
        // P2-10: per-lease discount rate override (migration 20260506220000).
        // Effective rate is COALESCE(lease.discount_rate, workspace.discount_rate).
        'discount_rate, discount_rate_basis, ' +
        'summary_share_token_expires_at'
      )
      .eq('summary_share_token', token)
      .single();

    if (leaseError || !lease) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Token expiry — 404 (not 410) so an expired token is indistinguishable
    // from an unknown one to a recipient. Revoked tokens are returned by setting
    // summary_share_token = NULL, which causes the lookup above to miss.
    const expiresAtRaw = (lease as { summary_share_token_expires_at?: string | null }).summary_share_token_expires_at;
    if (expiresAtRaw && new Date(expiresAtRaw).getTime() <= Date.now()) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Phase 3: include chain post_concept_pre_signator + signator stages +
    // executed equivalent (active is identical in both vocabularies).
    if (![
      'approved', 'executed', 'active',
      'in_negotiation', 'final_review', 'pending_counter_signature', 'fully_executed',
    ].includes(lease.lifecycle_status || '')) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // Record view (fire-and-forget style, non-blocking)
    const viewerIp =
      req.headers.get('x-forwarded-for') ||
      req.headers.get('x-real-ip') ||
      null;
    const referrer = req.headers.get('referer') || null;

    supabase.from('summary_views').insert({
      lease_id: lease.id,
      viewer_ip: viewerIp,
      referrer: referrer,
    }).then(() => {});

    supabase
      .from('leases')
      .update({ summary_last_viewed_at: new Date().toISOString() })
      .eq('id', lease.id)
      .then(() => {});

    // Fetch workspace name and discount rate
    const { data: wsData } = await supabase
      .from('workspaces')
      .select('name, discount_rate')
      .eq('id', lease.workspace_id)
      .single();

    // Fetch financial approver name (first + last only, no email or ID)
    let financialApproverName: string | null = null;
    if (lease.financial_approved_by) {
      const { data: approverProfile } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', lease.financial_approved_by)
        .single();
      if (approverProfile) {
        const name = [approverProfile.first_name, approverProfile.last_name]
          .filter(Boolean)
          .join(' ');
        financialApproverName = name || null;
      }
    }

    // Compute end date from start + term
    let endDate = '';
    if (lease.lease_start && lease.term_months) {
      const start = new Date(lease.lease_start);
      const end = new Date(
        start.getFullYear(),
        start.getMonth() + Number(lease.term_months),
        start.getDate()
      );
      endDate = end.toISOString().slice(0, 10);
    }

    // Build safe public response — no internal IDs, user IDs, storage paths, or workspace config
    const summary = {
      requestTitle: lease.request_title || 'Lease Commitment',
      assetType: lease.asset_type || '',
      description: lease.request_description || '',
      vendor: lease.vendor_name || null,
      requestingDepartment: lease.requesting_department || '',
      submittedAt: lease.uploaded_at || '',

      monthlyPayment: Number(lease.monthly_payment) || 0,
      termMonths: Number(lease.term_months) || 0,
      startDate: lease.lease_start || '',
      endDate,
      escalationRate: Number(lease.escalation_rate) || 0,

      calcTotalCommitment: Number(lease.calc_total_commitment) || 0,
      calcPvLiability: Number(lease.calc_pv_liability) || 0,
      calcStraightLineExp: Number(lease.calc_straight_line_exp) || 0,
      calcCashPlDelta: Number(lease.calc_cash_pl_delta) || 0,
      // P2-10: effective rate prefers the per-lease override and falls back
      // to the workspace default. Mirrors the COALESCE pattern in
      // v_lease_verification_audit and the migration 20260506220000 rule
      // ("downstream consumers must read leases.discount_rate first and
      // fall back to workspaces.discount_rate"). The 5.5% safety fallback
      // covers the historical case where neither field is set.
      discountRateUsed:
        ((lease as any).discount_rate != null ? Number((lease as any).discount_rate) : null)
        ?? (wsData?.discount_rate != null ? Number(wsData.discount_rate) : null)
        ?? 5.5,
      // Provenance so the public summary UI can disclose when the rate
      // came from a per-lease IBR override versus the workspace default.
      discountRateSource:
        (lease as any).discount_rate != null
          ? 'per_lease'
          : (wsData?.discount_rate != null ? 'workspace_default' : 'fallback'),
      discountRateBasis: (lease as any).discount_rate_basis ?? null,

      leaseClassification: lease.lease_classification || 'pending',
      covenantFlagged: Boolean(lease.covenant_flagged),

      lifecycleStatus: lease.lifecycle_status || '',
      financialApprovedAt: lease.financial_approved_at || null,
      financialApproverName,

      workspaceName: wsData?.name || '',
    };

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (err: any) {
    console.error('Error in get-summary-by-token:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
});
