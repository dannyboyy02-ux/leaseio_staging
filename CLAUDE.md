# CLAUDE.md — LeaseIO Project Context

Read this file first on every session. It contains the architecture, file map, strategic rules, and current task queue. Do NOT re-read the full repo — use this file plus the specific files referenced in each task. Closed phase specs are pointers; read the underlying `docs/PHASE_*_BUILD_SPEC.md` only when a task touches that phase's surface.

---

## Product Strategy — read before scoping any phase

**`docs/PRODUCT_STRATEGY.md`** is the source-of-truth strategic document (ratified 2026-05-04). Three tiers (Plus / Pro / Business), with Business tier being the structural inflection point — it's the only tier with a firm/organization layer that owns multiple workspaces. Two distinct buyer types map to Business tier (CPA firms with clients; parent companies with subsidiaries) and share the same architectural surface.

Build cadence is set: finish Phases 4–8 (current chain-workflow workstream) first, **then** open Phase 9 (firm layer foundation) and Phase 10 (firm UX). Do not pre-build the firm layer in Phases 4–8 — no prophylactic `firm_id` columns, no premature scaffolding. The strategy doc's "Implementation guidance for Phases 4-8" section lists the binding interpretation rules when ambiguity arises (workspace-scoped data, audit trails always include `workspace_id`, notifications stay workspace-scoped, etc.).

When a phase spec or implementation diverges from PRODUCT_STRATEGY.md, update the strategy doc with the new decision + rationale, bump the date in its header, and reference it in the phase spec's As-built notes.

---

## Approval Routing Architecture (active workstream)

The lease approval workflow is being rebuilt around admin-configurable **approval policies** (per-workspace matching criteria + per-stage chain steps), replacing the legacy fixed `manager_approver` / `financial_approver` parallel-notify model.

Source-of-truth docs live in the repo at `docs/`:

- **`docs/APPROVAL_ROUTING_ARCHITECTURE.md`** — full architecture brief. Read first when working on any approval-related ticket.
- **`docs/PHASE_1_BUILD_SPEC.md`** — **CLOSED.** Schema, RPCs, admin UI. Reference only.
- **`docs/PHASE_2_BUILD_SPEC.md`** — **CLOSED 2026-05-03.** Resolution engine + chain table, insert-as-draft-first, unified approver inbox.
- **`docs/PHASE_3_BUILD_SPEC.md`** — **CLOSED 2026-05-05.** Lifecycle expansion (7 new chain-vocabulary states alongside the 9 legacy). `src/lib/lifecycleStates.ts` + Deno mirror are the canonical helpers.
- **`docs/PHASE_4_BUILD_SPEC.md`** — **CLOSED 2026-05-05.** Negotiation document iteration tracking (`lease_documents` table, `lease-documents` storage bucket, `DocumentsPanel`).
- **`docs/PHASE_5_BUILD_SPEC.md`** — **CLOSED 2026-05-05.** Signator stage + counter-signature workflow. Adds `/app/leases/:id/signator-review` page with attestation gate, `CounterSignaturePanel`, scheduled reminder function (manual-trigger ready; production cron wiring is a deployment-checklist item).
- **`docs/PHASE_6_BUILD_SPEC.md`** — **CLOSED 2026-05-06.** Rerouting on material attribute changes. Flag-and-poll pattern (new to codebase). `ChainViolationBanner`, `RerouteHistorySection`, `/app/admin/reroute-audit`.
- **`docs/PHASE_7_BUILD_SPEC.md`** — **CLOSED 2026-05-06.** Delegation, override, OOO, exception handling. **Known deferred:** `resolve-approval-chain` redeploy still pending — newly-created chains have NULL Phase 7 columns (graceful degradation; cron functions skip them). Remediation in PHASE_7_BUILD_SPEC.md A4.
- **`docs/PHASE_8_BUILD_SPEC.md`** — **CLOSED 2026-05-06.** ASC 842 disclosure report generation. JSON schema contract pinned via `REPORT_SCHEMA_VERSION` and documented at `docs/JSON_REPORT_SCHEMA.md` — backward-incompatible changes require a major bump. Report library at `/app/reports/disclosure`; portfolio admin at `/app/admin/reports`.

### Owner Workspace Management — CLOSED 2026-05-05

- **`docs/OWNER_WORKSPACE_MGMT_BUILD_SPEC.md`** — **CLOSED.** Owner-facing UI at `/app/account/workspaces`. Reusable `MembersPanel`, rename inline, type-name-confirm delete backed by `delete-workspace` edge function with transactional cascade + storage cleanup. `deleted_workspaces` audit table.

### Parallel module — Market Data & IBR (spec only, not yet started)

- **`docs/MARKET_DATA_IBR_MODULE.md`** — **SPEC FILED 2026-05-05.** Independent workstream, NOT a phase. Does NOT consume a phase number. Migration SQL is inline in the spec doc, NOT in `supabase/migrations/` until the module opens. Standing rules below.

---

## Lifecycle Transition Convention

Any code that transitions `leases.lifecycle_status` MUST:

