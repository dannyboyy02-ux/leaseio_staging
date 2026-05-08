# Email Intake Plan — Path 2 ("Side Door")

**Status:** PROPOSED, not yet implementation-approved.
**Drafted:** 2026-05-08
**Aligns with:** `docs/PRODUCT_STRATEGY.md`, CLAUDE.md "Intake Architecture" section, `intake_source = 'email_intake'` already reserved in migration `20260330000001`.

---

## 1. What this is and why it matters

### Strategic position

CLAUDE.md positions LeaseIO as the *"lease awareness and intake layer for mid-market finance teams."* Two ongoing intake paths are explicitly defined as the product's only entry-points (Strategic Rule #5):

- **Path 1 — Front Door (Request Workflow):** The proactive path. Department submits → finance approves → document uploaded → AI abstracts → review → repository.
- **Path 2 — Side Door (Email Inbox):** The reactive path. Forward signed lease to dedicated email → AI abstracts → Needs Review queue → user confirms → repository.

Path 2 is not a feature; it's a structural product pillar. **Many leases enter the org *after* execution** — brokers forward signed PDFs, legal teams email final copies, vendors send executed counterparts. Without Path 2, those leases live in inboxes forever and the customer keeps the awareness gap LeaseIO promises to close.

### Why now

- `intake_source = 'email_intake'` was reserved in March 2026 but never wired. The schema has been waiting.
- Tier 2 (classification gate) and Tier 3 (portfolio insights) just shipped. Email intake routes documents through the same pipeline — we get the gate and the insights for free.
- Pre-launch: this is the moment to build the second pillar before customers learn the workaround of "just email me the PDF and I'll upload it manually."

### Strategic risks if we DON'T build it

- The "we capture every lease" promise is hollow without a no-friction post-execution capture path.
- Competitors with email intake (most lease-mgmt tools) win the mid-market evaluation.
- Customer onboarding friction stays high; users don't want to retrain their org's "forward leases to AP@" habit.

---

## 2. Architecture overview

```
External sender                                  Inbound
─────────────                                    email
   │                                             service
   │  forwards lease.pdf to                      ─────────
   │  acme-finance-7k3r2j@leases.theleaseio.com    │
   ▼                                               │
   ┌──────────────────────────────────────────┐   │
   │ MX records for leases.theleaseio.com     │◀──┘ webhook (HMAC signed)
   │ point at the inbound email service       │
   └──────────────────────────────────────────┘   │
                                                   ▼
                                    ┌────────────────────────────┐
                                    │ Edge function:             │
                                    │ inbound-email-parse        │
                                    │                            │
                                    │ 1. Verify webhook auth     │
                                    │ 2. Identify workspace      │
                                    │    (recipient address)     │
                                    │ 3. Verify sender allowed   │
                                    │ 4. Validate attachments    │
                                    │ 5. Per attachment:         │
                                    │    - upload to storage     │
                                    │    - create lease row      │
                                    │      (intake_source =      │
                                    │       'email_intake')      │
                                    │    - invoke process_lease  │
                                    │ 6. Log email_intake_event  │
                                    └────────────────────────────┘
                                                   │
                                                   ▼
                                    Existing Tier 2 → Tier 1 → Tier 3
                                    pipeline. NO special case in
                                    process_lease for email-sourced.
                                    Lease lands in standard review queue
                                    with intake_source filter available.
```

### Key design principle

**Email intake is a thin adapter, not a parallel pipeline.** Everything downstream of `process_lease` is the same code path the manual-upload modal uses. The only difference is *how the PDF arrived*. This means:

- Tier 2 classification fires (rejects non-leases automatically — critical when receiving from email since misfiles are common)
- Tier 3 portfolio insights apply (Business tier benefit)
- Approval routing is unchanged
- Audit log captures the intake source
- ASC 842 reporting is unaffected (it reads finalized leases regardless of how they arrived)

---

## 3. Email addressing scheme

### Per-workspace unique addresses

Each workspace gets a unique recipient address. Format:

```
{workspace-slug}-{6-char-token}@leases.theleaseio.com
```

Examples:
- `acme-finance-7k3r2j@leases.theleaseio.com`
- `latitude36foods-xj9w2p@leases.theleaseio.com`

