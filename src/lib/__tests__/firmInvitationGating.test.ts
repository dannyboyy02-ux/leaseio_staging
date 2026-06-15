import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 10 firm invitation + join-request edge functions are service-role (they
// write past the DB guards/RLS), so each function's own caller-authorization is
// the security boundary. Static-source assertions pin those contracts (Deno, no
// unit harness — same idiom as firmEdgeFunctionGating.test.ts).

const root = process.cwd();
const fn = (name: string) => readFileSync(join(root, `supabase/functions/${name}/index.ts`), 'utf8');

const INVITE_FNS = [
  'send-firm-invitation', 'accept-firm-invitation', 'get-firm-invitation-info',
  'list-pending-firm-invitations', 'revoke-firm-invitation', 'resend-firm-invitation',
];
const JOIN_FNS = ['act-on-firm-workspace-join-request', 'cancel-firm-workspace-join-request'];
const ALL = [...INVITE_FNS, ...JOIN_FNS];

describe('common: service-role + CORS + structured errors', () => {
  for (const name of ALL) {
    it(`${name} uses service role, shared CORS, and never leaks raw DB errors`, () => {
      const src = fn(name);
      expect(src).toContain('getCorsHeaders');
      expect(src).toContain('SUPABASE_SERVICE_ROLE_KEY');
      // #102: raw constraint/trigger messages are logged server-side, never
      // returned in the response body. The only `.message` strings sent to the
      // client are string LITERALS (start with a quote), not `err.message` /
      // `insErr.message` / `updErr.message`.
      expect(src).not.toMatch(/message:\s*\w*[Ee]rr(or)?\.message/);
      expect(src).not.toMatch(/error:\s*\w*[Ee]rr(or)?\.message/);
    });
  }
});

describe('auth gates', () => {
  // get-firm-invitation-info is a deliberately public token lookup (the invitee
  // may have no account) — it validates the token format instead of auth.
  for (const name of ALL.filter((n) => n !== 'get-firm-invitation-info')) {
    it(`${name} verifies the bearer user`, () => {
      const src = fn(name);
      expect(src).toContain('req.headers.get("Authorization")');
      expect(src).toContain('reason: "no_auth"');
      expect(src).toContain('supabaseAdmin.auth.getUser(');
    });
  }

  it('get-firm-invitation-info is public but validates the token format', () => {
    const src = fn('get-firm-invitation-info');
    expect(src).toContain('/^[a-f0-9]{64}$/i');
    expect(src).toContain('INVALID_TOKEN');
    // Returns only display-safe fields — never the token itself.
    expect(src).not.toMatch(/\btoken:\s*invite\.token\b/);
  });
});

describe('send-firm-invitation — owner-only-mints-admins + CSPRNG token', () => {
  const src = fn('send-firm-invitation');
  it('only the owner may mint a firm_admin invitation', () => {
    expect(src).toContain('role === "firm_admin" && !isOwner');
    expect(src).toContain('role === "firm_member" && !isAdmin');
  });
  it('generates a 32-byte CSPRNG hex token', () => {
    expect(src).toContain('crypto.getRandomValues');
    expect(src).toContain('new Uint8Array(32)');
  });
  it('emails via Resend and is gated on RESEND_API_KEY', () => {
    expect(src).toContain('api.resend.com/emails');
    expect(src).toContain('email_not_configured');
  });
});

describe('accept-firm-invitation — bound to the invited email + state guards', () => {
  const src = fn('accept-firm-invitation');
  it('rejects when the signed-in email != the invited email', () => {
    expect(src).toContain('email_mismatch');
    expect(src).toMatch(/user\.email.*toLowerCase\(\).*!==.*invite\.email\.toLowerCase\(\)/);
  });
  it('guards revoked / already-accepted / expired', () => {
    expect(src).toContain('reason: "revoked"');
    expect(src).toContain('reason: "already_accepted"');
    expect(src).toContain('reason: "expired"');
  });
});

describe('revoke + resend — owner gate for admin invitations', () => {
  for (const name of ['revoke-firm-invitation', 'resend-firm-invitation']) {
    it(`${name} requires the owner to act on a firm_admin invitation`, () => {
      const src = fn(name);
      expect(src).toContain('invite.role === "firm_admin" && !isOwner');
      expect(src).toContain('invite.role === "firm_member" && !isAdmin');
    });
  }
});

describe('list-pending-firm-invitations — membership-gated', () => {
  const src = fn('list-pending-firm-invitations');
  it('requires firm membership (owner counts) before returning rows', () => {
    expect(src).toContain('isMember');
    expect(src).toContain('reason: "not_authorized"');
    expect(src).toContain('.is("accepted_at", null).is("revoked_at", null)');
  });
});

describe('act-on join request — counterparty authorization + bind on approve', () => {
  const src = fn('act-on-firm-workspace-join-request');
  it('authorizes the workspace side for firm_to_workspace and firm side for workspace_to_firm', () => {
    expect(src).toContain('reqRow.request_direction === "firm_to_workspace"');
    // workspace-side path checks workspace owner/admin; firm-side checks firm owner/admin
    expect(src).toContain('workspace_members');
    expect(src).toContain('firm_members');
    expect(src).toContain('"firm_admin"');
  });
  it('binds the workspace only when not already bound, and detects child-limit quota', () => {
    expect(src).toContain('already_bound');
    expect(src).toContain('child workspace limit');
    expect(src).toContain('.update({ firm_id: reqRow.firm_id }).eq("id", reqRow.workspace_id).is("firm_id", null)');
  });
  it('sets acted_by + acted_at on the transition (CP1 attribution invariant)', () => {
    expect(src).toContain('acted_at: nowIso, acted_by: user.id');
  });
});

describe('cancel join request — initiator only', () => {
  const src = fn('cancel-firm-workspace-join-request');
  it('only the requester may cancel', () => {
    expect(src).toContain('reqRow.requested_by !== user.id');
    expect(src).toContain("status: \"cancelled\"");
  });
});

describe('set-firm-access — WORKSPACE OWNER only (not firm admin)', () => {
  const src = fn('set-firm-access');
  it('requires the workspace owner; a firm admin cannot override the child opt-out', () => {
    expect(src).toContain('ws as { owner_id: string }).owner_id !== user.id');
    expect(src).toContain('reason: "not_authorized"');
    // No firm_members admin escalation path — owner check is the only gate.
    expect(src).not.toContain('"firm_admin"');
  });
  it('only toggles firm-bound workspaces and audits the change', () => {
    expect(src).toContain('not_firm_bound');
    expect(src).toContain('workspace_firm_access_restricted');
    expect(src).toContain('workspace_firm_access_unrestricted');
  });
});
