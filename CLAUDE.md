# CLAUDE.md — LeaseIO Project Context

Read this file first on every session. It contains the product identity, architecture, file map, active priorities, hard rules, and gotchas. Do NOT re-read the full repo — use this file plus the specific files referenced in each task. Closed phase specs are pointers; read the underlying `docs/PHASE_*_BUILD_SPEC.md` only when a task touches that phase's surface. Historical detail trimmed from this file lives in `docs/CLAUDE_md_archive.md`.

> **▶ RESUMING WORK ON BRANCH `claude/dazzling-franklin-klts6u`?** Read **`docs/SESSION_HANDOFF_2026-06-13.md`** first — it's the durable handoff from the Vault-tier + security-cluster session (what shipped, the 7 migrations applied, what's left: #94 + #90-NULL + the operator Stripe STOP 10/3/7 items, and the verify-don't-recall / security-migration-review discipline that session ran on). Delete this banner once that work is merged/closed.

---

## What LeaseIO Is

LeaseIO is the lease awareness and intake layer for mid-market finance teams. It ensures finance knows about every lease before or as it's signed, maintains an audit-defensible repository, and uses AI to abstract key terms from lease documents.

LeaseIO is **NOT** a lease accounting tool. It does not calculate ROU assets, generate journal entries, or produce ASC 842 disclosures. It works alongside whatever accounting tool a company already uses. It solves the problem that comes before accounting: awareness, control, and structured data.

**Positioning:** AI-as-a-Service (AaaS). The AI is the service; the software is the delivery mechanism. Lead with outcomes, not mechanisms — "send us your leases, we'll tell you what's in them," never "one platform for lease management."

## Tech Stack

- **Frontend:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions)
- **Deployment:** Vercel with CI/CD from GitHub
- **AI Engine:** Anthropic Claude (all three tiers — see AI Architecture below)
- **Billing:** Stripe (starter/business at $249/$499, monthly+annual, 7-day trial)
- **i18n:** i18next with English + Spanish locales (both locale files updated together)
- **State:** TanStack React Query + React Context (AppContext, AuthContext, LanguageContext)

## Product Strategy

**`docs/PRODUCT_STRATEGY.md`** is the source-of-truth strategic document (ratified 2026-05-04). Three tiers (Plus / Pro / Business); **Business tier is the structural inflection point** — the only tier with a firm/organization layer that owns multiple workspaces. Two buyer types map to it (CPA firms with clients; parent companies with subsidiaries), sharing the same architectural surface.

Build cadence: Phases 4–8 (chain-workflow workstream) are **closed**; Phase 9 (firm layer foundation) and Phase 10 (firm UX) are filed dormant and open only when explicitly invoked. **Do not pre-build the firm layer** — no prophylactic `firm_id` columns, no premature scaffolding. The strategy doc's "Implementation guidance for Phases 4-8" section holds the binding interpretation rules (workspace-scoped data, audit trails always include `workspace_id`, notifications stay workspace-scoped).

When a phase spec or implementation diverges from PRODUCT_STRATEGY.md, update the strategy doc with the new decision + rationale, bump its header date, and reference it in the phase spec's As-built notes.

---

## Architecture

### Intake paths

**Path 1 — Front Door (Lease Request Workflow):** Department submits request → finance approves → document uploaded → AI abstracts → user confirms → repository. ONGOING.

**Path 2 — Side Door (Email Inbox):** Forward signed lease to dedicated email → AI abstracts → Needs Review queue → user confirms → repository. **NOT YET BUILT** (see Email Intake workstream).

**Backdoor — Historical Portfolio Loader:** Toggleable admin-controlled onboarding form for existing leases. **NOT YET BUILT** (toggle exists in WorkspaceSettings).

**Amendment Sub-Workflow:** Existing lease → Add Amendment → upload → AI abstracts & compares → side-by-side → confirm → version history preserved. UI shell exists (`AmendmentChanges.tsx`); `process_lease/index.ts` populates a `_amendment_changes` array on the executed/amendment path (verify completeness before treating the comparison pipeline as fully done).

Only two ongoing intake paths exist (Path 1, Path 2). The backdoor is temporary onboarding; amendments are a sub-workflow. No third ongoing path.

### AI Architecture — Claude's Three Roles

Claude IS LeaseIO's intelligence layer. **Model selection is never user-facing.**

