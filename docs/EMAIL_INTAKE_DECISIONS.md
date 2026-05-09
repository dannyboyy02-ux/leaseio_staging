# Email Intake — Decisions on the Six Open Questions

**Document type:** Decision memo, ratifying changes to `docs/EMAIL_INTAKE_PLAN.md`.
**Owner:** Daniel
**Audience:** Claude Code, future contributors.
**Status:** Decisions ratified. Plan doc to be updated to reflect these decisions before v1 build begins.
**References:** `docs/EMAIL_INTAKE_PLAN.md` (commit 3c9b254), `docs/OPERATIONAL_MONITORING_SPEC.md`, `CLAUDE.md`, `docs/PRODUCT_STRATEGY.md`.

---

## Context

The Email Intake Plan committed to the repo on commit 3c9b254 surfaced six open decisions that block v1 implementation. This document ratifies those decisions and notes the scope, effort, and operational consequences of each. Where a decision diverges from the plan as originally drafted, the divergence and reasoning are made explicit so the as-built work matches intent.

Two cross-cutting context shifts inform these decisions:

- **Resend Inbound has exited beta.** The maturity concern that originally pushed toward SendGrid is retired. Vendor consolidation now wins cleanly.
- **Module: Operational Monitoring is now spec'd.** Email vendor usage (transactional outbound + inbound events) is one of the first pollers wired in Phase 2 of that module. Decisions below assume the monitoring layer is available; they do not assume it is in place at v1 ship time, but they call out the integration points.

The email intake feature itself is not on the immediate critical path — LeaseIO is pre-customer and the cost-model and operational hardening work currently outranks it. These decisions ratify the plan so that when build begins, the work is unambiguous; they do not commit to a build start date.

---

## Decision 1 — Email service vendor

**Decision: Resend Inbound.**

The original plan recommended SendGrid Inbound Parse on maturity grounds. That recommendation is reversed for two reasons:

1. **Resend Inbound exited beta.** The maturity gap that justified SendGrid no longer exists. Resend Inbound now ships as a documented production product with webhook signing (Svix-style HMAC), a Receiving Emails API, an Attachments API, and an `email.received` event subscription model.
2. **Vendor consolidation.** LeaseIO already pays Resend for outbound transactional email. Adding inbound to the same vendor means one bill, one set of API keys, one webhook signing pattern, one usage dashboard, one support relationship. This is a meaningful operational simplification at the operator-of-one stage.

**Architecture note on swap protection.** The vendor decision does not lock LeaseIO in. The v1 implementation must use an adapter pattern at `src/adapters/inbound-email/resend.ts` (with Deno mirror under `supabase/functions/_shared/inbound-email/`) that maps Resend's webhook payload into a normalized `InboundEmailEvent` interface. All downstream logic — workspace lookup, sender-match check, tier rate limit, attachment fetch, storage write, `process_lease` enqueue — operates on the normalized shape. Swapping to SendGrid later would mean writing a parallel `sendgrid.ts` adapter (~100–200 lines), updating the MX record on `leases.theleaseio.com`, toggling the `INBOUND_EMAIL_VENDOR` env var, and redeploying. Estimate: 4–8 hours of work plus a 24–48 hour DNS TTL cutover window.

**Implementation specifics for Resend Inbound:**