1. Update `leases.status_changed_at = now()` in the same UPDATE statement.
2. Insert a `lease_activity_log` row with `activity_type = 'status_change'`, populating **both** the top-level `from_status` and `to_status` columns **and** the equivalent fields inside the `details` JSON for backward compatibility.
3. Include a `routing_path` value in `details` (`'legacy'` or `'chain'`) so downstream consumers can distinguish how the transition was produced.

This convention exists to keep activity log shape consistent across the form-path writer (`src/components/workflow/LeaseRequestForm.tsx`) and the edge-function writer (`supabase/functions/act-on-chain-step/index.ts`). **Each new code path that transitions `lifecycle_status` must follow this convention.**

Reference implementations:
- **Form path** — `LeaseRequestForm.tsx` writes status_change with both shapes inline in the legacy and chain branches.
- **Edge function** — `act-on-chain-step/index.ts` uses two small helpers, `updateLifecycle()` and `logStatusChange()`, that enforce the rule for every branch. When you add a new transition trigger in this file, route it through these helpers; do not write the UPDATE or INSERT inline.
- **Pure chain logic** — `src/lib/approvalChainLogic.ts` and its Deno mirror `supabase/functions/_shared/approval_chain.ts` carry header pointers to this section.

---

## Schema Change Rule — Source of Truth

**Every schema change MUST be captured as a `.sql` migration file in `supabase/migrations/`. No exceptions.**

This rule exists because Supabase Studio and the MCP `apply_migration` tool can mutate the live project schema directly. When that happens without a corresponding committed `.sql` file, the repo silently drifts out of sync with prod and the migrations folder stops being trustworthy as the source of truth.

### Required workflow

When making any schema change — adding a table, column, constraint, RPC function, RLS policy, trigger, type, index, or grant:

1. Write the change as a SQL migration file first, named `<timestamp>_<descriptive_name>.sql`, and place it in `supabase/migrations/`.
2. Apply it via the migration system, not via direct Studio edits.
3. If a change has already been applied directly to the live project (via Studio, MCP, or any other path) without a migration file, immediately run `supabase db pull` and commit the resulting file to `supabase/migrations/` before proceeding with any further work.
4. Migrations must be idempotent where reasonable (`IF NOT EXISTS`, `IF EXISTS`, `OR REPLACE`) so they can run cleanly against fresh and existing environments.
5. Never edit a migration file after it has been applied to staging or production. To change schema, write a new migration.

### What counts as a schema change

- New tables, columns, indexes, constraints, types, sequences
- Changes to RLS policies (`CREATE POLICY`, `DROP POLICY`, `ALTER POLICY`)
- New or modified functions and triggers (`CREATE OR REPLACE FUNCTION`, `CREATE TRIGGER`)
- Permission grants and revokes (`GRANT`, `REVOKE`)
- Enum value additions
- View definitions

### What this means in practice

Before claiming a database-related task is complete, verify:
- [ ] The `.sql` file exists in `supabase/migrations/`
- [ ] The file has been committed to git
- [ ] The migration is idempotent or explicitly justified as not needing to be
- [ ] If the change was applied via Studio or MCP, `supabase db pull` was run and the result committed

If any of those is not true, the task is not complete.

---

## Project Configuration Source of Truth

The repo is the source of truth for all project configuration that can be expressed as code:

- **Edge functions** live in `supabase/functions/<name>/index.ts`, committed to git. Never deploy a function that does not exist in the repo. After any deployment, confirm the deployed code matches the committed file.
- **Secrets and environment variables** are documented (names only, no values) in `.env.example`.
- **Storage buckets, RLS policies on storage, auth settings** configured via Studio should be documented in `supabase/README.md`.

If a change cannot be expressed in the repo, document why in a comment near where its absence would be confusing.

---

## What LeaseIO Is

LeaseIO is the lease awareness and intake layer for mid-market finance teams. It ensures finance knows about every lease before or as it's signed, maintains an audit-defensible repository, and uses AI to abstract key terms from lease documents.

LeaseIO is **NOT** a lease accounting tool. It does not calculate ROU assets, generate journal entries, or produce ASC 842 disclosures. It works alongside whatever accounting tool a company already uses. It solves the problem that comes before accounting: awareness, control, and structured data.

**Positioning:** AI-as-a-Service (AaaS). The AI is the service; the software is the delivery mechanism. Lead with outcomes, not mechanisms.

## Tech Stack

- **Frontend:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions)
- **Deployment:** Vercel with CI/CD from GitHub
- **AI Engine:** Anthropic Claude (all three tiers — see AI Architecture below).
- **Billing:** Stripe (starter/business at $249/$499, monthly+annual, 7-day trial)
- **i18n:** i18next with English + Spanish locales
- **State:** TanStack React Query + React Context (AppContext, AuthContext, LanguageContext)

## Intake Architecture

**Path 1 — Front Door (Lease Request Workflow):** Department submits request → finance approves → document uploaded → AI abstracts → user confirms → repository. ONGOING.

**Path 2 — Side Door (Email Inbox):** Forward signed lease to dedicated email → AI abstracts automatically → Needs Review queue → user confirms → repository. **NOT YET BUILT.**

**Backdoor — Historical Portfolio Loader:** Toggleable onboarding form for loading existing leases. Admin-controlled. **NOT YET BUILT.**

