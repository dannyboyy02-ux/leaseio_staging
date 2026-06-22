import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { getCorsHeaders as baseCorsHeaders } from "../_shared/cors.ts";
import { checkWorkspaceLive } from "../_shared/workspace_live.ts";
import {
  displayLabel,
  type LifecycleStatus,
} from "../_shared/lifecycle.ts";
import { FIELD_MAX, NAME_MAX, truncate, summarizeRisks } from "../_shared/ai_context.ts";

function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  return baseCorsHeaders(requestOrigin, "POST, OPTIONS");
}

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function extractValue(field: unknown): unknown {
  if (field && typeof field === 'object' && 'value' in (field as Record<string, unknown>)) {
    return (field as Record<string, unknown>).value;
  }
  return field;
}

function formatCurrency(val: number | null | undefined): string {
  if (val == null) return 'unknown';
  return `$${val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function buildLeaseContext(leases: any[], workspaceName: string): string {
  // KNOWN_ISSUES #6: 'needs_review' is not a valid lifecycle_status value
  // (it never existed in the CHECK constraint). The .includes() for it always
  // returned false. Removed; behavior unchanged.
  const activeLeases = leases.filter(l =>
    ['active', 'executed', 'draft'].includes(l.lifecycle_status)
  );

  const totalMonthly = activeLeases.reduce((sum, l) => {
    const monthly =
      Number(l.executed_monthly_payment) ||
      Number(l.current_monthly_rent) ||
      Number(l.monthly_payment) || 0;
    return sum + monthly;
  }, 0);

  const lines: string[] = [
    `WORKSPACE: ${workspaceName}`,
    `TOTAL ACTIVE LEASES: ${activeLeases.length}`,
    `TOTAL MONTHLY OBLIGATION: ${formatCurrency(totalMonthly)}`,
    `TOTAL ANNUAL OBLIGATION: ${formatCurrency(totalMonthly * 12)}`,
    '',
    '--- LEASE DETAILS ---',
  ];

  for (const lease of activeLeases) {
    // F1: every variable-length field below is bounded (truncate / summarizeRisks)
    // so a verbose lease can't blow up the prompt — total size is capped at
    // (active lease count × a fixed per-lease budget).
    const name = truncate(lease.request_title || lease.filename || lease.id, NAME_MAX) ?? 'unknown';
    const monthly =
      Number(lease.executed_monthly_payment) ||
      Number(lease.current_monthly_rent) ||
      Number(lease.monthly_payment) || null;

    const json = lease.extracted_json as Record<string, unknown> | null;
    const address = truncate(json ? extractValue(json.property_address) : null, NAME_MAX);
    const securityDeposit = truncate(json ? extractValue(json.security_deposit) : null, FIELD_MAX);
    const renewalOptions = truncate(json ? extractValue(json.renewal_options) : null, FIELD_MAX);
    const terminationClauses = truncate(json ? extractValue(json.termination_clauses) : null, FIELD_MAX);
    const escalationClauses = truncate(json ? extractValue(json.escalation_clauses) : null, FIELD_MAX);
    const landlord = truncate(lease.landlord_name || extractValue(json?.landlord_name), NAME_MAX) ?? 'unknown';
    const tenant = truncate(lease.tenant_name || extractValue(json?.tenant_name), NAME_MAX) ?? 'unknown';
    const riskSummary = summarizeRisks(json?.risks);

    const leaseLine = [
      `LEASE: ${name}`,
      `  Status: ${displayLabel(lease.lifecycle_status as LifecycleStatus)}`,
      `  Asset type: ${lease.asset_type || 'unspecified'}`,
      `  Landlord: ${landlord}`,
      `  Tenant: ${tenant}`,
      `  Address: ${address || 'unknown'}`,
      `  Start: ${lease.lease_start || 'unknown'}`,
      `  End: ${lease.lease_end || 'unknown'}`,
      `  Term: ${lease.term_months ? `${lease.term_months} months` : 'unknown'}`,
      `  Monthly rent: ${formatCurrency(monthly)}`,
      `  Escalation type: ${lease.escalation_type || 'none'}`,
      `  Escalation rate: ${lease.escalation_rate != null ? `${lease.escalation_rate}%` : 'N/A'}`,
      `  Security deposit: ${securityDeposit || 'not stated'}`,
      `  Renewal options: ${renewalOptions || 'none stated'}`,
      `  Termination clauses: ${terminationClauses || 'none stated'}`,
      `  Escalation clauses: ${escalationClauses || 'none stated'}`,
      riskSummary ? `  Identified risks: ${riskSummary}` : '  Identified risks: none',
    ];

    lines.push(...leaseLine, '');
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are the embedded AI assistant for LeaseIO, a lease management platform for finance teams.

You have been given structured data from the user's lease portfolio. Your job is to answer questions about their leases accurately and concisely.

CRITICAL RULES:
1. ONLY answer from the data provided below. Never fabricate numbers, dates, or lease terms.
2. If the data does not contain enough information to answer, say so clearly.
3. When citing figures, be precise — quote the exact numbers from the data.
4. Do not give legal advice. You summarize contract data, not legal obligations.
5. Keep answers focused and professional. Finance teams value precision over prose.
6. If asked about something not in the data (e.g., "what will rents be in 5 years"), explain that you can only report what the leases state, not forecast.
7. Some long clause fields are truncated to keep this brief and end with an ellipsis ("…"). When a field you are quoting ends with "…", treat it as incomplete: tell the user the full clause text is longer than shown and they should consult the source document for the complete terms. Never assume the visible portion is the whole clause.

Format numbers as currency where appropriate. Dates as Month DD, YYYY.`;

serve((req) => {
  const corsHeaders = getCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // All responses from here on are SSE
  const sseHeaders = {
    ...corsHeaders,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  };

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = (data: unknown) => writer.write(encoder.encode(sseEvent(data)));

  // Process in background so we can return the readable stream immediately
  (async () => {
    try {
      const supabaseUrl            = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const anthropicApiKey        = Deno.env.get('ANTHROPIC_API_KEY')!;

      if (!supabaseUrl || !supabaseServiceRoleKey || !anthropicApiKey) {
        await write({ error: 'Server configuration error' });
        await writer.close();
        return;
      }

      // Auth
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        await write({ error: 'Unauthorized' });
        await writer.close();
        return;
      }

      const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { persistSession: false },
      });

      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
      if (userError || !userData?.user) {
        await write({ error: 'Invalid authentication' });
        await writer.close();
        return;
      }

      const user = userData.user;

      // Parse body
      const { question, workspaceId } = await req.json();
      if (!question || typeof question !== 'string' || !question.trim()) {
        await write({ error: 'Question is required' });
        await writer.close();
        return;
      }
      // P1-12: cap question length. A 2000-char question is generous for
      // a finance staffer; beyond that the prompt cost climbs without
      // matching legitimate use, and a long question is the cheapest way
      // for a compromised session to drain workspace AI budget.
      const QUESTION_MAX_CHARS = 2000;
      if (question.trim().length > QUESTION_MAX_CHARS) {
        await write({
          error: `Question is too long. Please shorten it to under ${QUESTION_MAX_CHARS} characters.`,
        });
        await writer.close();
        return;
      }
      if (!workspaceId) {
        await write({ error: 'workspaceId is required' });
        await writer.close();
        return;
      }

      // Verify workspace access
      const { data: workspace } = await supabaseAdmin
        .from('workspaces')
        .select('id, name, plan, owner_id')
        .eq('id', workspaceId)
        .single();

      if (!workspace) {
        await write({ error: 'Workspace not found' });
        await writer.close();
        return;
      }

      const isOwner = workspace.owner_id === user.id;
      if (!isOwner) {
        const { data: membership } = await supabaseAdmin
          .from('workspace_members')
          .select('role')
          .eq('workspace_id', workspaceId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (!membership) {
          await write({ error: 'Access denied' });
          await writer.close();
          return;
        }
      }

      // Vault V1: block Anthropic spend for non-live workspaces (canceled /
      // soft-deleted / vault) BEFORE any AI call. SSE idiom — the HTTP status
      // is fixed by the stream, so the gate is an error event, not a 403.
      const liveness = await checkWorkspaceLive(supabaseAdmin, workspaceId);
      if (!liveness.live) {
        await write({ ok: false, error: 'subscription_inactive', reason: liveness.reason });
        await writer.close();
        return;
      }

      // Plan gate — Business only
      if (workspace.plan !== 'business') {
        await write({ error: 'The AI assistant requires a Business plan.' });
        await writer.close();
        return;
      }

      // P1-04: AI consent gate. The signup form contractually promises
      // the user controls AI processing of their data; revoking consent
      // in Settings → Privacy must actually stop AI calls here.
      const { data: consentRow, error: consentErr } = await supabaseAdmin
        .from('profiles')
        .select('ai_processing_consent_at')
        .eq('id', user.id)
        .maybeSingle();
      if (consentErr) {
        console.error('[ai-assistant] consent check failed:', consentErr.message);
        await write({ error: 'Could not verify AI processing consent. Please try again.' });
        await writer.close();
        return;
      }
      if (!consentRow?.ai_processing_consent_at) {
        await write({
          error:
            'AI processing consent has not been granted. Re-enable consent in Settings → Privacy to use the AI assistant.',
        });
        await writer.close();
        return;
      }

      // P1-12: workspace-scoped rate limit. 30 questions per hour per
      // workspace gives a real finance team plenty of headroom while
      // bounding cost on a compromised or abusive session.
      const windowStart = new Date();
      windowStart.setUTCMinutes(0, 0, 0);
      const windowStartIso = windowStart.toISOString();
      const RATE_LIMIT = 30;
      const { data: rateRow, error: rateErr } = await supabaseAdmin
        .from('processing_rate_limits')
        .select('id, request_count')
        .eq('workspace_id', workspaceId)
        .eq('function_name', 'ai-assistant')
        .eq('window_start', windowStartIso)
        .maybeSingle();
      if (rateErr) {
        console.error('[ai-assistant] rate check failed:', rateErr.message);
        await write({ error: 'Rate-limit check failed. Please try again.' });
        await writer.close();
        return;
      }
      if (rateRow && rateRow.request_count >= RATE_LIMIT) {
        await write({
          error:
            'AI assistant usage limit reached for this hour. Please wait and try again shortly.',
        });
        await writer.close();
        return;
      }
      const { error: rateUpsertErr } = await supabaseAdmin
        .from('processing_rate_limits')
        .upsert(
          {
            workspace_id: workspaceId,
            function_name: 'ai-assistant',
            window_start: windowStartIso,
            request_count: (rateRow?.request_count || 0) + 1,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'workspace_id,function_name,window_start' },
        );
      if (rateUpsertErr) {
        console.error('[ai-assistant] rate upsert failed:', rateUpsertErr.message);
        // Don't block the request on a tracking write failure — the
        // gate still works on the next call when the row is read again.
      }

      // Fetch leases scoped to this workspace
      const { data: leases } = await supabaseAdmin
        .from('leases')
        .select(`
          id, filename, request_title, asset_type, lifecycle_status,
          lease_start, lease_end, term_months,
          monthly_payment, current_monthly_rent, executed_monthly_payment,
          landlord_name, tenant_name,
          escalation_type, escalation_rate,
          extracted_json
        `)
        .eq('workspace_id', workspaceId)
        // KNOWN_ISSUES #6: 'failed' is not a valid lifecycle_status value
        // either; only 'cancelled' actually exists. Kept the cancelled
        // exclusion (we don't want the AI to reason over cancelled leases).
        .not('lifecycle_status', 'in', '("cancelled")')
        .limit(60);

      const leaseContext = buildLeaseContext(leases || [], workspace.name);
      console.log(`[ai-assistant] Context built: ${leaseContext.length} chars, ${leases?.length ?? 0} leases`);

      // Call Anthropic with streaming
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicApiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          stream: true,
          system: `${SYSTEM_PROMPT}\n\n--- PORTFOLIO DATA ---\n${leaseContext}`,
          messages: [{ role: 'user', content: question.trim() }],
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        console.error('[ai-assistant] Anthropic error:', errText);
        await write({ error: 'AI service error. Please try again.' });
        await writer.close();
        return;
      }

      // Stream SSE events from Anthropic → client
      const reader = anthropicRes.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const event = JSON.parse(raw);
            if (
              event.type === 'content_block_delta' &&
              event.delta?.type === 'text_delta' &&
              typeof event.delta.text === 'string'
            ) {
              await write({ delta: event.delta.text });
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      await write({ done: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ai-assistant] Unhandled error:', msg);
      try {
        await write({ error: 'An unexpected error occurred.' });
      } catch { /* writer may already be closed */ }
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return new Response(readable, { headers: sseHeaders });
});