- The webhook event `email.received` carries metadata only — no body, no headers, no attachments. The edge function must call Resend's Receiving Emails API and Attachments API to fetch full content. This is a *feature* for the Supabase edge function context: large attachments aren't forced through the webhook body, which has size limits.
- Attachment fetch returns a `download_url` that the edge function uses to pull the PDF directly into Supabase storage.
- Webhook signature verification uses Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`). Verification logic stays inside the adapter.
- Webhook signing secret stored as Supabase edge function env var (`RESEND_WEBHOOK_SECRET`).

**Cost integration.** Resend's free tier is 3K emails/month with a 100/day cap. The cost model currently assumes free tier covers outbound only (~3K/mo at 30 workspaces, right at the edge). Adding inbound consumes against either the same bucket or a parallel bucket — this needs to be confirmed at build time via a 5-minute check in the Resend dashboard. If it's a shared bucket, free tier headroom shrinks materially; budget to move to Pro at $20/mo earlier than the cost model originally projected. The `OPERATIONAL_MONITORING_SPEC.md` already specifies tracking both `emails_30d` and `inbound_events_30d` as separate snapshots in `vendor_usage_snapshots`, with an assumption that splits if the bucket question resolves either way.

---

## Decision 2 — Domain choice

**Decision: `leases.theleaseio.com` (separate subdomain MX), with random unguessable tokens for the local-part.**

Subaddressing (`leases+slug-token@theleaseio.com`) is rejected. The plan correctly noted it "breaks for some senders," which understates the failure mode: corporate Microsoft Exchange and Outlook 365 configurations routinely strip the `+token` segment before forwarding. The highest-value sender persona for Path 2 — a corporate broker on Outlook 365 — is exactly the case most likely to silently fail. A silent routing failure for the most common sender persona is unacceptable for a feature whose entire premise is reliable third-party capture.

**Local-part format: random unguessable token, not workspace slug.**

Address shape: `intake-<random>@leases.theleaseio.com`, where `<random>` is at least 12 characters of crypto-random base32 or similar. Reasons:

- **Anti-spray.** Slug-based addresses (`acme@leases.theleaseio.com`) are guessable and sprayable; an attacker who learns one workspace's pattern can flood adjacent workspaces. Random tokens are not enumerable.
- **Backfill compatibility.** Decision 5 below pre-creates intake addresses for every existing workspace at migration time. Pre-created addresses with random tokens never collide with future vanity slugs the customer might want.
- **Vanity aliasing defers cleanly to v2.** A workspace owner who wants `acme@leases.theleaseio.com` can be granted an alias on top of the canonical token-based address as a v2 feature.

**DNS setup.** MX record on `leases.theleaseio.com` only, never on the root `theleaseio.com`. Routing all of `*@theleaseio.com` to Resend would break the `daniel@theleaseio.com` Google Workspace mailbox.

---

## Decision 3 — Sender-match policy default

**Decision: Domain allowlist + pending-sender queue at v1.** This diverges from the original plan, which proposed members + owner only at v1 with the queue deferred to v2.

The reason for the divergence: Strategic Rule #5 (capture every lease) requires Path 2 to handle third-party senders — brokers, lawyers, vendors. These senders are by definition not workspace members; if they were, they would use Path 1 (request workflow). A v1 that locks senders to members + owner only ships a feature that captures self-forwarded internal mail and nothing else. That delivers <30% of the strategic value of Path 2, which makes the v1 ship a plumbing-validation exercise rather than a real feature shipping.

The marginal scope to do this right at v1 is small: a `pending_intake_emails` table, a list view in the admin operations area (or as a banner on the leases-list page), and accept/reject actions. Estimate: ~0.75 sessions of additional work on top of the original v1 scope.

**v1 sender-match policy specifics:**

- Each workspace defines a domain allowlist at intake setup time (e.g., `joneslang.com`, `cushwake.com`, `*.law`). Stored in `workspace_intake_settings.allowed_sender_domains[]`.
- Inbound email from a sender in the allowlist is processed normally.
- Inbound email from a sender NOT in the allowlist is parked in `pending_intake_emails` with status `pending_review`. The admin gets an immediate notification (in-app + email). Admin actions: approve sender (process this email + add sender's domain to allowlist), approve once (process this email only), reject (move to `pending_intake_emails.status = 'rejected'`).
- Workspace members and owners are always allowed regardless of allowlist (no need to whitelist your own users).
- Pending review queue has a 30-day retention; older pending emails are auto-rejected and the PDFs purged.

**v2 enhancements (deferred):**

- Per-sender allowlist (specific email addresses, not just domains)
- Sender reputation scoring (auto-trust senders who've been approved 3+ times)
- Email-based approval (admin replies to notification with "approve" or "reject" — requires outbound from `leases.theleaseio.com`, which has its own DKIM/SPF setup work)

---

## Decision 4 — Quota-exceeded behavior

**Decision: Silent fail + admin notification at v1, bounce-to-sender deferred to v2. Confirmed as proposed.**

Bounce-to-sender requires hardening outbound from `leases.theleaseio.com` — DKIM/SPF/DMARC for the subdomain, sender authentication, abuse handling, template rendering. That is real v2 scope and would inflate the v1 build meaningfully. Deferring is correct.

The v1 silent-fail UX is bounded acceptably because (a) the customer-side admin sees the alert immediately, (b) it only triggers at quota cap (not in normal operation), and (c) the customer can manually reach out to the sender once they see the alert.

**Requirements for v1 silent-fail to be acceptable:**

1. Admin notification fires immediately (within seconds), not in a daily digest. Both in-app and email rails.
2. Notification content is high-signal: includes sender email address, subject line, attachment filename(s), received timestamp, and the specific cap that was exceeded. Admin can manually contact the sender if needed.
3. Rejected email metadata persists for 30 days in `pending_intake_emails` with status `rejected_quota` so the admin can review what was missed even after the alert email is gone.
4. Quota-exceeded events emit a row to the operational monitoring layer (cross-reference: `vendor_usage_snapshots` in `OPERATIONAL_MONITORING_SPEC.md`) so the trend is visible on the admin operations dashboard. Spiking quota rejections is a signal worth catching trend-wise, not just per-event.

**Tier-gating cross-reference.** The "quota" being exceeded here is per-tier daily intake cap (per Decision 6 below), not the Resend vendor cap. The vendor cap is a separate failure mode handled by the operational monitoring spec.

---

## Decision 5 — Backfill

**Decision: Backfill intake addresses for all existing workspaces at migration time, with `intake_enabled = false` as the default. Confirmed as proposed.**

Pre-creating addresses with random unguessable tokens has zero security cost (the addresses are not enumerable and not active until the customer toggles enabled). The UX benefit is real: opting in becomes a single toggle ("Enable email intake for this workspace") rather than a multi-step "generate address, configure allowlist, then enable" flow.

**Migration specifics:**

- New table: `workspace_intake_settings` with one row per workspace, created via the migration. Columns: `workspace_id`, `intake_address` (random token + suffix), `intake_enabled` (default `false`), `allowed_sender_domains[]` (empty array default), `daily_email_cap` (set per tier, see Decision 6), `created_at`, `updated_at`.
- Migration script generates the random token using `gen_random_bytes(8)` encoded as base32, prefixed with `intake-`.
- DNS / Resend domain registration is operator-side prerequisite and must happen before migration runs (otherwise the addresses exist in the DB but emails to them go nowhere).

**No retroactive sender allowlist seeding.** When intake is enabled by an owner, they configure allowed domains at that time. Pre-seeding from existing workspace member emails is rejected — those are LeaseIO users, not external senders, and their domains are not necessarily the broker/lawyer domains the customer wants to receive from.

---

## Decision 6 — Tier gating

**Decision: Email intake enabled on all tiers, with per-tier daily caps as the cost-protection mechanism.** This reframes the original binary (all-tiers vs Business-only).

Strategic Rule #5 requires capture-every-lease at every tier. A Plus customer's broker still emails PDFs; gating Path 2 to Business creates a coverage gap for the majority of customers. Meanwhile, the original cost concern (email intake has highest misfile rate, Plus has thinnest margin) is structurally protected by the Tier 1 classifier hard gate at $0.01 per misfile. The remaining cost exposure is small.

The right shape is per-tier rate limiting, not all-or-nothing tier access:

| Tier | Daily intake cap | Monthly intake cap | Notes |
|------|-----------------:|-------------------:|-------|
| Plus | 10 emails/day | 200/month | Hard cap; over-cap = silent fail + admin notification per Decision 4 |
| Pro | 50 emails/day | 1,000/month | Hard cap; conversion lever to Business if consistently hit |
| Business | 200 emails/day | unmetered/month | Effectively unlimited for normal operation |

Caps are stored as configurable values per workspace (`workspace_intake_settings.daily_email_cap`, `monthly_email_cap`) seeded from tier defaults at workspace creation, allowing per-workspace overrides if customer support negotiates them.

**Strategic and operational consequences:**

- Strategic Rule #5 (capture every lease) holds at every tier.
- Cost exposure bounded proportionally to ARPU. Plus customer can't drive runaway extraction cost — they hit cap first, and the Tier 1 classifier rejects misfiles at $0.01 each anyway.
- Conversion lever is natural: "you've hit your daily intake cap — upgrade to Pro to lift it" is a soft, value-aligned upgrade prompt rather than a feature paywall.
- Cap thresholds are tunable. v1 defaults are starting points; revisit after 60 days of real traffic.

**Cross-reference to operational monitoring.** Per-workspace daily intake counts feed `workspace_quota_snapshots` (Phase 3 deliverable in `OPERATIONAL_MONITORING_SPEC.md`). The 80% / 95% banner thresholds defined in the monitoring spec apply here: a Plus customer at 8/10 daily emails sees a soft banner; at 9.5/10 sees a persistent banner with upgrade CTA.

---

## Out-of-scope confirmations (no changes)

The plan's v1 out-of-scope list is ratified as-written. For the record:

- **Outbound notifications to senders (bounce/success email).** Deferred to v2. Requires `leases.theleaseio.com` outbound hardening (DKIM/SPF/DMARC), which is a real-scope dependency. Decision 4's silent-fail-with-admin-notification stands in for this at v1.
- **Non-PDF attachments.** PDF only at v1. The extraction pipeline is PDF-centric; supporting Word docs, images, etc., would multiply the misfile-classification surface area.
- **Email body parsing.** Body is metadata only. The PDF is the artifact LeaseIO extracts. Body content captured to `intake_metadata` JSONB for audit and possible future use, but not parsed at v1.
- **Multi-recipient / CC / reply-threading.** Single primary recipient match only. CC handling and reply chains are post-v1 nuance.
- **Dedicated `/app/intake/inbox` UI page.** Deferred to v2. v1 uses the existing leases-list page with a filter for `intake_source = 'email_intake'` plus a banner showing pending-review count linking to the pending-emails table.
- **Auto-forwarding rules from customer's mail server.** Customer-side configuration, not LeaseIO scope.

---

## Updated effort + ordering

The original plan estimated 2.75 sessions for v1. With Decision 3's expansion (domain allowlist + pending-sender queue at v1 instead of v2), revised estimate is **3.5 to 4 sessions** for v1 build.

This is the right tradeoff: 0.75–1.25 additional sessions to ship a v1 that delivers the actual strategic value of Path 2 versus a v1 that ships a self-forwarding plumbing demo. The work added is also the highest-leverage v1 work — the pending-sender queue is the difference between "broker emailed it, we missed it" and "broker emailed it, admin saw the pending review notification."

**Updated phasing:**

- **v1 (after these decisions are ratified):** 3.5–4 sessions of focused work. Ships: Resend Inbound integration, subdomain MX, random-token addresses, domain allowlist, pending-sender queue, silent-fail on quota with admin notification, backfilled disabled-by-default intake, per-tier daily caps, leases-list filter for intake-sourced records.
- **v2 (after v1 validates with real traffic):** Outbound notifications to senders, bounce-to-sender on quota, dedicated inbox UI, per-sender allowlist (beyond domain-level), sender reputation scoring.
- **v3 (gated on Phase 9 firm layer):** Firm-level aggregate inbox view, cross-workspace intake routing for CPA-firm child workspaces, per-firm domain allowlists.

**Cross-module dependency:** v1 should ship after Phase 2 of `OPERATIONAL_MONITORING_SPEC.md` is live. Reasons:

- The Resend usage poller (Phase 2 of monitoring) provides early warning when combined inbound + outbound traffic approaches the free-tier cap. Without it, the first sign of trouble is failed sends.
- The admin operations dashboard (Phase 2 of monitoring) is the natural surface for surfacing email-intake quota events trend-wise, not just per-event.
- Building email intake before monitoring means flying blind on the vendor cap until customers complain. Building monitoring first costs roughly 0 additional time because Phase 2 of monitoring is already on the path.

This is not a hard gate — email intake v1 can technically ship before monitoring Phase 2 — but it is a strong recommendation.

---

## Operator-side prerequisites that block v1 ship

These cannot be done by Claude Code:

1. **Resend Inbound domain registration.** Add `leases.theleaseio.com` as a receiving domain in the Resend dashboard. Mark as receiving (not sending). Capture the assigned MX hostname.
2. **DNS MX record.** Add MX record on `leases.theleaseio.com` (subdomain only, NOT root `theleaseio.com`) pointing to the Resend MX hostname at priority 10. No other MX records on this subdomain. Plan for 1–48 hour DNS propagation.
3. **Resend webhook registration.** Register a webhook endpoint in the Resend dashboard pointing to `https://<project-ref>.supabase.co/functions/v1/inbound-email`. Subscribe to the `email.received` event only. Capture the Svix signing secret.
4. **Supabase env vars.** Add `RESEND_WEBHOOK_SECRET` and `RESEND_API_KEY` (with usage-read + receiving scope) to Supabase edge function secrets.
5. **Inbound-vs-outbound bucket clarification.** Verify in Resend dashboard or via support whether `email.received` events count against the same monthly quota bucket as outbound sends. Update the cost model accordingly.
6. **Test sending.** From an external Gmail (not a member of any test workspace), send a PDF to a backfilled intake address. Verify webhook fires, lease record created, PDF lands in storage, classifier picks it up.