**Amendment Sub-Workflow:** User navigates to existing lease → Add Amendment → upload → AI abstracts and compares → side-by-side view → user confirms → version history preserved. UI shell exists (`AmendmentChanges.tsx`), AI comparison logic does NOT exist in the extraction pipeline.

## AI Architecture — Claude's Three Roles

Claude is not just a feature inside LeaseIO. Claude IS LeaseIO's intelligence layer, operating in three distinct roles.

### Role 1: AI Engine (Extraction, Classification, Intelligence)

Three-tier pipeline, all powered by Claude API. The user never sees a model picker.

**Tier 1 — Extraction (Two-Pass Targeted Architecture):**

Do NOT send full documents to Opus in a single pass.

- **Pass 1 — Document Mapping (Claude Haiku):** Send full document to Haiku with a mapping prompt. Haiku returns a JSON page map of field-category → page-numbers (parties, dates, rent, escalation, renewal, termination, security_deposit, covenants).
- **Pass 2 — Targeted Extraction (Claude Opus):** Using the page map, group relevant pages into focused Opus calls. Each call gets 5–8 pages of highly relevant content instead of 30 pages of boilerplate.
- **Quality check:** If Haiku says rent is on pages 3–5 but Opus extracts no rent from those pages, flag the field for human review. The mapping disagreement IS the quality signal.
- **Merge step:** Merge extracted fields into the unified schema, deduplicate, score confidence per field, store.

Two-pass is both cheaper and more accurate than single-pass full-document Opus. For amendments, Pass 1 maps which sections changed; Pass 2 extracts only the changed terms and compares against parent lease abstractions.

**Tier 2 — Classification (Claude Haiku):** Fast routing. Is this a lease or invoice? Real estate, equipment, or vehicle? New lease or amendment? Routes to correct extraction prompt. Prevents expensive Tier 1 calls on non-lease documents.

**Tier 3 — Contextual Intelligence (Claude Sonnet):** Event-driven, not scheduled. Fires on state changes (new lease confirmed, amendment confirmed, renewal window opens). Compares new data against portfolio context. Generates insights only when meaningful.

**Model selection is never user-facing.** Opus for extraction, Sonnet for assistant + contextual, Haiku for classification + mapping.

### Role 2: Embedded AI Assistant

Conversational AI inside LeaseIO. User asks question → Supabase Edge Function queries the database (scoped to workspace via RLS) → packages relevant lease data as context → sends to Claude API → Claude reasons over the data and responds.

**Security:** Each API call includes ONLY data from the authenticated user's workspace. The edge function enforces RLS before any data reaches Claude. Claude never sees cross-workspace data.

### Role 3: AI Operator (Infrastructure & Maintenance)

Event-driven, not a persistent agent. GitHub Actions for diff review; Vercel webhooks for deploy monitoring; nightly health check script for route resolution, locale completeness, extraction pipeline responsiveness, stuck leases.

## Pricing Model

| | Starter | Business |
|---|---|---|
| **Price** | $249/month | $499/month |
| **Monthly Abstractions Included** | 15 | 50 |
| **Users** | 3 | Unlimited |
| **Lease Request Workflow** | Yes | Yes |
| **Document Upload + AI Abstraction** | Yes | Yes |
| **Dashboard + Audit Trail** | Yes | Yes |
| **Embedded AI Assistant ("Ask Claude")** | No | **Yes** |
| **Portfolio Intelligence** | No | Yes |
| **Amendment Comparison** | No | Yes |
| **Audit Package Generator** | No | Yes |
| **Custom Approval Playbook** | No | Yes |
| **Overage Rate** | $12/document | $10/document |

**No unlimited tiers.** All tiers maintain a 75% gross margin floor at maximum usage even if AI costs double.

### Onboarding Packs (one-time, historical portfolio load)

- Starter Pack — 15 docs / $200
- Growth Pack — 50 docs / $500
- Portfolio Pack — 150 docs / $1,200
- Additional — $12/doc

### Free Lease Audit (GTM lead magnet — NOT a subscription tier)

5 documents free → portfolio summary → upgrade CTA to Starter.

## File-to-Feature Map

Use this to scope file reads. Do NOT read files outside the relevant group unless explicitly needed.

### Authentication & User Management
```
src/contexts/AuthContext.tsx
src/contexts/AppContext.tsx
src/pages/Login.tsx
src/pages/Signup.tsx
src/pages/ForgotPassword.tsx
src/pages/ResetPassword.tsx
src/pages/AcceptInvite.tsx
src/components/auth/ProtectedRoute.tsx
src/components/auth/RequireRole.tsx
```

### Lease Request Workflow (Path 1)
```
src/components/workflow/LeaseRequestForm.tsx          — 680-line intake form
src/components/workflow/FinancialImpactPreview.tsx     — real-time financial calc preview
src/components/workflow/ParentLeaseCombobox.tsx        — parent lease selector for amendments
src/components/workflow/NudgeApproverButton.tsx        — approval nudge UI
src/hooks/useLifecycleWorkflow.ts                     — 515-line workflow state management
src/lib/approvalRouting.ts                            — pure function: approval chain logic
src/lib/leaseCalculations.ts                          — pure function: PV, commitment, straight-line
src/lib/lifecycleStates.ts                            — lifecycle state helpers (canonical, with Deno mirror)
```