**Role 1 — AI Engine** (three-tier pipeline, all Claude API):
- **Tier 1 Extraction (two-pass targeted):** Do NOT send full documents to Opus in one pass. Pass 1 — **Haiku** maps full document → JSON page map of field-category → page-numbers (parties, dates, rent, escalation, renewal, termination, security_deposit, covenants). Pass 2 — **Opus** extracts from grouped relevant pages (5–8 focused pages per call, not 30 of boilerplate). Quality signal: if Haiku says rent is on pp.3–5 but Opus extracts none there, flag for human review. Merge → dedupe → score confidence per field → store. Cheaper and more accurate than single-pass full-document Opus. For amendments, Pass 1 maps changed sections; Pass 2 extracts changed terms vs parent.
  - *As-built:* `process_lease/index.ts` does Haiku page-mapping + a single combined Opus call with page-group hints injected (deviation from per-spec separate calls — same accuracy, lower cost).
- **Tier 2 Classification (Haiku):** Fast routing — lease vs invoice? real estate/equipment/vehicle? new vs amendment? Gates expensive Tier 1 calls. Includes in-context learning from corrections (`classification_corrections` table; never crosses workspace boundaries).
- **Tier 3 Contextual Intelligence (Sonnet):** Reserved for portfolio-wide reasoning that genuinely needs Sonnet judgment (cross-lease pattern detection, renewal-window risk scoring, escalation outlier flagging). Not currently surfaced — the earlier per-lease `generate-lease-insights` card was removed in 2026-06-03 because it duplicated Documents-tab summary value without earning its AI cost. When this tier opens it must operate over the whole portfolio, not a single lease.

**Role 2 — Embedded AI Assistant:** Conversational AI. Edge function queries DB (workspace-scoped via RLS) → packages lease data → sends to Claude → responds. Business-tier only. `src/components/ai/AiAssistant.tsx` + `supabase/functions/ai-assistant/index.ts`, mounted in `AppLayout.tsx`. Each call includes ONLY the authenticated workspace's data; Claude never sees cross-workspace data.

**Role 3 — AI Operator:** Event-driven, not a persistent agent. GitHub Actions for diff review; Vercel webhooks for deploy monitoring; nightly health check (route resolution, locale completeness, extraction responsiveness, stuck leases). NOT YET BUILT.

### Approval routing

The lease approval workflow is built around admin-configurable **approval policies** (per-workspace matching criteria + per-stage chain steps), replacing the legacy fixed `manager_approver` / `financial_approver` parallel-notify model. **Read `docs/APPROVAL_ROUTING_ARCHITECTURE.md` first on any approval ticket.**

Phases 1–8 are all CLOSED (schema/RPCs/admin UI → resolution engine + chain table → lifecycle expansion → negotiation docs → signator/counter-signature → rerouting on material changes → delegation/override/OOO/exceptions → ASC 842 disclosure reports). Each has a `docs/PHASE_N_BUILD_SPEC.md`; closed-phase as-built detail is in `docs/CLAUDE_md_archive.md`. Owner Workspace Management also shipped (now the My Workspaces panel at `/app/settings/workspaces`; the old `/app/account/workspaces` route redirects).

**Active deferred item (Phase 7):** `resolve-approval-chain` redeploy is permanently deferred — newly-created chains have NULL Phase 7 columns (graceful degradation; cron functions skip them). Remediation SQL in `PHASE_7_BUILD_SPEC.md` A4.

Canonical helpers: `src/lib/lifecycleStates.ts` (+ Deno mirror); pure chain logic in `src/lib/approvalChainLogic.ts` (+ Deno mirror `supabase/functions/_shared/approval_chain.ts`).

---

## Pricing Model

| | Starter | Business |
|---|---|---|
| **Price** | $249/month | $499/month |
| **Monthly Abstractions Included** | 15 | 50 |
| **Users** | 3 | Unlimited |
| **Lease Request Workflow / Upload + AI Abstraction / Dashboard + Audit Trail** | Yes | Yes |
| **Embedded AI Assistant / Portfolio Intelligence / Amendment Comparison / Audit Package / Custom Approval Playbook** | No | **Yes** |
| **Overage Rate** | $12/document | $10/document |

**No unlimited tiers. 75% gross-margin floor at max usage even if AI costs double.**