Estimated operator-side time: 1–2 hours of dashboard work + 24–48 hours waiting for DNS propagation. Plan accordingly when scheduling v1 build.

---

## Updates required to existing docs

When these decisions are ratified, the following documents should be updated by Claude Code:

1. **`docs/EMAIL_INTAKE_PLAN.md`** — Update the "Six open questions" section to reflect the decisions in this memo. Mark each question as resolved with a one-line summary and a reference back to this document. Update the schema sketch to include the `pending_intake_emails` table (Decision 3) and the per-tier cap columns on `workspace_intake_settings` (Decision 6). Update the v1 effort estimate from 2.75 to 3.5–4 sessions.

2. **`CLAUDE.md`** — Add a one-line entry under recent updates: "Email Intake decisions ratified per `docs/EMAIL_INTAKE_DECISIONS.md`. Vendor: Resend Inbound. Sender policy: domain allowlist + pending queue at v1. Tier gating: all tiers with per-tier daily caps."

3. **`docs/OPERATIONAL_MONITORING_SPEC.md`** — Already references Resend usage tracking and inbound events. Confirm the bucket assumption (single shared bucket vs separate inbound bucket) once verified per prerequisite #5 above; update the Resend adapter spec accordingly.

4. **Cost model spreadsheet** — Update the Resend line item assumption to factor in inbound events. If inbound shares the bucket with outbound, project free-tier exhaustion ~25 workspaces instead of ~30. If inbound has its own bucket, no change. Either way, budget for $20/mo Pro tier proactively rather than waiting for the cliff.