### AI Extraction Pipeline
```
supabase/functions/process_lease/index.ts             — primary edge function (Claude two-pass)
supabase/functions/retry_lease/index.ts               — retry failed extractions
```

### Lease Review & Confirmation
```
src/pages/app/LeaseReview.tsx                         — 1,937-line primary lease workbench
src/components/leases/ExecutedTermsReview.tsx          — extracted terms review/edit
src/components/leases/LeaseReviewSections.tsx          — review section components
src/components/leases/NeedsReviewBanner.tsx            — review status banner
src/components/leases/RentScheduleTable.tsx            — rent schedule display
src/components/leases/VarianceReport.tsx               — expected vs actual comparison
src/components/leases/FailedLeaseBanner.tsx            — extraction failure UI
src/components/leases/ModelLockConfirmation.tsx        — finalization confirmation
src/components/leases/LeaseStatusBadge.tsx             — status badges (active component)
src/components/lifecycle/LifecycleStatusBadge.tsx      — lifecycle badges (active component)
```

### Amendments
```
src/components/leases/AmendmentChanges.tsx             — side-by-side change display (UI ready, no AI data)
src/components/leases/AmendmentsList.tsx               — amendment list for a lease
src/components/leases/UploadAmendmentDialog.tsx        — amendment upload dialog
src/components/leases/UploadExecutedDocumentDialog.tsx — executed doc upload
```

### Approval Queue
```
src/pages/app/ApprovalQueue.tsx                       — 633-line approval dashboard
src/components/dashboard/PendingApprovalsSection.tsx   — dashboard pending approvals
```

### Dashboard
```
src/pages/Dashboard.tsx                               — main dashboard (imports 6 active components)
src/components/dashboard/FinancialSummary.tsx          — KPI tiles
src/components/dashboard/OnboardingChecklist.tsx       — guided onboarding steps
src/components/dashboard/PendingApprovalsSection.tsx   — action-required approvals
src/components/dashboard/EscalationReviewPanel.tsx     — escalation monitoring
src/components/dashboard/CommitmentHistory.tsx         — commitment trend chart
src/components/dashboard/UpcomingEvents.tsx            — renewal/expiration calendar
```

### Portfolio (STUB — needs to be built)
```
src/pages/app/Portfolio.tsx                           — 29-line placeholder
```

### Leases List
```
src/pages/Leases.tsx                                  — lease table with sort/filter
src/components/leases/EmptyLeaseState.tsx              — empty state CTA
src/components/leases/DeleteLeaseDialog.tsx            — delete confirmation
src/components/leases/LeaseExports.tsx                 — CSV/PDF export
```

### Reports & Audit
```
src/pages/Reports.tsx                                 — reports page
src/pages/app/AuditLog.tsx                            — audit trail viewer
src/pages/app/ExtractionAnalytics.tsx                 — AI quality metrics (dev-only)
src/components/reports/RentRollExport.tsx              — rent roll export
```

### Settings
```
src/pages/settings/WorkspaceSettings.tsx              — workspace config + team management
src/pages/settings/AccountSettings.tsx                — user profile + billing
src/components/workspace/InviteMemberDialog.tsx        — team invite
src/components/workspace/MemberRoleSelect.tsx          — role assignment
src/components/workspace/PendingInvitesList.tsx        — pending invites
```

### Landing Page & Marketing
```
src/pages/Landing.tsx                                 — landing page shell
src/components/landing/HeroSection.tsx                 — hero with i18n keys
src/components/landing/FeaturesSection.tsx              — feature cards with i18n keys
src/components/landing/HowItWorksSection.tsx            — how it works section
src/components/landing/PricingSection.tsx               — pricing display
src/components/landing/FAQSection.tsx                   — FAQ (hardcodes faq key array)
src/components/landing/SecuritySection.tsx              — security section
src/components/landing/FooterSection.tsx                — footer
src/components/landing/LandingNav.tsx                   — landing navigation
```

### Locale Files (both must be updated together)
```
src/locales/en/common.json                            — English translations
src/locales/es/common.json                            — Spanish translations
```

### Pricing & Billing
```
src/config/pricing.ts                                 — plan definitions (starter + business)
supabase/functions/create-checkout/index.ts            — Stripe checkout
supabase/functions/check-subscription/index.ts         — subscription verification
supabase/functions/customer-portal/index.ts            — Stripe customer portal
```

### Routing
```
src/App.tsx                                           — all routes defined here
src/components/layout/AppSidebar.tsx                   — sidebar navigation + badge counts
src/components/layout/AppLayout.tsx                    — layout wrapper
src/components/layout/AppHeader.tsx                    — page header component
```

### Types
```
src/types/index.ts                                    — core types (User, Workspace, Lease, etc.)
src/types/lifecycle.ts                                — lifecycle types, state machine, status config
src/types/workflow.ts                                 — workflow types, confidence threshold
src/integrations/supabase/types.ts                    — auto-generated Supabase types
```

## Strategic Rules (DO NOT VIOLATE)