Why this format:
- `workspace-slug` is human-readable — admins can communicate it ("forward leases to acme-finance@…") without needing to look up an opaque ID
- 6-char token (alphanumeric, lowercase) — prevents enumeration; allows regeneration if compromised
- Subdomain `leases.theleaseio.com` — separate MX records from main domain so the production email-receiver and the inbound-intake receiver are independently configurable

### Slug generation

Workspaces don't currently have a slug field. New migration adds `workspaces.intake_slug` (text, unique). Generated from `workspaces.name` lowercased + dehyphenated + truncated to 24 chars + uniqueness suffix if collision.

### Regeneration

Workspace admins can regenerate the token (e.g., if an old address leaked). Old address deactivates immediately; new address is published in workspace settings.

### Multi-workspace user case

A user who is a member of 3 workspaces gets 3 different intake addresses. This is the cleanest model — the address determines the workspace, no ambiguity.

---

## 4. Inbound email service selection (decision needed)

**Three viable vendors. Recommendation pending your call.**

| Option | Pros | Cons | Cost (1K emails/mo) |
|---|---|---|---|
| **Resend Inbound** | We already use Resend for outbound. Single vendor relationship. Same API patterns. | Resend Inbound is in beta as of 2026-Q1; production maturity uncertain. May lack mature spam/SPF/DKIM tooling. | Likely free at low volume; pricing TBD |
| **SendGrid Inbound Parse** | Battle-tested, used by tens of thousands of products. Full SPF/DKIM/spam support out of box. Free tier covers up to 100/day. | New vendor relationship. Twilio acquisition may affect future direction. | Free tier; $0.40/1K beyond |
| **AWS SES Inbound** | Most flexible, full control. Cheapest at scale. | Most complex setup (S3 bucket + Lambda or direct SNS to webhook). DNS/MX setup more involved. | $0.10/1K |

**My recommendation: SendGrid Inbound Parse** for v1.

Reasoning: maturity > vendor consolidation when handling external email. Spam, SPF/DKIM checks, and attachment parsing are battle-tested at SendGrid in a way they aren't at Resend Inbound yet. Volume will be low for the first 6 months; the $0.40/1K tier is irrelevant. We can re-evaluate when/if Resend Inbound goes GA.

**You decide:**
- If vendor consolidation matters more than maturity → Resend Inbound (and accept some early-adopter rough edges)
- If cost-at-scale matters → AWS SES (and accept setup complexity)
- Default → SendGrid Inbound Parse

---

## 5. DNS / domain setup (operator-only work)

Required (you do this; I cannot):

1. Add MX records for `leases.theleaseio.com`:
   - For SendGrid: `mx.sendgrid.net` (priority 10)
   - For Resend Inbound: their inbound MX endpoints
   - For SES: SES inbound endpoint per region
2. Verify domain ownership in the chosen service (TXT record)
3. Configure inbound parse / inbound rule:
   - SendGrid: "Inbound Parse Webhook" → `https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/inbound-email-parse`
   - Webhook receives POST with multipart form data containing email + attachments
4. Set webhook signing secret as edge function env var: `INBOUND_EMAIL_WEBHOOK_SECRET`

I'll surface these as a deployment checklist when v1 ships.

---

## 6. Authorization model

### Sender allowlist (v1)

**Default rule:** Email accepted if the sender's address matches a workspace member or workspace owner.

**Why:** Anyone can send email to a public address. Without sender verification, spam and abuse are inevitable. Sender-match keeps the v1 simple while protecting against the obvious attack.

### Pending-sender approval queue (v2)

When email arrives from an unrecognized sender:
- Save the email to a `email_intake_pending_senders` table (status='pending')
- Send an in-app notification to workspace admins
- Admin reviews: approves the sender (auto-add to allowlist OR one-time accept) OR rejects
- Approved senders auto-route on future emails

This handles the "broker forwards lease but isn't a workspace member" case without compromising v1 security.

### Domain allowlist (v2)