---

## Notes for Claude Code

- The adapter pattern for Resend Inbound (`src/adapters/inbound-email/resend.ts`) should mirror the adapter pattern from `OPERATIONAL_MONITORING_SPEC.md` (`src/adapters/monitoring/<vendor>.ts`). Same file shape, same Deno mirror requirement, same swap-protection goal.
- Webhook signature verification is non-optional and is the primary attack-surface defense for this feature. Implement signature verification first, before any happy-path logic. A failed signature should reject the request with 401 and write a security audit log entry — never process content from an unsigned webhook even in dev/test.
- The `pending_intake_emails` table needs RLS that mirrors `leases` table RLS — only workspace members can see pending emails for their workspace. Service role bypass for the edge function writer.
- Random token generation for intake addresses must use a cryptographically-secure RNG (`gen_random_bytes()` in Postgres, not `random()`). This is a security boundary; weak randomness lets an attacker enumerate addresses.
- Per-tier daily caps reset on workspace timezone (`workspace.timezone`), not UTC. A Pacific-time customer hitting "midnight reset" at UTC midnight is confusing UX. Use `DATE(received_at AT TIME ZONE workspace.timezone)` for cap counting.
- When implementing Decision 4's silent-fail behavior, the rejected email's PDF should be stored in storage (with a `quarantine` prefix) for 30 days for admin review, not deleted immediately. Storage cost is trivial; admin recovery option is real.
- When this memo is updated (new decisions, scope changes), update the "Status" line at the top and append an entry below this section noting what changed and why.

---

## Change log

*Append entries here when this memo is updated. Do not modify earlier entries.*

- **(initial)** Decisions 1–6 ratified. Plan doc commit 3c9b254 supersedes pending these updates. Email intake v1 build is unblocked from a decision standpoint; awaiting prioritization against operational monitoring and other in-flight work.