1. **LeaseIO is NOT a compliance tool.** Never add ASC 842 compliance features, journal entry generation, or ROU asset calculations. Never position copy as "compliance-ready." LeaseIO works ALONGSIDE compliance tools, not as one.

2. **Human-in-the-loop is the product.** Never build autonomous agents that act without user confirmation. The AI abstracts, the human confirms. That's the value proposition for finance teams.

3. **Claude is the AI engine. Model selection is never user-facing.** Opus for all extraction (two-pass targeted method). Sonnet for embedded assistant and contextual intelligence. Haiku for classification and document mapping. No OpenAI. Azure DI may be retained as fallback for scanned/handwritten documents only.

4. **Three roles for Claude.** (a) AI engine — two-pass extraction, classification, intelligence. (b) Embedded assistant — conversational interface for users. (c) AI operator — codebase monitoring, error detection, health checks. All three are deterministic pipelines or event-driven, not autonomous agents.

5. **Two ongoing intake paths only.** Path 1 (request workflow) and Path 2 (email inbox). The backdoor is temporary onboarding. Amendments are a sub-workflow on existing leases. No third ongoing path.

6. **Landing page copy must lead with outcomes, not mechanisms.** "Send us your leases, we'll tell you what's in them" — not "one platform for lease management." Never promise features that aren't shipped.

7. **Pricing — no unlimited tiers. 75% margin floor.** Starter ($249/mo, 15 abstractions included, $12 overage). Business ($499/mo, 50 abstractions included, $10 overage). Embedded AI assistant is Business-tier only. Onboarding packs: Starter Pack ($200/15 docs), Growth Pack ($500/50 docs), Portfolio Pack ($1,200/150 docs), additional at $12/doc. Free Lease Audit (5 docs) is the GTM lead magnet, not a subscription tier.

8. **The embedded AI assistant must only answer from structured data in the user's workspace.** It must never hallucinate lease terms, fabricate numbers, or reference data from other workspaces. Every response must be grounded in actual database records. When uncertain, it must say so.

9. **No silent vendor failures.** Every external vendor LeaseIO depends on must fall into exactly one of three states: (a) monitored via the `vendor-health-check` cron with snapshots written daily; (b) tracked in `vendor_renewal_calendar` with multi-stage reminders; (c) explicitly listed in `OPERATIONAL_MONITORING_SPEC.md` "out of scope" with a documented reason. There is no fourth state of "we'll notice if it breaks."

## Active Workstreams

Parallel workstreams currently in flight, beyond the numbered phases. Each has a dedicated spec; the entries here are pointers, not full status.

**Module: Operational Monitoring** — vendor health, quota tracking, renewal calendar, customer-facing quota warnings. Spec: `docs/OPERATIONAL_MONITORING_SPEC.md`.

- Phase 1 (no-code operational hardening) — VERIFICATION ARTIFACT FILED 2026-05-09 at `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md`. ~60 min of Daniel-side dashboard work still owed (Anthropic spending cap, registrar 2FA + auto-renew, Stripe webhook health, manual renewal calendar).
- Phase 2 (core monitoring infrastructure) — SHIPPED 2026-05-09 (commit `9a05bd7`). Admin dashboard at `/app/admin/operations`.
- Phase 3 (customer-facing & coverage expansion) — SHIPPED 2026-05-09 (commit `6393b25`). QuotaWarningBanner mounted in AppLayout (80% dismissible / 95% persistent). Backup-restore runbook at `docs/ops/backup-restore-runbook.md`. Stripe activated automatically; Sentry + Anthropic pending operator-side tokens.
- Phase 4 (firm-layer aggregation) — blocked until Phase 9 ships.

**Module: Email Intake (Path 2)** — strategic capture path for post-execution leases. Plan: `docs/EMAIL_INTAKE_PLAN.md`. Decisions ratified 2026-05-09 in `docs/EMAIL_INTAKE_DECISIONS.md`. Vendor: Resend Inbound. Sender policy: domain allowlist + pending-sender queue at v1. Tier gating: all tiers with per-tier daily caps. Status: ratified, not yet built.

**Module: Market Data & IBR** — see standing rules below. Spec: `docs/MARKET_DATA_IBR_MODULE.md`. Status: spec only, not yet started.

## Module: Market Data & IBR — Standing Rules

This module is a parallel workstream, NOT a numbered phase. Files, branches, feature flags, and migrations use the `module_market_data` prefix.

Market data ingestion (Treasury, SOFR, CPI) is autonomous but constrained:

- **Anomaly thresholds are non-negotiable without explicit human review.** Daily rate moves >100bp or CPI MoM >3% absolute → quarantine, not `market_rates` / `cpi_releases`. Threshold changes require a new migration documenting the change reason.

- **The `market_data_ingestion` function never writes if the source schema does not validate.** Schema mismatches mean Treasury or BLS changed something. Fail loudly into `market_data_audit_log` with the raw payload truncated for forensics. Do NOT attempt to "fix" partial data.

- **IBR documentation packets are immutable once generated.** A new packet per `ibr_calculations` row (including overrides and recalcs). Old packets are never deleted from Storage. Do NOT implement a "delete packet" feature even if requested.

- **`ibr_calculations` is append-only.** Overrides are new rows with `trigger_event = 'manual_override'`. Original calculation rows are never modified.