Workspace admin can pre-approve a whole domain (e.g., `@yourbroker.com`). Useful for:
- A workspace member's broker's law firm (recurring sender, not a workspace member)
- Internal legal teams in a parent org (not directly on the workspace, but in the company's email domain)

### Spam / abuse protection

- Rely on inbound service's spam classification (SendGrid has X-SG-Spam headers)
- HMAC verification on the webhook (only the email service can call us)
- Per-workspace rate limit: max N inbound emails per hour, configurable. Existing `enforceWorkspaceRateLimit` helper in `_shared/audit.ts` can be extended.
- SPF/DKIM verification — automatic via the inbound service's headers; we read and reject hard fails

---

## 7. Schema design

Three new tables:

```sql
-- workspaces extension (new column)
ALTER TABLE public.workspaces
  ADD COLUMN intake_slug text UNIQUE,
  ADD COLUMN intake_token text,
  ADD COLUMN intake_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN intake_rate_limit_per_hour integer NOT NULL DEFAULT 20;

-- the one inbound address per workspace (denormalized from intake_slug+token for indexing)
-- NOT a separate table — kept on workspaces row because every workspace has exactly one.

-- audit log of every received email
CREATE TABLE public.email_intake_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  message_id      text,                          -- email Message-ID header (dedup)
  sender_email    text NOT NULL,
  sender_name     text,
  subject         text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  attachment_count integer NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN (
    'received', 'processing', 'extracted',
    'rejected_unknown_sender', 'rejected_no_attachment',
    'rejected_non_lease', 'rejected_quota', 'rejected_spam',
    'failed'
  )),
  rejection_reason text,
  raw_headers     jsonb              -- forensics (auth-results, spam scores)
);

CREATE INDEX idx_email_intake_events_workspace_recent
  ON public.email_intake_events(workspace_id, received_at DESC);

CREATE UNIQUE INDEX idx_email_intake_events_message_id
  ON public.email_intake_events(workspace_id, message_id)
  WHERE message_id IS NOT NULL;  -- dedup repeat deliveries

-- per-attachment results (one email may carry multiple PDFs)
CREATE TABLE public.email_intake_attachments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_event_id   uuid NOT NULL REFERENCES public.email_intake_events(id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  filename          text NOT NULL,
  size_bytes        bigint NOT NULL,
  content_type      text,
  status            text NOT NULL CHECK (status IN (
    'queued', 'processing', 'extracted', 'rejected_non_lease',
    'rejected_invalid_pdf', 'rejected_oversize', 'failed'
  )),
  lease_id          uuid REFERENCES public.leases(id) ON DELETE SET NULL,
  failure_message   text
);

CREATE INDEX idx_email_intake_attachments_lease
  ON public.email_intake_attachments(lease_id)
  WHERE lease_id IS NOT NULL;

-- v2: pending senders (deferred to v2)
-- CREATE TABLE public.email_intake_pending_senders (...);
```

RLS:
- Workspace members read both events and attachments
- Service-role-only writes (edge function bypasses RLS)
- Append-only from clients (no UPDATE/DELETE policies)

---

## 8. Edge function design

### `inbound-email-parse` (new)

Hot path for every received email. Optimized for fail-fast: reject obvious garbage before doing expensive work.

```
1. Verify webhook signature (HMAC against INBOUND_EMAIL_WEBHOOK_SECRET)
   FAIL → 401, log to email_intake_events as 'rejected_spam' if Message-ID provided

2. Parse incoming form-data: extract sender, recipient, subject,
   attachments, raw headers

3. Extract local-part from recipient: 'acme-finance-7k3r2j' from
   'acme-finance-7k3r2j@leases.theleaseio.com'

4. SELECT workspace WHERE intake_slug || '-' || intake_token = local_part
   AND intake_enabled = true
   FAIL → 404 silently (don't leak which addresses exist)

5. Dedup check: SELECT email_intake_events WHERE workspace_id = X AND
   message_id = Y. If found → 200 OK, no-op (resends from email service)

6. Sender allowlist check:
   - SELECT workspace_members WHERE workspace_id = X AND user.email = sender
   - OR workspace.owner.email = sender
   FAIL → INSERT email_intake_events status='rejected_unknown_sender',
   return 200 (don't bounce — silent rejection)

7. Rate-limit check (per-workspace, per-hour). If exceeded:
   INSERT status='rejected_quota', send notification email back, 200

8. Attachment validation:
   - filter to PDF content-type
   - max 50MB each (matches existing process_lease cap)
   - PDF magic bytes check
   FAIL all → INSERT status='rejected_no_attachment', return 200

9. INSERT email_intake_events status='processing', create
   email_intake_attachments rows status='queued' for each PDF

10. For each PDF:
    - Upload to storage (path: workspace_id/email-intake/{event_id}/{filename})
    - Create leases row with intake_source='email_intake'
    - Invoke process_lease in background (don't await — return 200 fast)

11. Update event status='extracted' once all attachment lease rows
    created. process_lease then runs Tier 2 → Tier 1 → Tier 3
    asynchronously.
```

### Deploy auth pattern

`verify_jwt = false` (inbound emails don't carry user auth). Auth is via the HMAC-signed webhook header. Same fail-closed pattern as `cleanup-expired-reports` — without the env var set, every request rejects.

---

## 9. Pricing & quota integration

### Counts as an abstraction

Each PDF that successfully reaches Tier 1 extraction counts against the workspace's monthly abstraction quota:
- Starter: 15 abstractions/mo (overage $12/doc)
- Business: 50 abstractions/mo (overage $10/doc)

### Quota exceeded behavior

- v1: Email accepted, lease created with status='Failed' and error_message='Monthly abstraction quota exceeded'. Sender NOT notified (would create a 2-way SMTP dependency we don't have at v1).
- v2: Send a bounce-style notification email back to the sender ("Your lease was received but {workspace} has reached its monthly abstraction limit. Contact {admin}@…")

### Tier gating

Email intake is available on **all tiers** (Plus, Pro, Business). It's not a Business-tier feature like portfolio insights — it's a fundamental intake path.

But: rate limits scale with tier:
- Starter: 20 inbound emails/hour
- Business: 100 inbound emails/hour

Configurable per-workspace by admin within tier ceiling.

---

## 10. UX surfaces

### v1 — Three surfaces

**A. Workspace settings tab** (`/app/settings/workspace?tab=intake`):
- Display the workspace's intake address (large, copyable)
- "Regenerate address" button (admin only) — invalidates old, generates new
- Enable/disable toggle (admin only)
- Show recent intake events table (last 50): timestamp, sender, subject, status, lease link
- Rate limit setting (within tier ceiling)

**B. Inbound activity in the leases list:**
- New filter chip: "Source: Email" alongside existing filters
- The lease row shows a small "📧" icon + sender preview when intake_source='email_intake'
- Click to expand: full email metadata (sender, subject, received timestamp)

**C. Failure-handling notifications:**
- When an email is rejected (unknown sender, quota, etc.), insert an in-app notification for workspace admins
- Notification surfaces on the bell-icon dropdown

### v2 — Pending senders queue + dedicated inbox

**A. Pending senders page** (`/app/settings/workspace?tab=intake-pending`):
- List unrecognized senders awaiting admin approval
- Approve / Reject / "Approve domain" actions
- After approval, the held email re-enters the pipeline

**B. Email Intake Inbox page** (`/app/intake/inbox`):
- Dedicated view (separate from the leases list) for email-sourced documents
- Shows full email content (subject, body preview, sender)
- Bulk actions (approve sender, mark spam, retry extraction)

v2 is post-v1-validation. v1 punts the dedicated inbox UI in favor of leveraging the existing leases list with a filter.

---

## 11. Workspace integration & multi-workspace

### Direct workspace member case

User Alice is a member of workspace W1. She forwards lease.pdf to W1's intake address. The email is identified as W1's, sender Alice is matched against W1's members, lease is created in W1. ✓

### Multi-workspace member case

User Bob is a member of W1 and W2. Bob forwards a lease to **W1's intake address**. The address determines the workspace; Bob's membership in W1 satisfies the sender check. Lease lands in W1.

If Bob mistakenly forwards to W2's address, sender Bob is also a member of W2 → lease lands in W2. This is correct: the address is the routing primary, not the sender's home workspace.

### External sender case (broker, lawyer)

Broker forwards lease to W1's intake address. Broker is NOT a workspace member.
- v1: Email rejected (`rejected_unknown_sender`). Workspace admin gets a notification. Admin manually adds the broker as a "viewer" workspace member, OR resolves by manually uploading the lease. Friction by design — v1 keeps the surface small.
- v2: Pending-sender queue. Admin one-click approves the broker's email → email re-processes. Or domain allowlist preempts the question.

### Phase 9 firm-layer interaction (forward compatibility)

Phase 9 introduces firms that own multiple child workspaces. For email intake:

- **Each child workspace keeps its own intake address.** Per-child confidentiality boundary preserved (CPA firm: each client's leases stay in that client's workspace).
- **Firm members ARE workspace members of every child** (per Phase 9's `is_workspace_member` extension). So a firm-level admin can email-intake into any child workspace using that workspace's address.
- **Firm-level inbox aggregation** (Phase 10 territory) shows email-intake events across all child workspaces — powerful for CPA firms triaging across clients. Already supported by the schema (no firm-level cross-workspace logic in v1; the data is just visible from the firm dashboard).
- **No prophylactic firm columns in v1.** Per CLAUDE.md product strategy: "Do not pre-build the firm layer in Phases 4-8 — no prophylactic firm_id columns." Email intake follows the same rule. Phase 9 will retrofit; the schema today doesn't need to know about firms.

This is the right call architecturally because:
- v1 ships without coupling to a Phase-9-pending entity
- Phase 9's firm-aware RLS automatically extends email-intake reads correctly
- No data migration needed when Phase 9 lands

---

## 12. Failure modes (full enumeration)

| Failure | Detection | User-facing outcome | Audit trail |
|---|---|---|---|
| Unknown sender | sender ∉ workspace_members | Silent reject (no bounce) + admin notification | `email_intake_events.status = rejected_unknown_sender` |
| Spam (high score) | inbound service marks as spam | Silent drop | `rejected_spam` |
| No PDF attachment | content-type filter | Silent drop | `rejected_no_attachment` |
| Oversize PDF (>50MB) | size check | Per-attachment fail; other attachments process | `email_intake_attachments.status = rejected_oversize` |
| Invalid PDF (bad magic bytes) | header check | Per-attachment fail | `rejected_invalid_pdf` |
| Tier 2 says non-lease | classification confidence > 0.85 | Lease row exists with status='Failed' + Tier 2 reason | Standard Tier 2 audit + intake_attachment links to lease |
| Quota exceeded | rate-limit / monthly count | Lease created with status='Failed' (v1); v2 bounces | `rejected_quota` |
| Anthropic API failure | HTTP error | Standard process_lease failure path; lease 'Failed' | `lease.error_message` |
| Webhook auth failure | HMAC mismatch | 401 to caller; we log it | Generic log only (don't store unauth'd messages) |
| Duplicate email (Message-ID seen) | dedup index | Silent 200 to webhook (idempotent) | No new event row |
| Inbound service outage | n/a | Email queues at the service; we receive when restored | Service's own dashboards |

---

## 13. Phasing

### Phase 1 — Foundation (next workstream after this plan is approved)

Goal: end-to-end email intake working for the simplest case (sender = workspace member, single PDF attachment).

Scope:
1. Migration: workspaces.intake_* columns, email_intake_events, email_intake_attachments
2. Vendor onboarding (operator: SendGrid account, MX records, webhook secret)
3. Edge function: `inbound-email-parse`
4. Workspace settings tab: display intake address, regenerate, enable/disable
5. Leases list filter chip: "Source: Email"
6. In-app notification on rejected emails for workspace admins
7. Generate intake_slug + intake_token for every existing workspace (one-time backfill)

Estimated effort: 2-3 multi-step sessions of focused work.

### Phase 2 — Polish (after v1 validates)

- Pending-sender approval queue with admin UI
- Domain allowlist (admin-managed)
- Bounce notifications when quota exceeded
- Dedicated `/app/intake/inbox` page (replaces leases-list filter as the primary view)
- Email-intake-specific review surfaces (show sender + subject during review)

### Phase 3 — Firm-layer (post Phase 9)

- Firm-level inbox aggregation across child workspaces
- Per-firm intake routing rules (e.g., "all leases from broker X go to client workspace Y")
- White-label intake addresses for CPA firms (advanced; Phase 11+)

---

## 14. Open questions (for your decision)

These need your call before implementation starts:

1. **Email service vendor.** Recommendation: SendGrid Inbound Parse for v1. Alternative: Resend Inbound (vendor consolidation) or AWS SES (cost at scale). Pick one.
2. **Domain choice.** Recommendation: `leases.theleaseio.com`. Alternative: `intake.theleaseio.com` or top-level `leases@theleaseio.com` with subaddressing (`leases+acme-finance-7k3r2j@…`). Subaddressing is cheaper (no separate MX) but breaks for senders who strip plus addresses.
3. **Sender-match policy default.** v1 plan: members + owner only. Loosen at workspace-admin discretion via domain allowlist (v2). Tighter (e.g., explicit per-sender allowlist from the start) is also defensible if you expect mostly internal forwarding. **Default in plan: members + owner.**
4. **Quota-exceeded behavior.** v1: silent fail with admin notification. v2: bounce email to sender. Acceptable to defer the bounce to v2?
5. **Backfill.** Should existing workspaces auto-receive an intake address as part of the migration (default `intake_enabled = false` so it's opt-in)? Or opt-in via a workspace-settings click? **Plan defaults to: backfill addresses, opt-in to enable.**
6. **Tier gating.** Is email intake available on all tiers (current plan) or Business-only? Mid-market finance teams forward leases regardless of tier; Business-only would be a moat-ish gate but reduces product appeal at lower tiers. **Plan: all tiers, with rate limits scaled by tier.**

---

## 15. What's explicitly out of scope for v1

To keep v1 tight:
- Outbound notifications to senders (bounce-on-rejection, success-confirmation). Stays at "silent" v1 behavior.
- Attachment types other than PDF (skip Word docs, images, etc. for v1).
- Email body parsing for context (signature blocks, routing instructions, etc.). The PDF is what we extract; the email body is metadata only.
- Multi-recipient emails (CC, BCC). v1 routes by `To:` recipient only.
- Reply-threading (a forwarded lease might be part of a thread). Each email is its own atomic unit.
- Auto-forwarding rules from the workspace's actual mail server to LeaseIO — that's a customer-side configuration, not our concern.
- Inbox UI as a primary surface. v1 leverages the existing leases-list with a filter; dedicated inbox is v2.

---

## 16. Definition of done for v1

- [ ] All 3 schema deltas (workspaces extension, email_intake_events, email_intake_attachments) applied to live with idempotent migrations.
- [ ] `inbound-email-parse` edge function deployed; HMAC auth works; rejects unauth'd POSTs with 401.
- [ ] DNS / MX setup complete for `leases.theleaseio.com`; webhook configured at the inbound service; test email from a workspace member's address arrives in their workspace's leases list within 60 seconds.
- [ ] Workspace settings tab shows the intake address with copy-to-clipboard, regenerate, and enable/disable toggles working.
- [ ] Leases list filter chip "Source: Email" filters correctly.
- [ ] Tier 2 → Tier 1 → Tier 3 pipeline runs unchanged on email-intake leases (verified: a non-lease attachment is rejected by Tier 2 with the standard error, not a special case).
- [ ] Failure paths exercised manually: unknown sender, oversize PDF, non-PDF attachment, quota-exceeded — each produces the right `email_intake_events.status`.
- [ ] In-app notification fires for workspace admins on each rejected email.
- [ ] Existing tests still pass; new tests cover: webhook HMAC verification, address parsing, sender-match logic, attachment validation.
- [ ] CLAUDE.md updated to mark email-intake foundation closed; KNOWN_ISSUES.md updated.

---

## Appendix A — Implementation effort estimate

| Component | Sessions |
|---|---|
| Schema migration + RLS + types regen | 0.5 |
| `inbound-email-parse` edge function | 1.0 |
| Workspace settings tab + intake-address UI | 0.5 |
| Leases list filter + email-source surface | 0.25 |
| End-to-end smoke test with real email | 0.25 |
| Documentation + CLAUDE.md updates | 0.25 |
| **Total v1** | **~2.75 sessions** |

Plus operator-side setup (your work):
- Inbound service account
- DNS / MX configuration
- Webhook secret generation

---

## Appendix B — Schema rationale

### Why three tables (workspace extension + events + attachments)?

- **workspaces extension:** the address belongs to the workspace 1:1. Putting `intake_slug`/`intake_token`/`intake_enabled` on `workspaces` is denormalized but matches the cardinality.
- **email_intake_events:** one row per email received. This is the audit unit — "who sent us what when, what happened to it."
- **email_intake_attachments:** one row per PDF attachment. One email can carry multiple PDFs; each becomes its own lease. Separating from the event lets us track per-attachment status independently (one PDF in an email might extract cleanly while another fails).

### Why `intake_slug` on workspaces, not a separate addresses table?

A workspace has exactly one active intake address. If we wanted multiple (for sub-departments, etc.), a table makes sense. Today's product story is one-per-workspace; addresses table is YAGNI.

When/if we want to deprecate-and-rotate (e.g., user regenerates the token), we keep `intake_slug` (human-readable) but replace `intake_token`. The email_intake_events history references the workspace_id, so old events stay correctly attributed.

---

**End of plan. Standing by for your decisions on Section 14 before implementation.**