- **Onboarding Packs** (one-time historical load): Starter 15 docs/$200 · Growth 50 docs/$500 · Portfolio 150 docs/$1,200 · additional $12/doc.
- **Document Capacity Packs** (recurring monthly add-on, both tiers): 10 leases/$90 ($9/ea) · 20/$160 ($8/ea) · 50/$350 ($7/ea). Each pack is its OWN Stripe subscription (full price on purchase, no proration, cancel-at-period-end) tagged `metadata.addon_type='document_pack'` so the webhook never confuses it with a plan sub. A pack raises BOTH the monthly-abstraction allowance AND the active-lease cap by its size; capacity is additive (`workspaces.addon_document_capacity` = sum of active pack sizes, written only by the webhook, guarded by the #29 entitlement trigger). Every pack's per-lease price beats both overage rates, so a pack is always the cheaper relief valve. Quota stays the proven rolling-30-day window (NOT billing-period-aligned — descoped 2026-06-11; honest copy covers the rolling semantics). Config: `DOCUMENT_PACKS` in `pricing.ts` + Deno mirror `supabase/functions/_shared/document_packs.ts`; Stripe Price IDs from `STRIPE_PRICE_PACK_{10,20,50}` env (fail-closed if unset). **At the cap**, the limit wall (`LimitReachedDialog`, gating Leases/Dashboard intake + an upload-modal server backstop) offers upgrade (Starter only) / pack / **buy-1-lease at the overage rate** — a one-time PaymentIntent granting one `workspaces.purchased_lease_credits` credit via the idempotent `lease_credit_purchases` ledger, consumed atomically by `consume_lease_credit()` in `process_lease`. No auto-charged overage, ever — every over-cap dollar is an explicit consented purchase.
- **Free Lease Audit** (GTM lead magnet, NOT a tier): 5 docs free → portfolio summary → upgrade CTA to Starter.

---

## File-to-Feature Map

Use this to scope file reads. Do NOT read files outside the relevant group unless needed.

**Auth & User Mgmt:** `src/contexts/{AuthContext,AppContext}.tsx`, `src/pages/{Login,Signup,ForgotPassword,ResetPassword,AcceptInvite}.tsx`, `src/components/auth/{ProtectedRoute,RequireRole}.tsx`

**Lease Request Workflow (Path 1):** `src/components/workflow/{LeaseRequestForm,FinancialImpactPreview,ParentLeaseCombobox,NudgeApproverButton}.tsx`, `src/hooks/useLifecycleWorkflow.ts`, `src/lib/{approvalRouting,leaseCalculations,lifecycleStates}.ts`

**AI Extraction Pipeline:** `supabase/functions/process_lease/index.ts` (primary, two-pass), `supabase/functions/retry_lease/index.ts`

**Lease Review & Confirmation:** `src/pages/app/LeaseReview.tsx` (primary workbench), `src/components/leases/{ExecutedTermsReview,LeaseReviewSections,NeedsReviewBanner,RentScheduleTable,VarianceReport,FailedLeaseBanner,LeaseStatusBadge}.tsx`, `src/components/lifecycle/LifecycleStatusBadge.tsx`

**Amendments:** `src/components/leases/{AmendmentChanges,AmendmentsList,UploadAmendmentDialog,UploadExecutedDocumentDialog}.tsx`

**Approval Queue:** `src/pages/app/ApprovalQueue.tsx`

**Dashboard:** `src/pages/Dashboard.tsx` + `src/components/dashboard/{OnboardingChecklist,SummaryStrip,NeedsAction,LeasePipeline,UpcomingRisks,RecentActivity,PipelineByDepartment,IntakeTrend,UpcomingEvents,EscalationReviewPanel,PendingCounterSignatureCard}.tsx`

**Portfolio:** `src/pages/app/Portfolio.tsx` + `src/lib/portfolioAnalytics.ts` (PV liability, asset/escalation mix, lease register, index-lease disclosure). Business-tier gated (#46 RESOLVED 2026-06-02); also opened read-only for Vault via `isReadOnlyRetention()` (V3).

**Leases List:** `src/pages/Leases.tsx`, `src/components/leases/{EmptyLeaseState,ArchiveLeaseDialog,LeaseExports}.tsx` (list "Delete" is restorable ARCHIVE via `ArchiveLeaseDialog` since #79/#92; `DeleteLeaseDialog` is now only ImportHistory's hard-delete/import-rollback).

**Vault tier:** `src/components/VaultBanner.tsx` (owner banner + member wall), `src/config/pricing.ts` (`isReadOnlyRetention`), `supabase/functions/vault-renewal-reminder/index.ts`; read-only gating threaded via a `readOnly` prop through LeaseReview + locked-lease components. See `docs/VAULT_TIER_SPEC.md`.

**Reports & Audit:** `src/pages/Reports.tsx`, `src/pages/app/{AuditLog,ExtractionAnalytics}.tsx` (ExtractionAnalytics is dev-only), `src/components/reports/RentRollExport.tsx`

**Settings:** `src/pages/settings/{WorkspaceSettings,AccountSettings}.tsx`, `src/components/workspace/{InviteMemberDialog,MemberRoleSelect,PendingInvitesList}.tsx`

**Landing & Marketing:** `src/pages/Landing.tsx`, `src/components/landing/{HeroSection,FeaturesSection,HowItWorksSection,PricingSection,FAQSection,SecuritySection,FooterSection,LandingNav}.tsx`

**Locales (update together):** `src/locales/{en,es}/common.json`

**Pricing & Billing:** `src/config/pricing.ts`, `src/components/billing/PlanPickerDialog.tsx` (the Billing-tab "Adjust plan" picker), `supabase/functions/{create-checkout,stripe-webhook,customer-portal,get-billing-summary}/index.ts` (`get-billing-summary` is a read-only owner/admin-gated fn returning the saved card brand+last4 + recent invoices for the in-app Billing tab; `verify_jwt = true`)

**Routing:** `src/App.tsx` (all routes), `src/components/layout/{AppSidebar,AppLayout,AppHeader}.tsx`

**Types:** `src/types/{index,lifecycle,workflow}.ts`, `src/integrations/supabase/types.ts` (auto-generated)

---

## Active Priorities

### Open / unstarted

- **Email intake inbox (Path 2)** — Resend Inbound; domain allowlist + pending-sender queue at v1; all tiers with per-tier daily caps. Plan: `docs/EMAIL_INTAKE_PLAN.md` + `docs/EMAIL_INTAKE_DECISIONS.md` (ratified 2026-05-09, not yet built).
- **Backdoor historical portfolio loader form** — toggle already exists in WorkspaceSettings.
- **AI operator** — GitHub Actions diff review, Vercel deploy webhook, nightly health check script.
- **Phase 9 (firm layer foundation)** / **Phase 10 (firm UX)** — specs filed dormant; open only when explicitly invoked.

> NOTE (drift corrected 2026-06-13, verify before trusting): **Free lease audit** is NOT unstarted — `src/pages/LeaseAudit.tsx` is built and routed at `/lease-audit` (+ `audit-session` edge function). **Amendment comparison** is NOT absent — `process_lease/index.ts` populates `_amendment_changes` (the executed/amendment path); confirm completeness before treating it as done. Re-verify against the repo, don't trust this doc's older "unstarted" framing.

### Shipped 2026-06-13 (Vault-tier + security session — see `docs/SESSION_HANDOFF_2026-06-13.md`)

- **Vault retention tier V1–V4 — SHIPPED** ($249/yr read-only owner-only offramp; PRODUCT_STRATEGY.md Decision 5 + `docs/VAULT_TIER_SPEC.md` as-built notes). V1 server-side read-only enforcement (KNOWN_ISSUES #75 RESOLVED), V2 plan plumbing (`'vault'` in `SubscriptionPlan`), V3 convert-at-grace conversion flows, V4 in-product read-only experience. **Operator-gated:** no customer can reach a Vault conversion until OPERATOR_PLAYBOOK STOP 10 (create the Vault Stripe Product/Price + `STRIPE_PRICE_VAULT_ANNUAL` + `VAULT_RENEWAL_CRON_SECRET` + schedule the `vault-renewal-reminder` cron). Open follow-ups: #94 (executed-upload lifecycle convention) + #90-NULL (activity-log NULL-attribution tightening).

### Active parallel workstreams (pointers, not full status)

- **Operational Monitoring** — `docs/OPERATIONAL_MONITORING_SPEC.md`. Phases 1–3 shipped; admin dashboard at `/app/admin/operations`; `QuotaWarningBanner` in AppLayout (80% dismissible / 95% persistent). Phase 4 (firm-layer aggregation) blocked until Phase 9. Operator-side setup tracked in `docs/ops/OPERATOR_PLAYBOOK.md`; **owed before customer #1 / Vault launch:** STOP 3 (live-mode Stripe webhook destination + signing secret — live mode is a separate endpoint from the verified sandbox), STOP 10 (Vault Stripe Product/Price + `STRIPE_PRICE_VAULT_ANNUAL` + `VAULT_RENEWAL_CRON_SECRET` + schedule the `vault-renewal-reminder` cron), STOP 7 (annual Price IDs). All fail closed until done.
- **Market Data & IBR** — `docs/MARKET_DATA_IBR_MODULE.md`. Spec only, not started. Independent workstream, NOT a numbered phase; files/branches/flags/migrations use the `module_market_data` prefix; migration SQL stays inline in the spec until the module opens. Binding standing rules (autonomous-but-constrained ingestion, immutable/append-only IBR packets, no LeaseIO methodology certification, Pro/Business gating, HITL CPI escalations, free public data sources only) are archived in `docs/CLAUDE_md_archive.md` — **restore them to active context when the module opens.**

---

## Hard Rules

### Strategic Rules (DO NOT VIOLATE)

1. **LeaseIO is NOT a compliance tool.** Never add ASC 842 compliance features, journal-entry generation, or ROU asset calculations. Never position copy as "compliance-ready." LeaseIO works ALONGSIDE compliance tools.
2. **Human-in-the-loop is the product.** Never build autonomous agents that act without user confirmation. The AI abstracts; the human confirms.
3. **Claude is the AI engine; model selection is never user-facing.** Opus for all extraction (two-pass). Sonnet for embedded assistant + contextual intelligence. Haiku for classification + mapping. No OpenAI. Azure DI only as fallback for scanned/handwritten docs.
4. **Three roles for Claude** (engine / embedded assistant / operator) — all deterministic pipelines or event-driven, never autonomous agents.
5. **Two ongoing intake paths only** (Path 1, Path 2). Backdoor is temporary onboarding; amendments are a sub-workflow.
6. **Landing copy leads with outcomes, not mechanisms.** Never promise unshipped features.
7. **Pricing: no unlimited tiers, 75% margin floor.** Details in Pricing Model above. Embedded AI assistant is Business-tier only.
8. **Embedded assistant answers only from structured data in the user's workspace.** Never hallucinate terms, fabricate numbers, or reference other workspaces. Ground every response in DB records; when uncertain, say so.
9. **No silent vendor failures.** Every vendor dependency must be in exactly one state: (a) monitored via the `vendor-health-check` cron with daily snapshots; (b) tracked in `vendor_renewal_calendar` with multi-stage reminders; or (c) explicitly listed "out of scope" in `OPERATIONAL_MONITORING_SPEC.md` with a reason. No fourth "we'll notice if it breaks" state.

### Schema Change Rule — Source of Truth

**Every schema change MUST be captured as a `.sql` migration file in `supabase/migrations/`. No exceptions.** Supabase Studio and the MCP `apply_migration` tool can mutate live schema directly; without a committed `.sql` file the repo silently drifts and the migrations folder stops being trustworthy.

Workflow for any table/column/constraint/RPC/RLS-policy/trigger/type/index/grant/enum-value/view change:
1. Write the migration file first (`<timestamp>_<descriptive_name>.sql`), then apply via the migration system — never via direct Studio edits.
2. Migrations must be idempotent where reasonable (`IF NOT EXISTS`, `IF EXISTS`, `OR REPLACE`).
3. **Never edit a migration after it's applied** to staging/prod — write a new one.
4. If a change was already applied directly (Studio/MCP/any path) without a file, immediately `supabase db pull` and commit the result before any further work.

Before claiming a DB task complete, verify: the `.sql` exists in `supabase/migrations/`, is committed, is idempotent (or justified), and any out-of-band change was captured via `db pull`. If not, the task is not complete.

### Lifecycle Transition Convention

Any code that transitions `leases.lifecycle_status` MUST:
1. Set `leases.status_changed_at = now()` in the same UPDATE.
2. Insert a `lease_activity_log` row with `activity_type = 'status_change'`, populating **both** the top-level `from_status`/`to_status` columns **and** the equivalent fields inside the `details` JSON (backward compatibility).
3. Include a `routing_path` in `details` (`'legacy'` or `'chain'`).

This keeps activity-log shape consistent across the form-path writer (`LeaseRequestForm.tsx`, both shapes inline in legacy + chain branches) and the edge-function writer (`act-on-chain-step/index.ts`, which routes every transition through `updateLifecycle()` + `logStatusChange()` helpers — do not write the UPDATE/INSERT inline). **Each new transition code path must follow this convention.**

### Project Configuration Source of Truth

The repo is the source of truth for all config expressible as code:
- **Edge functions** live in `supabase/functions/<name>/index.ts`, committed. Never deploy a function not in the repo; after deploy, confirm deployed code matches the committed file.
- **Secrets/env vars** documented (names only) in `.env.example`.
- **Storage buckets, storage RLS, auth settings** configured via Studio documented in `supabase/README.md`.

If a change can't be expressed in the repo, document why near where its absence would confuse.

### Documentation & Completion Discipline — DO NOT VIOLATE (added 2026-06-14 after a doc-drift incident)

Two failures must not recur: (a) shipping work while leaving the source-of-truth docs stale, and (b) claiming "done / committed / pushed / clean / handed off" from memory without actually verifying. This is the "verify, don't recall" rule applied to documentation — stale source-of-truth docs silently mislead the next session.

1. **Docs are part of the change, not an afterthought.** A change is NOT complete until the source-of-truth docs match reality. In the SAME change that ships it, reconcile every doc whose statements it affects:
   - `CLAUDE.md` — Active Priorities (move shipped items out of "open/unstarted"; never leave a built feature listed as unbuilt), Known Schema Realities (types, columns, RLS, enums, env vars), the file-to-feature map, and any other claim the change invalidates.
   - `docs/KNOWN_ISSUES.md` — stamp `RESOLVED <date>` on what you fixed; file what you discovered.
   - The relevant `docs/*_SPEC.md` As-built note when implementation diverges from spec.
2. **Completion claims are verified, never asserted.** Before saying "done", "everything's committed/pushed/clean", or writing any handoff: actually RUN the checks (`git status --porcelain` for uncommitted/untracked; local `HEAD` vs `@{u}` SHA + `git rev-list --left-right --count @{u}...HEAD` for sync) AND re-READ the docs you're vouching for. Never state git state or doc accuracy from memory.
3. **Session handoff = full CLAUDE.md reconciliation.** Before declaring a session done or writing a handoff doc, re-read CLAUDE.md top-to-bottom and reconcile it against everything the session changed. A handoff that points at a stale CLAUDE.md is not done.

---

## Gotchas & Constraints

### Known Schema Realities

- Lease-limit DB column is `document_limit` on `workspaces`; frontend config uses `maxActiveLeases`. Same concept — write `document_limit` to DB, read `maxActiveLeases` from frontend config.
- `SubscriptionPlan` type is `'starter' | 'business' | 'vault'` (vault added 2026-06-13), declared in **both** `src/config/pricing.ts` and `src/types/index.ts` (keep the two in sync — drift broke the build once). `PLAN_ORDER` deliberately EXCLUDES `vault` (offramp-only, never a pricing surface). `normalizePlanId` coerces legacy `'free'`/`'pro'` → `'starter'` and recognizes `'vault'`. Stripe Products: `prod_TlQhMebFLbmsbR` (starter), `prod_TlQhRntCDhkxfK` (business); Vault Product is an OPERATOR item (STOP 10, not yet created). Monthly Price IDs hardcoded in `create-checkout`/`stripe-webhook`; annual + vault Price IDs from `STRIPE_PRICE_STARTER_ANNUAL`/`STRIPE_PRICE_BUSINESS_ANNUAL`/`STRIPE_PRICE_VAULT_ANNUAL` env, fail closed (503 `annual_not_configured` / `vault_not_configured`) if unset.
- **Workspace RLS (changed 2026-06-13):** `workspaces` UPDATE is owner + accepted-admin (was owner-only; #70); owner_id reassignment blocked by the `enforce_workspace_owner_immutable` trigger. Client DELETE of `workspaces` is blocked (#83) — deletion only via the service-role `delete-workspace`/`delete-account` functions. Read-only-state writes (grace/soft-deleted/vault) are blocked by the V1 restrictive-RLS layer + the config/entitlement guard triggers.
- Direct-upload lease creation happens in `process_lease/index.ts`, NOT `LeaseUploadModal.tsx` — the modal triggers upload; the edge function creates/updates the lease record.
- `workspace_approvers` table exists but has no read/write path in the frontend. Known gap.

### Known Bugs

Active bug tracking lives in **`docs/KNOWN_ISSUES.md`** — each item filed with severity, location, repro context, and a "RESOLVED <date>" stamp when fixed. Check it before re-investigating any prior bug.

### "Always Check For" — touchpoints when modifying these areas

Full touchpoint lists + the hard-won incident narratives are in `docs/CLAUDE_md_archive.md`; the load-bearing one-liners:

- **Operational monitoring** (`docs/OPERATIONAL_MONITORING_SPEC.md`): new vendor dependency → add an `src/adapters/monitoring/` adapter + a vendor-table row; changing a tier's quota → update `QuotaWarningBanner.tsx` thresholds + tier constants; new edge function calling a paid API → bound the cost; new card-on-file → add a `vendor_renewal_calendar` row.
- **Email intake** (`docs/EMAIL_INTAKE_PLAN.md` + `_DECISIONS.md`): email-sourced leases must enter the right stage (`intake_source = 'email_intake'`) and must NOT bypass Tier 2/3 in `process_lease`; changes to the `is_workspace_member` RLS helper must preserve `workspace_intake_settings` admin/owner write; tier-default changes in `pricing.ts` must update per-tier intake caps.
- **GitHub Actions CI** (`.github/workflows/*.yml`): `secrets.*` is NOT valid in step-level `if:` — only in `env:`, `with:`, and job-level `if:`. To gate a step on a secret, hoist it to job-level `env:` then check `env.*`. A step-level `if:` referencing `secrets.*` invalidates the whole file at parse time (run shows failure with **zero job rows** — that signature means the YAML never compiled, not that a job failed). Pre-push, grep `^\s*if:.*secrets\.` and reject hits. After any workflow edit, confirm the next run produced job rows (query `actions/runs?head_sha=<full_sha>` then `/jobs` for `total_count > 0`).
- **Supabase migrations** (`supabase/migrations/`): don't blindly run the CLI's 100+ migration drift-repair on 1–2s timestamp drift — prefer `db dump` → archive historicals → metadata-only reconcile (capture `schema_migrations` JSON first; `created_by` is otherwise unrecoverable). `db dump` omits `CREATE EXTENSION` (pre-patch `CREATE EXTENSION IF NOT EXISTS`). `CREATE TYPE` has no `IF NOT EXISTS` (wrap in `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL $$`). Dump `--schema public` only + a companion file of just your `storage.objects` policies (the runner role can't apply the platform `storage` schema). Test "does the baseline alone replay cleanly?" — archive historicals BEFORE `db reset`. Restoring a shrunk drift-detection function surfaces accumulated drift on first run — plan triage time.
- **Trigger ordering** (new BEFORE UPDATE/INSERT trigger on a table that already has triggers): Postgres fires triggers in alphabetical order of trigger NAME. Prefer the disjoint-columns pattern (each trigger owns a non-overlapping column set; document the ownership invariant in the migration). Inventory existing triggers from the live DB (`pg_trigger` join `pg_proc`), not the schema dump.
- **Static migration-file tests** (`src/lib/__tests__/*.test.ts` using `readFileSync`): narrow the search window to the target object's declaration block before `toContain` — full-file `toContain` produces false positives (e.g. `SECURITY DEFINER` passing because a *different* function later has it). Static tests catch in-repo drift, not live-DB drift; the live layer is `scripts/smoke-audit-hardening.mjs` (`npm run smoke:security`) — wire into CI when SUPABASE_* secrets land (KNOWN_ISSUES #26).
- **Security migrations** (any migration touching RLS, role grants, SECURITY DEFINER functions, audit infra, or triggers): **reviewer routing happens BEFORE `db push`, not after** — this overrides the default post-apply routing for non-security changes. Expect 3+ iterative rounds to converge; iterate until reviewers actually return clean ("predicted-clean" is not the rule). When findings come piecemeal (field X, then Y, then Z), step back to the class shape — enumerate ALL columns/operations and categorize each, rather than chasing symptoms. When restoring archived hardening, the archive is **input, not specification** — fix incompleteness (e.g. `WITH CHECK (true)`), don't faithfully reproduce it. Sweep adjacent governance tables (`lease_unlock_requests`, `lease_change_sets`, `lease_governance_audit`) in the same pass; apply scope discipline symmetrically across structurally identical findings.
- **Edge-function CORS allowlist** (`supabase/functions/_shared/cors.ts` + the two inline-CORS functions `send-invite/index.ts` and `resend-invite/index.ts`): the allowlist must include EVERY host the frontend is actually served from — production custom domains, preview suffixes for the current deployment platform (Vercel `.vercel.app`, Lovable `.lovable.app` / `.lovableproject.com`), and localhost dev hosts. The class of failure is "platform switch leaves an old suffix in place and the new one out" — Lovable → Vercel migration in 2026-06 missed `.vercel.app` and silently broke every edge function from every preview URL with a CORS rejection at the browser, not the function (logs showed only OPTIONS, never POST). Triggers to re-verify the allowlist: (a) deployment platform changes; (b) new production hostname; (c) new edge function is added (must use shared `cors.ts` OR replicate the same suffix set inline — drift between the two is its own bug). After any cors.ts change, redeploy ALL frontend-invoked functions (the deployed copies bundle a frozen snapshot of `_shared/cors.ts`; the file in the repo is not the file the function runs). Frontend-invoked = anything called via `supabase.functions.invoke()` — grep that pattern for the full list.
- **Vite post-deploy stale-chunk white screen** (`src/main.tsx` + `vercel.json`): Every deploy that changes the Vite module graph emits new hashed chunk filenames. A browser with a cached `index.html` will request the old (now-missing) URLs. `vercel.json`'s catch-all SPA rewrite (`"source": "/(.*)"`) returns `index.html` for ANY path — including `/assets/*` — so the 404 becomes an HTML response; the browser executes HTML as JavaScript and crashes with `Unexpected token '<'` → **blank white screen**. The user fixes it with a hard-refresh (Cmd+Shift+R / Ctrl+Shift+R); a normal reload can still serve the cached `index.html`. Incident: 2026-06-09 post-merge deploy, confirmed and diagnosed in that session. **Permanent mitigation** is the `vite:preloadError` listener in `src/main.tsx` (added 2026-06-10): on the first chunk-load failure it reloads once, guarded by `sessionStorage` to prevent an infinite loop if the new chunk is itself genuinely missing. **Pre-handoff check:** after any deploy that substantially adds or removes lazy-loaded routes/components (i.e. changes `App.tsx`'s `lazy()` imports), open the app in a fresh Incognito/Private tab — this bypasses the stale `index.html` and confirms first-visit load works correctly before handing off to the user.

### Known Operational Dependencies

These vendor consoles must remain accessible at all times (loss of access = P0; 2FA recovery codes stored in a password manager Daniel can reach independently of the primary device):

Anthropic Console · Supabase Dashboard · Vercel Dashboard · Resend Dashboard · Stripe Dashboard · Sentry (after Ops Monitoring Phase 3) · Domain registrar for `theleaseio.com`.

### Stale-reference cleanup

A set of orphaned files was deleted per audit (e.g. `ApproverSelect.tsx`, `PipelineView.tsx`, `LeaseCard.tsx`, several pages). If you encounter references to them, they're stale — clean them up. Full list in `docs/CLAUDE_md_archive.md`. (`CovenantHealthPanel.tsx` is archived, not deleted — may be reused.)

---

## Subagent Routing — Required Before Declaring Any Change Complete

LeaseIO has six project-level subagents in `.claude/agents/`. Routing review through the appropriate agents before declaring a change complete is **mandatory**, not optional.

| Agent | When to invoke |
|---|---|
| **lease-code-auditor** | Every code change. Dead code, broken references, deprecated APIs, unreachable paths, unused exports. |
| **lease-security-scanner** | Every code change. Hardcoded secrets, missing input validation, injection, IDORs, and especially missing or UI-only authorization checks. |
| **lease-repository-integrity-reviewer** | Changes touching lease data storage, import, edit flows, audit logging, reporting, permissions, approval workflows, or lifecycle enforcement. Defends "customer entered it, we stored it faithfully, every change is attributable." |
| **lease-product-polish** | Changes touching any user-facing surface — copy, errors, empty states, dialogs, onboarding, import, exports, keyboard nav. Defends against friction/opacity for the SMB finance user. |
| **lease-test-author** | Alongside reviewers — covers surfaced gaps + proactively finds missing coverage (lifecycle transitions, audit-trail correctness, server-side governance, reporting edge cases, import/export fidelity). Runs tests and reports results honestly. |
| **lease-explorer** | On demand, before changing an unfamiliar area. Read-only navigator (purpose, key files, entry points, data flow, fragility). |

**Routing in practice:** no user-facing surface, no data-path impact → auditor + security + test-author. Add **product-polish** for user-facing surfaces. Add **integrity-reviewer** for data/audit/governance/reporting paths. Invoke **explorer** first on unfamiliar areas. Independent reviewers run in parallel (one message, multiple `Agent` calls).

**The hard rule on polish:** the product owner should never be the first to notice an obvious UX problem on a surface that just changed. If they are, the polish agent failed to surface it and the routing failed to catch the miss. "Obvious" = visible in a screenshot, reachable in one click, present in a state the happy path crosses. To enforce this, polish review on UI changes is NOT a diff sweep — it is a surface sweep + state walk. Specifically:

1. Invoke `lease-product-polish` on the full screens the change touched, not just the diff. Issues regularly live in surrounding UI the diff didn't modify (the collapsed-PDF dead-end, the tab strip overflow, the redundant button next to the new one).
2. Have the agent walk every lifecycle state, not the happy path. Approved-then-unmark, error states, empty states, narrow viewport, terminal states all hide bugs.
3. Surface findings WITH recommendations BEFORE the user looks at the preview. If they have to discover it, you were too late.

The polish agent's own brief at `.claude/agents/lease-product-polish.md` codifies this. When invoking it, prompt for the broad sweep explicitly — don't just hand it the diff.

**Surfacing findings:** Every Critical/High finding must be surfaced to me **before any fix** — present the agent, `file:line`, the agent's one-line description + risk + suggested fix, and your own true-finding-vs-false-positive assessment; then wait for my decision (fix / defer-with-reason / dismiss). Do not auto-remediate, bundle, or decide on my behalf. Mediums/Lows: summarize and address at your discretion, but record any deferrals in the change summary. A change with an unaddressed Critical/High is not complete even if it "works."

**Pre-existing issues are their own beat.** When a reviewer/baseline pass surfaces issues that predate the current change, file them in `docs/KNOWN_ISSUES.md` with a stub remediation + root-cause hypothesis — do NOT bundle the fix into the current commit. (Full rationale + the smoke-check categorization rule for governance-hardening migrations are in `docs/CLAUDE_md_archive.md`.)