- **LeaseIO never certifies an IBR methodology.** Product copy, packet narrative, and UI text must describe LeaseIO's role as automation and documentation, NOT certification. Reject any string in code, copy, or PDF templates that says "LeaseIO certifies", "audit-defensible methodology by LeaseIO", "compliant rate", or similar.

- **`workspace_ibr_config` writes require role.** Only `controller`, `cfo`, or `external_advisor` can insert/update. Enforced at RLS, not just UI.

- **Free public data sources only.** No PitchBook, DealStats, S&P Capital IQ, Bloomberg without explicit approval. Treasury, FRED, BLS are a deliberate cost ceiling and scope boundary.

- **Module features are gated to Pro and Business tiers.** Plus tier sees a teaser/upgrade prompt only. Tier check at application layer; do NOT expose module endpoints to Plus users.

- **CPI escalations are never auto-applied.** Every escalation alert requires human review and approval. HITL by design.

- **Does not block and is not blocked by numbered phases.** Recommended sequencing: parallel with Phase 4–5 if capacity allows, or sequentially after.

Build order and module Definition of Done are detailed in `docs/MARKET_DATA_IBR_MODULE.md`.

## Known Schema Realities

- The DB column for lease limits is `document_limit` on the `workspaces` table. The frontend config uses `maxActiveLeases`. Same concept, different names. When writing to DB, use `document_limit`. When reading from frontend config, use `maxActiveLeases`.
- The `SubscriptionPlan` type in `src/config/pricing.ts` is `'starter' | 'business'` (reconciled 2026-05-07). `normalizePlanId` coerces any legacy `'free'` / `'pro'` values from the DB to `'starter'`. Stripe Products are wired (`prod_TlQhMebFLbmsbR` = starter, `prod_TlQhRntCDhkxfK` = business). Monthly Price IDs hardcoded in `create-checkout`/`stripe-webhook`; annual Price IDs sourced from `STRIPE_PRICE_STARTER_ANNUAL` / `STRIPE_PRICE_BUSINESS_ANNUAL` env vars and fail closed with 503 (`reason: 'annual_not_configured'`) if unset.
- Direct-upload lease creation happens in `supabase/functions/process_lease/index.ts`, NOT in `LeaseUploadModal.tsx`. The modal triggers the upload; the edge function creates/updates the lease record.
- The `workspace_approvers` table exists in the schema but has no read or write path in the frontend. Known gap.

## Known Bugs

Active bug tracking lives in **`docs/KNOWN_ISSUES.md`**. Each item is filed there with severity, location, and reproduction context, and gets a "RESOLVED <date>" stamp when fixed. Check that file before re-investigating any prior bug.

## Known Operational Dependencies

**Vendor admin access required.** The following vendor consoles must remain accessible at all times:

- Anthropic Console (spending caps, API key rotation)
- Supabase Dashboard (Management API tokens, billing, backups)
- Vercel Dashboard (usage, deployment health, billing)
- Resend Dashboard (transactional + inbound, API keys)
- Stripe Dashboard (webhook endpoints, payment health)
- Sentry (after Operational Monitoring Phase 3)
- Domain registrar for `theleaseio.com`

Loss of access to any of these is a P0 incident. 2FA recovery codes for each should be stored in a password manager Daniel can access independently of the primary device.

## Always Check For

When modifying any of the following areas, check whether the listed parallel-module spec needs updating before declaring the change complete.

**Operational monitoring touchpoints** (cross-reference: `docs/OPERATIONAL_MONITORING_SPEC.md`):

- Adding a new external vendor dependency → add an adapter under `src/adapters/monitoring/` and a row to the vendor table in `OPERATIONAL_MONITORING_SPEC.md`
- Changing a tier's quota limits → update the customer-facing banner thresholds in `QuotaWarningBanner.tsx` and the tier-limit constants
- Adding a new edge function that calls a paid API → verify the call cost is bounded (per-invocation rate limit or upstream spending cap)
- Modifying Stripe webhook subscriptions → verify the subscription list still matches what the codebase consumes; update Phase 1 audit notes
- Adding a new card-on-file at any vendor → add a row to `vendor_renewal_calendar` for the card expiration date

**Email intake touchpoints** (cross-reference: `docs/EMAIL_INTAKE_PLAN.md` + `docs/EMAIL_INTAKE_DECISIONS.md`):

- Adding a new lease lifecycle stage → verify email-sourced leases enter the right stage (`intake_source = 'email_intake'`); ensure no special-case logic in `process_lease` bypasses Tier 2 / Tier 3 for email-sourced documents
- Changing the `is_workspace_member` RLS helper → verify `workspace_intake_settings` still grants admin/owner write access
- Modifying tier defaults in `src/config/pricing.ts` → update per-tier daily/monthly intake caps in the email-intake schema/seed data accordingly

**GitHub Actions / CI workflow gotchas** (cross-reference: any change to `.github/workflows/*.yml`):

- `secrets.*` context is **not** available in step-level `if:` expressions. It is only valid in `env:`, `with:`, and **job-level** `if:`. When gating a step on whether a secret is set: hoist the secret to job-level `env:`, then check `env.*` in the step's `if:`. A step-level `if:` referencing `secrets.*` silently invalidates the entire workflow file at parse time — every triggered run shows "completed/failure" with zero job rows.
- A workflow run that shows "failure" with zero job rows / zero check-runs / zero logs means the YAML failed validation at parse time — the file never compiled, no job ever ran. Don't assume a job ran and failed. When investigating a CI failure, **first** check whether jobs actually appear in the run; if not, the workflow file itself is broken and the proximate error message lives only in the GitHub Actions UI (not in the runs API).
- Before pushing any edit to `.github/workflows/*.yml`: grep for `if:` blocks referencing `secrets.*` at step level (`grep -nE "^\s*if:.*secrets\." .github/workflows/*.yml`). Reject those.
- After introducing or modifying any CI workflow, verify the next 1–2 runs actually compiled and produced job rows in the Actions tab. Don't assume green = working or red = test failure without confirming run structure first. Poll pattern: hit `/repos/.../actions/runs?head_sha=<full_sha>` (full SHA, not short — the short-SHA query may not match), then `/jobs` to confirm `total_count > 0`.

**Supabase migration management** (cross-reference: any change to `supabase/migrations/`):

- When `supabase db pull` reports migration history drift with timestamps off by 1–2 seconds between local files and remote `schema_migrations`, do **not** blindly run the suggested 100+ migration repair commands. The CLI's suggestion reconciles state but may not match your archival/squash intent. Prefer `supabase db dump` (snapshots schema without consulting `schema_migrations`) → archive historicals → metadata-only reconcile via a single targeted SQL transaction. Take a JSON capture of `schema_migrations` before any DELETE+INSERT on it; the `created_by` attribution column is otherwise unrecoverable.
- `db dump --schema public,storage` does **not** include `CREATE EXTENSION` declarations (extensions live in the `extensions` schema). When using a dump as a baseline migration, pre-patch the top of the file with `CREATE EXTENSION IF NOT EXISTS` for every extension the historical chain installed (`pg_cron`, `pg_net`, `pgcrypto`, `uuid-ossp`, etc.).
- `CREATE TYPE` does not support `IF NOT EXISTS`. When a dump-as-baseline includes `CREATE TYPE` for a Supabase platform-owned type (e.g. `storage.buckettype`), wrap in `DO $$ BEGIN CREATE TYPE ...; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` to make replay idempotent.
- `db dump --schema public,storage` will also try to redeclare the entire platform-owned `storage` schema (tables, indexes, triggers, FKs, 17 functions). The migration runner role cannot apply those — `permission denied for schema storage`. The right approach is `--schema public` only, plus a small companion file containing **only** the storage.objects `CREATE POLICY` statements your app owns. Each policy preceded by `DROP POLICY IF EXISTS` for idempotency.
- When squashing a migration chain, the test that matters is "does the baseline alone replay cleanly?" — **not** "do baseline + historicals replay together." Archive historicals **before** running `supabase db reset` to test the baseline; otherwise you're just re-testing the broken chain you set out to fix.

## Subagent Routing — Required Before Declaring Any Change Complete

LeaseIO has six project-level subagents defined in `.claude/agents/`. Before any change is declared complete, route review through the appropriate agents below. The routing rule is mandatory, not optional — these agents exist because each protects a part of the product the main session is too close to its own work to police.

| Agent | When to invoke |
|---|---|
| **lease-code-auditor** | On every code change. Scans diff for dead code, broken references, deprecated APIs, unreachable paths and unused exports. |
| **lease-security-scanner** | On every code change. Hardcoded secrets, missing input validation, injection risks, IDORs, and — most importantly — missing or UI-only authorization checks. |
| **lease-repository-integrity-reviewer** | When the change touches lease data storage, import, edit flows, audit logging, reporting, permissions, approval workflows, or lifecycle policy enforcement. Defends the "customer entered it, we stored it faithfully, every change is attributable" premise. |
| **lease-product-polish** | When the change touches any user-facing surface — copy, errors, empty states, dialogs, onboarding, import, exports, keyboard nav, anything a customer sees. Defends against friction, opacity, and SaaS-isms for the SMB finance user. |
| **lease-test-author** | Alongside the reviewers — covers gaps they surface and proactively identifies missing coverage. Prioritizes lifecycle transitions, audit-trail correctness, server-side governance, reporting edge cases, and import/export fidelity. Runs the tests and reports results honestly. |
| **lease-explorer** | On demand, before making changes to an unfamiliar area. Read-only navigator that summarizes purpose, key files, entry points, data flow, and fragility — so the main session doesn't burn context reading the area itself. |

### Routing in practice

- Code change with no user-facing surface and no data-path impact → `lease-code-auditor` + `lease-security-scanner` + `lease-test-author`.
- Code change with user-facing surface → add `lease-product-polish`.
- Code change touching data, audit, governance, or reporting paths → add `lease-repository-integrity-reviewer`.
- Pre-work on an area I haven't recently touched → invoke `lease-explorer` first.

If multiple reviewers are needed and their work is independent, invoke them in parallel (one message, multiple `Agent` calls). Address every Critical and High finding from the security and integrity reviewers before declaring the change complete; record any deferred Mediums/Lows explicitly. If a reviewer surfaces a Critical or High finding, the change is not complete — even if the code works. "Works" and "complete" are not the same.

### Surfacing Critical and High findings for approval

Every Critical and High finding from any reviewer must be surfaced to me before any fix is attempted. Do not auto-remediate Critical or High findings, do not bundle them into the next change, and do not decide on my behalf which are real and which are false positives. For each Critical or High finding, present: the agent that flagged it, the file:line reference, the agent's one-sentence description and risk explanation, the agent's suggested fix, and your own brief assessment of whether you think it's a true finding or a likely false positive. Then wait for my decision on each one — fix now, defer with a recorded reason, or dismiss as false positive. Mediums and Lows can be summarized in a list and addressed at your discretion, but if you choose to defer any of them, record that decision in the change summary so I can review the pattern over time.

**Pre-existing issues surfaced (not introduced) by the current beat are their own beat.** When a reviewer or baseline pass surfaces production issues that predate the current change (security regressions, broken policies, dropped guards), file them in `docs/KNOWN_ISSUES.md` with stub remediation migrations and a brief root-cause hypothesis. Do **not** bundle the fix into the current commit. The current beat's scope is what got it routed through review; the surfaced issues deserve their own scoped commits with their own reviewer routing. Surfacing-vs-fixing are separate concerns. A baseline squash that documents a broken state is not the same as a commit that fixes the broken state, and conflating them muddies both the audit trail and the reviewer history.

## Files That Were Deleted (orphaned dead code — removed per audit)

If you encounter references to these files, they are stale and should be cleaned up:

Pages: `Index.tsx`, `Auth.tsx`, `Integrations.tsx`, `LeaseDetail.tsx`
Components: `NavLink.tsx`, `CreateLeaseDrawer.tsx`, `WorkflowStatusBadge.tsx`, `NudgeButton.tsx` (lifecycle/), `ApproverSelect.tsx`, `ApprovalActions.tsx`, `RejectedLeaseCallout.tsx`, `LeaseCard.tsx`, `ReviewCard.tsx`, `PipelineView.tsx`, `NotificationConfigurator.tsx`, `QuickStats.tsx`, `UsageMeter.tsx`, `LeaseQuickView.tsx`
Archived (not deleted, may reuse): `CovenantHealthPanel.tsx`

## Task Queue

### Closed (do not re-open)

- Tasks 1–5 — shipped (orphaned-file cleanup; Support.tsx email + Onboarding plan default + AcceptInvite redirect + QuickBooks removal + FAQSection cleanup; AaaS landing copy + ASC 842 references removed; intake_source provenance; backdoor toggle in WorkspaceSettings). Owner workspace management also shipped (separate workstream). See git log.
- **Embedded AI assistant** — shipped at `src/components/ai/AiAssistant.tsx` + `supabase/functions/ai-assistant/index.ts`. Business-tier only, workspace-scoped RLS, mounted in `AppLayout.tsx`.
- **AI engine migration to Claude two-pass extraction (Tier 1)** — shipped in `supabase/functions/process_lease/index.ts`. Haiku page-mapping + single combined Opus call with page-group hints injected (as-built deviation from per-spec separate calls — same accuracy, lower cost). Azure DI removed. Deprecated OpenAI path remains as `_extractLeaseDataWithOpenAI_DEPRECATED` (~340 dead lines, safe to delete in a cleanup commit).
- **Tier 2 classification AI** — CLOSED 2026-05-08. Five-phase build: hard-gate pre-Tier-1; soft warnings; parent-lease auto-detection; in-context learning from corrections (`classification_corrections` table); override path for false rejections. NOT model fine-tuning — in-context only; corrections never cross workspace boundaries.
- **Tier 3 contextual AI v1** — SHIPPED 2026-05-08 (commit `7aeae7d`). `lease_insights` table, `generate-lease-insights` edge function (Sonnet, Business-gated, ~$0.04-0.08/call), `LeaseInsightsCard` on lease review. Manual-trigger only; auto-trigger wiring is v2.
- **Pricing reconciliation** — closed 2026-05-07. starter/business at $249/$499 with monthly + annual + 7-day free trial.

### Open / unstarted

- **Build email intake inbox (Path 2)** — requires email service selection and new edge function. See Email Intake module above.
- **Build backdoor historical portfolio loader form** — requires the toggle from closed Task 5.
- **Build free lease audit mode** — 5 docs, portfolio summary, upgrade CTA. Marketing-funnel surface; not part of subscription tiers.
- **Wire amendment comparison intelligence into process_lease** — fetch parent lease terms, generate `_amendment_changes` array.
- **Build portfolio intelligence dashboard** — replace Portfolio.tsx stub with real analytics.
- **Set up AI operator** — GitHub Actions for Claude-powered diff review, Vercel webhook for deploy monitoring, nightly health check script.
- **Phase 9 (firm layer foundation)** — spec at `docs/PHASE_9_BUILD_SPEC.md`, filed dormant. Opens when explicitly invoked.
- **Phase 10 (firm UX)** — spec at `docs/PHASE_10_BUILD_SPEC.md`, filed dormant. Opens after Phase 9.
