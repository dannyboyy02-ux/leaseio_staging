# LeaseIO AI-Build Audit Findings

Date: 2026-05-13
Workspace: `C:\Users\danny\Downloads\Respository\leaseflow-ai`

## Audit Definition

For an AI-built SaaS/AaaS product, I treat an audit as more than a code review. LeaseIO is not just a frontend around data tables; it handles sensitive lease documents, invokes third-party AI systems, gates value by paid plan, and produces outputs customers may rely on operationally. That means the audit must ask whether the product can be trusted as a service, not merely whether the happy path compiles.

I interpreted AaaS here as an AI/agent-assisted service: software that performs specialized analysis or workflow acceleration for customers using AI. For that category, the audit scope includes:

- Product truth: the shipped workflows match the positioning and customer promise.
- Tenant isolation: users can only see and mutate data they are authorized to access.
- Billing and entitlement integrity: paid features, quotas, and upgrades are enforced on the backend, not only hidden in the UI.
- AI governance: consent, disclosure, data minimization, and revocation are consistently enforced before customer data is sent to model providers.
- Security and privacy: auth, RLS, storage policies, deletion flows, CORS, and public sharing are intentional and testable.
- Operational readiness: build/test/typecheck, cron jobs, monitoring, incident playbooks, and secrets are reliable enough for real customers.
- AI-code maintainability: generated code should be legible, tested, modular, and free of duplicated logic that can drift silently.

This was a local repository audit. I did not use live Supabase, Stripe, Vercel, or deployed production credentials.

## Executive Verdict

LeaseIO has a strong product direction and unusually thoughtful strategy documentation. The codebase also shows real care in several places: explicit product strategy, multi-phase build specs, RLS migrations, Stripe webhook handling, public summary token design, extraction confidence modeling, and operational monitoring work.

The current repository is not production-ready or pilot-ready without remediation. The highest-risk blockers are:

- Business onboarding appears blocked by a database entitlement trigger.
- TypeScript typechecking fails immediately because the generated Supabase types file is malformed.
- Build and test commands do not complete in the current workspace.
- Invite emails build token-bearing links from the incoming `Origin` header.
- Public reporting views may expose tenant data unless hardened for RLS-safe execution.
- The migration chain appears to depend on pre-existing base schema objects and is not fully reconstructable from migrations alone.
- Sensitive lease lifecycle and model-lock fields are still mutated directly from the browser under a broad lease update policy.
- Newer AI assistant/insights features need the same cost, prompt-size, and consent controls as the extraction path.
- Several AI and paid-value functions rely on frontend gating or partial backend checks.
- AI consent is enforced in the extraction path but not consistently across all AI functions.

My recommendation is to treat the P0 and P1 findings as release gates before expanding pilots or taking paid customers through the self-serve path.

## Severity Model

- P0: launch blocker; breaks core product delivery or release verification.
- P1: high-risk production issue; can create billing, privacy, security, cost, or trust failures.
- P2: important operational or maintainability issue; should be fixed before scale.
- P3: polish, hygiene, or positioning issue; lower direct risk but visible to users or contributors.

## Positive Findings

1. Product and AI strategy are credible.
   - `docs/PRODUCT_STRATEGY.md` and `docs/AI_NATIVE_PRODUCT_STRATEGY.md` show clear thought about LeaseIO's differentiation, customer value, and AI-native workflows.

2. The main extraction function has several strong controls.
   - `supabase/functions/process_lease/index.ts` includes file validation, workspace resolution, classification/correction behavior, AI consent checks in the extraction flow, and confidence persistence.

3. Many unauthenticated Supabase Edge Function deployments still perform manual authorization.
   - Several functions are configured with `verify_jwt = false` in `supabase/config.toml`, but many of them still validate bearer tokens, cron secrets, or webhooks internally. This is better than relying on public access by accident, though it requires careful consistency checks.

4. Stripe webhook entitlement promotion is directionally correct.
   - `supabase/functions/stripe-webhook/index.ts` verifies webhook signatures and updates workspace plan state based on subscription status instead of trusting the client checkout path directly.

5. Public summary sharing is intentionally designed.
   - `supabase/functions/get-summary-by-token/index.ts` uses long random tokens, expiry checks, and revocation semantics. Public CORS is documented as an intentional design choice.

6. The reporting system appears more deterministic than pure AI prose.
   - ASC 842/reporting code and schemas suggest the product is trying to produce auditable financial outputs rather than only model-generated summaries.

7. There are meaningful focused tests and SQL phase tests.
   - Examples include tests for portfolio analytics, lifecycle states, lease document helpers, approval chain logic, audit remediation, ASC 842 reporting, and SQL phase behavior.

8. The environment documentation is stronger than the starter README.
   - `.env.example` is detailed and warns against committing real secrets. A local text scan did not find obvious committed private API keys, though this is not a substitute for a dedicated secret scanner in CI.

## Findings

### P0-01: Business onboarding is blocked by the entitlement guard

Evidence:

- `src/pages/app/Onboarding.tsx:74-84` derives `workspacePlan` from the selected onboarding plan and inserts the workspace with that plan and its document limit.
- `src/pages/app/Onboarding.tsx:127-128` navigates to checkout only after workspace creation.
- `supabase/migrations/20260426000003_audit_remediation.sql:20-64` adds a trigger that rejects authenticated workspace inserts unless the initial plan is `starter`, `document_limit` is `15`, and other entitlement fields remain at default values.

Impact:

Selecting Business during onboarding appears to make workspace creation fail before checkout can run. That blocks the paid self-serve path and can make the first high-intent user experience look broken.

Recommendation:

Create all client-side workspaces as starter workspaces with default limits. Preserve the user's selected plan as checkout intent only. Let Stripe checkout plus the signed webhook promote the workspace to Business and raise limits.

### P0-02: Typecheck is blocked by a malformed Supabase types file

Evidence:

- `src/integrations/supabase/types.ts:1` begins as a JSON wrapper, for example `{"types":"export type Json =...`, instead of raw TypeScript.
- `npm.cmd run typecheck` fails with `src/integrations/supabase/types.ts(1,9): error TS1005: ';' expected.`
- `scripts/check-supabase-types.mjs:15` only checks for table-name substrings and therefore reports success even when the file is syntactically invalid.

Impact:

The repo cannot be trusted to typecheck. Any CI or local validation that relies on the lighter Supabase type checker can pass while the actual TypeScript compiler fails.

Recommendation:

Regenerate `src/integrations/supabase/types.ts` as raw TypeScript. Replace or extend `scripts/check-supabase-types.mjs` so it parses the generated file or runs `tsc --noEmit` as the authoritative check.

### P1-01: Build and test commands fail before exercising the app

Evidence:

- `npm.cmd run build` fails while loading Vite config because the native SWC package cannot load and an `EPERM` spawn error is raised.
- `npm.cmd test` fails with the same SWC/native dependency and `EPERM` error.
- `npm.cmd run smoke:security` prints `No Supabase smoke-test environments configured. Skipping.`

Impact:

The local verification chain is not healthy. This creates a serious AI-build risk because large generated changes can appear reviewed while core compile, test, and security smoke checks are not actually running.

Recommendation:

Repair the local/CI toolchain until `typecheck`, `build`, and `test` are reliable. Make the security smoke test fail closed in CI when required Supabase test environment variables are absent.

### P1-02: Billing CORS likely fails from the app subdomain

Evidence:

- `supabase/functions/create-checkout/index.ts:8`, `supabase/functions/customer-portal/index.ts:8`, and `supabase/functions/check-subscription/index.ts:8` call `getCorsHeaders(null)` at module scope.
- `supabase/functions/_shared/cors.ts:10-16` allows multiple origins, including `https://theleaseio.com`, `https://www.theleaseio.com`, and `https://app.theleaseio.com`.
- Passing `null` chooses the first allowed origin rather than echoing the request origin.
- The same billing functions use `req.headers.get("origin")` for success and return URLs, which suggests they are meant to support the actual caller origin.

Impact:

Requests from `https://app.theleaseio.com` can receive `Access-Control-Allow-Origin: https://theleaseio.com`, causing browser CORS failure for checkout, portal, or subscription checks.

Recommendation:

Compute CORS headers inside each `serve` handler from `req.headers.get("origin")`. Apply the shared allowlist dynamically for both `OPTIONS` and non-`OPTIONS` responses.

### P1-03: Paid plan quotas are mostly advisory, not backend-enforced

Evidence:

- `src/config/pricing.ts` defines Starter and Business limits such as active lease caps.
- `src/pages/app/UsageContent.tsx` displays usage and quota state to users.
- `supabase/functions/_shared/monitoring/workspace_quotas.ts` categorizes quota state as monitoring data and soft quota information.
- `src/components/leases/LeaseUploadModal.tsx` invokes `process_lease`.
- `supabase/functions/process_lease/index.ts` applies a rate limit but does not appear to enforce the workspace active lease cap or monthly extraction cap before storage/upload/AI processing.

Impact:

Customers can potentially exceed paid plan limits and trigger additional AI processing cost. UI warnings alone are not an entitlement system.

Recommendation:

Add a backend quota gate before expensive processing starts. Enforce active lease counts, monthly extraction/report caps, and any AI spend limits in Edge Functions or database constraints. Return a clear upgrade-required response that the UI can render.

### P1-04: AI consent is not consistently enforced across AI functions

Evidence:

- `src/pages/Signup.tsx:128-145` collects and writes AI consent during signup.
- `supabase/functions/process_lease/index.ts` uses `assertAiConsent` in the main extraction path.
- `supabase/functions/ai-assistant/index.ts` sends lease context to Anthropic but does not perform the same consent check.
- `supabase/functions/generate-lease-insights/index.ts` sends lease or portfolio context to Anthropic but does not perform the same consent check.
- `supabase/functions/generate-lease-analysis/index.ts` calls Anthropic without the same consent check.
- `supabase/functions/retry_lease/index.ts` calls Anthropic during retry processing but does not perform the same consent check.
- `src/pages/settings/AccountSettings.tsx` supports granting and revoking AI consent, so the product creates a user expectation that revocation matters.

Impact:

Users who revoke AI processing consent, or invited users who never went through the signup consent step, may still have lease data sent to AI providers through assistant, insights, or analysis workflows.

Recommendation:

Move AI consent enforcement into a shared Edge Function helper and require it before every third-party AI call that includes customer data. Include tests for consent granted, consent missing, and consent revoked for every AI function.

### P1-05: Legacy lease analysis is backend-callable without entitlement, consent, or rate gates

Evidence:

- `src/components/leases/LeaseDocumentsTab.tsx` only exposes the analysis action in the UI for Business locked leases.
- `supabase/functions/generate-lease-analysis/index.ts` authenticates the user and checks workspace membership, but does not appear to check workspace plan, AI consent, or a rate limit before calling Anthropic.

Impact:

Any workspace member who can call the function directly can potentially access Business-only AI analysis and trigger model spend, even if the UI hides the button. This also overlaps with the AI consent gap.

Recommendation:

Either retire this legacy function or bring it up to the same standard as the newer report/processing flows: backend plan gate, consent gate, rate limit, audit logging, and tests.

### P1-06: Report PDF storage can be overwritten by broader workspace members

Evidence:

- `supabase/functions/finalize-report-pdf/index.ts` authorizes finalization to the original generator, workspace owner, or admin.
- `supabase/migrations/20260507000000_lease_reports_storage_insert.sql:31-82` allows workspace members to insert or update report PDF objects when the path references a report in their workspace.
- `supabase/migrations/20260506200000_phase8_disclosure_reports.sql:92-102` allows workspace members to read report rows, which exposes report IDs used in storage paths.

Impact:

The Edge Function has a tighter authorization model than the storage policy. A workspace member can potentially bypass `finalize-report-pdf` and overwrite a report PDF object directly through Supabase Storage. For audit/report artifacts, that is an integrity issue.

Recommendation:

Tighten `lease-reports` storage update and insert policies to match `finalize-report-pdf`: generated-by user, workspace owner, or admin. For stronger integrity, consider server-side PDF generation or short-lived signed upload tokens tied to a specific report and user.

### P1-07: Account and workspace deletion leave newer storage buckets behind

Evidence:

- `supabase/functions/delete-account/index.ts:51` deletes objects from `leases` and `executed-leases`.
- `supabase/functions/delete-workspace/index.ts` describes deleting all storage but iterates only `leases` and `executed-leases`.
- Newer storage surfaces include `lease-documents` and `lease-reports`.
- `src/components/leases/documents/UploadDocumentDialog.tsx` uploads to `lease-documents`.
- `supabase/migrations/20260506200000_phase8_disclosure_reports.sql` creates `lease-reports`.

Impact:

Deleting an account or workspace can leave customer documents or generated reports orphaned in storage. That is a privacy, compliance, and storage-cost issue.

Recommendation:

Extend account and workspace deletion to remove `lease-documents` and `lease-reports` by workspace prefix. Add an orphan cleanup job and tests that create files in every bucket, delete the workspace, and assert no objects remain.

### P1-08: Invite emails build token links from untrusted request origin

Evidence:

- `supabase/functions/send-invite/index.ts:158` uses `req.headers.get('origin')` as the base URL for invite links.
- `supabase/functions/send-invite/index.ts:176` and `supabase/functions/send-invite/index.ts:210` place invitation tokens into URLs built from that origin.
- `supabase/functions/resend-invite/index.ts:185-186` repeats the same pattern for resend.
- `supabase/functions/accept-invite/index.ts:52-110` has a no-auth new-user path where possession of a valid invite token plus a password creates an email-confirmed user.

Impact:

An authenticated workspace owner/admin calling the function outside the browser can set an arbitrary `Origin` header and cause LeaseIO to send a real invite email whose button points to a non-LeaseIO domain with the invite token in the URL. If the recipient clicks it, the token can be captured and used in the new-user invite path. This is especially risky because invite tokens bootstrap account creation and workspace membership.

Recommendation:

Build invite URLs from a canonical `APP_URL`, not from request `Origin`. If a request origin is used at all, validate it and reuse only the normalized allowlisted origin. Consider storing the invite before sending email, logging the link base used, and requiring an email-verification step before creating a confirmed user from an invite token.

### P1-09: Public reporting views may bypass tenant RLS unless explicitly hardened

Evidence:

- `supabase/migrations/20260426000001_lease_governance_audit.sql:81` creates `public.v_governance_audit_report`.
- `supabase/migrations/20260506200000_phase8_disclosure_reports.sql:148` creates `public.v_lease_verification_audit`.
- `supabase/migrations/20260506220000_per_lease_discount_rate.sql:151` recreates `public.v_lease_verification_audit`.
- A repository search found no `security_invoker` usage in Supabase migrations.
- `v_governance_audit_report` joins audit and lease data including actor emails and before/after governance values. `v_lease_verification_audit` joins lease, workspace, and field-correction/reporting data.

Impact:

In Postgres/Supabase, ordinary views are a common RLS footgun unless they are created with an invoker-security posture or protected by explicit grants/RPC boundaries. If these public views are exposed through the API role, authenticated users may be able to read cross-tenant audit or verification data despite RLS on the underlying tables. That would be a direct tenant-isolation and confidentiality failure.

Recommendation:

Recreate tenant-sensitive public views with `WITH (security_invoker = true)` where supported, or remove direct API grants and expose the data only through RPC/Edge Functions that enforce workspace membership. Add a two-workspace RLS regression test that verifies user A cannot query either view for user B's workspace data.

### P1-10: The migration chain is not self-contained enough for reliable fresh environments

Evidence:

- A repository-wide migration search did not find `CREATE TABLE public.profiles` or `CREATE TABLE public.leases`.
- Later migrations alter or attach policies to those tables, including `supabase/migrations/20260105034911_5c24ae6a-a187-4d3d-bc87-dc3f3a73faca.sql:112`, `supabase/migrations/20260106053641_df9ca410-8a17-4a03-a24d-667e6d590e74.sql:77-96`, `supabase/migrations/20260305225810_security_rls_hardening.sql:296-313`, and `supabase/migrations/20260429000002_profiles_explicit_policies.sql:18-35`.
- The repository has schema-drift documentation, but a documented baseline is not the same as a replayable migration chain.

Impact:

Fresh Supabase branches, CI database resets, disaster recovery drills, and new developer setups may fail or silently diverge from production. In an AI-built SaaS, this is especially risky because future agents will infer behavior from whatever local schema happens to exist, not from a guaranteed source of truth.

Recommendation:

Create a validated baseline migration or squash point that includes the missing foundational tables, views, RLS enablement, grants, storage buckets, and extensions. Add a CI job that runs a clean database reset from migrations, regenerates Supabase types, and fails if generated types differ from the committed file.

**Remediation status (2026-05-16):** Closed. Baseline at `supabase/migrations/20260516120000_baseline_schema.sql` (public schema), companion at `20260516120001_storage_policies.sql` (storage.objects RLS), 86 historical migrations archived to `supabase/migrations/_archive/`, live `schema_migrations` reconciled to 2 rows, CI `migration-replay` job added in `.github/workflows/ci.yml` that boots a clean stack via `supabase start` on every PR/push. Pre-reconcile schema_migrations metadata preserved at `docs/ops/schema_migrations_pre_baseline_2026-05-16.json`. Reviewer-pass surfaced three pre-existing production hardening regressions exposed (not introduced) by the baseline — filed as `docs/KNOWN_ISSUES.md` items #16 (governance audit INSERT policy), #17 (change-set UPDATE draft-only guard), #18 (lease-reports storage policy `foldername(w.name)` bug). Those get their own scoped remediation migrations.

### P1-11: Browser-side lease updates can bypass approval and model-lock workflows

Evidence:

- `supabase/migrations/20260305225810_security_rls_hardening.sql:313-322` allows `UPDATE` on `public.leases` for the submitter, workspace editors, and several functional roles.
- That policy is row-oriented, not column-oriented. It does not distinguish low-risk fields from sensitive fields such as `lifecycle_status`, `financial_approved_by`, `model_locked`, or `model_locked_by`.
- `src/pages/app/FinancialReview.tsx:236` updates a lease to `lifecycle_status: 'approved'` directly from the browser.
- `src/pages/app/ApprovalQueue.tsx:893-904` updates manager approval state directly from the browser.
- `src/components/leases/ModelLockConfirmation.tsx:35` sets `model_locked: true` and moves the lease to `active` directly from the browser.
- `supabase/migrations/20260430000001_lease_archive_and_workspace_archive_cap.sql:75` blocks client edits only when `OLD.model_locked IS TRUE`, so the lock action itself is not protected by that trigger.

Impact:

Approval state, financial approval, lifecycle progression, and model locking are audit-critical. A user who satisfies the broad lease update policy, or anyone operating with that user's token, can potentially mutate those fields directly through the Supabase API instead of the intended Edge Function or UI workflow. That undermines the evidentiary value of approvals, audit logs, and downstream reporting.

Recommendation:

Move lifecycle transitions, approval decisions, executed-record lock, and financial approval into Edge Functions or RPCs with explicit actor checks and append-only audit writes. Add database triggers that reject direct client updates to sensitive workflow columns unless `auth.role() = 'service_role'` or the call path sets a trusted transaction-local claim. Keep browser-side updates for low-risk editable fields only.

### P1-12: AI assistant and insights lack abuse controls around model spend and prompt size

Evidence:

- `supabase/functions/ai-assistant/index.ts:206` gates the assistant to Business workspaces, but a targeted search found no `enforceWorkspaceRateLimit` or `processing_rate_limits` usage in the function.
- `supabase/functions/ai-assistant/index.ts:221-228` loads up to 60 leases, including `extracted_json`, and `supabase/functions/ai-assistant/index.ts:234-246` sends that context plus the user's question to Anthropic.
- `supabase/functions/ai-assistant/index.ts:165-166` validates that `question` is a non-empty string, but does not cap length.
- `supabase/functions/generate-lease-insights/index.ts:200` gates to Business, but a targeted search found no workspace rate limit in that function either.
- `supabase/functions/generate-lease-insights/index.ts:166`, `supabase/functions/generate-lease-insights/index.ts:271-301`, and `supabase/functions/generate-lease-insights/index.ts:311` send target-lease context and portfolio context to Anthropic.

Impact:

Business-only is not the same as abuse-resistant. A valid Business workspace member can repeatedly call these endpoints, sending large prompts and triggering unbounded model spend. Because both functions also lack the shared AI consent check covered in P1-04, this creates a combined cost and privacy-governance risk.

Recommendation:

Use the shared rate-limit helper for every model-calling function and create explicit per-feature budgets, for example assistant messages per workspace per hour and insights generations per lease per day. Cap question length, cap generated prompt size by token estimate, log model input/output usage where available, and require AI consent before building customer-data prompts.

### P1-13: Public invite metadata appears blocked by missing Edge Function auth config

Evidence:

- `src/pages/AcceptInvite.tsx:64-66` calls `supabase.functions.invoke("get-invite-info", ...)` before login; the page comment says invite metadata needs no auth.
- `supabase/functions/get-invite-info/index.ts:5-67` is written as a public token-based metadata endpoint.
- `supabase/config.toml:3-64` lists `verify_jwt = false` for several public/manual-auth functions, including `accept-invite`, but does not include a stanza for `get-invite-info`.

Impact:

If Supabase applies the default JWT verification behavior for functions missing from config, unauthenticated invite recipients cannot fetch invite metadata. New-user invite acceptance then fails before the password-creation path can render. That is a core collaboration/onboarding workflow.

Recommendation:

Add `get-invite-info` to `supabase/config.toml` with the intended public token-based auth mode, deploy it explicitly, and add a smoke test that hits `/accept-invite?token=...` as a logged-out user from a fresh browser context.

### P2-01: Cron and operator secret documentation drift

Evidence:

- `docs/ops/OPERATOR_PLAYBOOK.md` references both `MANAGEMENT_API_TOKEN` and `SUPABASE_MANAGEMENT_TOKEN` in nearby sections.
- `supabase/migrations/20260509000001_vendor_health_check_cron.sql` also references `SUPABASE_MANAGEMENT_TOKEN`.
- `supabase/migrations/20260507260000_cron_secrets_table.sql` introduces `private.cron_secrets`, while other cron migrations still use `current_setting(...)` patterns.

Impact:

Operators may configure the wrong secret name or deploy a cron set that silently fails. In a SaaS product, background jobs are part of the product surface, especially for cleanup, monitoring, and alerting.

Recommendation:

Choose one cron secret mechanism and one naming convention. Update all migrations and the operator playbook. Add a deployment verification step that checks every scheduled function for a recent successful run.

### P2-02: Operations admin access is hardcoded and only indirectly gated

Evidence:

- `src/App.tsx` routes `/app/admin/operations` through `ProtectedRoute`, but not a visible role-specific route guard.
- `supabase/migrations/20260509000000_module_monitoring_foundation.sql` defines ops admin access through a hardcoded workspace UUID.
- RLS appears to protect the data, but unauthorized users may still reach an empty or confusing admin page.

Impact:

Operational access is brittle and hard to administer. Hardcoded workspace IDs make environment promotion and incident response more fragile.

Recommendation:

Introduce an explicit `ops_admins` table, role claim, or workspace-level permission. Add frontend route gating so non-ops users get a clear unauthorized state rather than an empty dashboard.

### P2-03: The standalone Upgrade page has a dead primary CTA

Evidence:

- `src/pages/app/Upgrade.tsx:36` renders an `Upgrade to Business` button without a click handler or link.
- `src/pages/settings/AccountSettings.tsx` contains the working checkout flow.

Impact:

Users who find the upgrade page can hit a dead-end instead of entering the paid conversion path.

Recommendation:

Reuse the Account Settings checkout handler or route the Upgrade button to the subscription tab with an auto-checkout parameter.

### P2-04: Large AI-generated monoliths and mirror files create drift risk

Evidence:

- Large files include `src/pages/app/LeaseReview.tsx`, `supabase/functions/process_lease/index.ts`, `src/pages/app/ApprovalQueue.tsx`, `src/pages/settings/AccountSettings.tsx`, and `src/pages/settings/WorkspaceSettings.tsx`.
- Shared logic appears in frontend files and Deno mirrors, including lifecycle states, lease document helpers, approval chain logic, and ASC 842 report logic.

Impact:

Large generated files are harder to review, test, and safely modify. Mirrored logic across browser and Edge Function runtimes can drift over time, which is especially risky in an AI-built codebase where future changes may be broad and fast.

Recommendation:

Prioritize extracting pure domain logic into smaller shared modules with explicit tests. Where Deno/browser split is unavoidable, add parity tests or code generation so mirrored files cannot silently diverge.

### P2-05: Some transactional email templates interpolate unescaped user-controlled text

Evidence:

- `supabase/functions/send-lease-notifications/index.ts:169-180` derives email content from lease/extracted notification data.
- `supabase/functions/send-lease-notifications/index.ts:317` injects `description` directly into HTML.
- `supabase/functions/process_lease/index.ts:2453-2466` injects `displayName` into the ready-for-review email subject and HTML.
- `supabase/functions/generate-summary-token/index.ts:170-180` builds `submitterName`, then `generate-summary-token/index.ts:220` injects it into HTML.
- Other invite email helpers already define `escapeHtml`, which shows the safer local pattern exists.

Impact:

This is not the same as browser XSS, because email clients vary in how aggressively they sanitize HTML. It is still a trust and phishing surface: customer-controlled lease names, notification descriptions, or profile names can alter email markup, obscure content, or make transactional email look like something LeaseIO did not send.

Recommendation:

Use a shared `escapeHtml` helper for all text interpolated into email HTML and validate URL attributes separately. Add snapshot tests for representative email templates with hostile input such as `<a>`, quotes, and inline styles.

### P2-06: Expired report cleanup can leave artifacts readable after storage deletion failures

Evidence:

- `supabase/functions/cleanup-expired-reports/index.ts:102-128` counts storage removal failures and continues.
- `supabase/functions/cleanup-expired-reports/index.ts:137` marks each report row `status: "expired"` after the storage pass, regardless of whether a chunk deletion failed.
- `supabase/migrations/20260506200000_phase8_disclosure_reports.sql:238` allows storage reads when a `lease_reports` row references the object path, but the policy does not check `status` or `expires_at`.

Impact:

If storage removal fails, LeaseIO can mark a report expired while leaving its PDF or JSON artifact in the bucket. Because the storage read policy keys only on path ownership, workspace members who retained or can discover the object path may still read an artifact the product considers expired. That weakens retention guarantees around sensitive generated reports.

Recommendation:

Only mark rows expired after their artifacts are removed, or null the storage paths as part of expiry. Add `status <> 'expired'` and `expires_at > now()` checks to the storage read policy, retry failed storage removals, and alert when `storageRemoveErrors` is nonzero.

### P2-07: Billing status and portal helpers are email-scoped, not workspace-scoped

Evidence:

- `supabase/functions/check-subscription/index.ts:47-67` finds a Stripe customer by user email and returns the first subscription for that customer.
- `supabase/functions/customer-portal/index.ts:35-45` also finds a Stripe customer by user email and creates a billing portal session without a `workspaceId`.
- `src/pages/settings/AccountSettings.tsx:432` invokes `customer-portal` without passing the active workspace.
- These helpers do not accept or validate a `workspaceId`.
- Frontend search did not find active callers, while newer checkout and webhook flows are workspace-oriented.

Impact:

These helpers can point at the wrong Stripe customer or subscription in a multi-workspace account or future firm setting. The portal helper also lets billing management drift away from the active workspace's stored Stripe customer/subscription references.

Recommendation:

Retire dead billing helpers. For active ones, require `workspaceId`, verify owner/admin membership, and derive the subscription state and portal customer from the workspace's stored Stripe subscription/customer references rather than from the user's email alone.

### P2-08: Edge Function deployment auth flags are not fully source-controlled

Evidence:

- The repository contains 49 Edge Function directories with `index.ts` files under `supabase/functions`.
- `supabase/config.toml` contains only 21 `[functions.*]` stanzas.
- Several later functions include comments assuming a specific JWT posture, while their deployment setting is not represented in the checked-in config.
- `get-invite-info` is one concrete failure mode: the source expects public token-based access, but the config omits it.

Impact:

Fresh environments, staging branches, or redeploys may not match production auth behavior. In an AI-built system where functions are added quickly across phases, missing deployment metadata becomes a security and reliability risk: a function can accidentally become public, or a public token endpoint can accidentally require JWT.

Recommendation:

Make `supabase/config.toml` the complete source of truth for every Edge Function. For each function, record `verify_jwt`, expected caller type, and whether it relies on bearer auth, cron secret, webhook signature, or public token. Add a CI check that fails when `supabase/functions/*/index.ts` has no matching config stanza.

### P2-09: CI does not run the full release gate suite

Evidence:

- `.github/workflows/ci.yml:28-34` runs `check:supabase-types`, `npm test`, and `npm run build`, but does not run `npm run typecheck`.
- `package.json:12-13` makes `prebuild` run only `typecheck:names`, not the full TypeScript compiler.
- `.github/workflows/ci.yml:36-43` runs `smoke:security` only when four Supabase environment secrets are present; locally it skipped.
- `supabase/tests/README.md:7-27` documents SQL/RLS tests as manual `psql` scripts rather than CI jobs.

Impact:

The current CI can miss the exact classes of failures this audit found: malformed generated types, migration replay drift, RLS regressions, and missing security smoke coverage. For a SaaS handling confidential lease documents, release gates need to fail closed.

Recommendation:

Run `npm run typecheck`, `npm run check:supabase-types`, `npm test`, `npm run build`, and a clean migration-reset/type-generation check in CI. Add a non-production Supabase test target or local Docker job for SQL/RLS tests. Treat missing smoke-test secrets as a failed protected-branch condition, not as a silent skip.

### P2-10: Public financial summaries ignore per-lease discount-rate overrides

Evidence:

- `supabase/migrations/20260506220000_per_lease_discount_rate.sql:13-21` states that downstream consumers must read `leases.discount_rate` first and fall back to `workspaces.discount_rate`.
- `supabase/functions/get-summary-by-token/index.ts:104` fetches only workspace `discount_rate`.
- `supabase/functions/get-summary-by-token/index.ts:155` returns `discountRateUsed: Number(wsData?.discount_rate) || 5.5`.
- `src/components/summary/FinancialImpactSummary.tsx:106` displays that value as the discount rate used for PV.

Impact:

Externally shared financial impact summaries can display the workspace default rate even when a per-lease IBR override exists. That can make the summary inconsistent with disclosure reports and with the migration's stated ASC 842 compliance requirement.

Recommendation:

Update `get-summary-by-token` to select `leases.discount_rate` and `leases.discount_rate_basis`, compute the effective rate with `COALESCE(lease.discount_rate, workspace.discount_rate)`, and expose the source/basis in the public summary when appropriate. Add a regression test for a lease with a per-lease override.

### P2-11: Invite account-existence checks use unpaginated admin user scans

Evidence:

- `supabase/functions/get-invite-info/index.ts:45-46` calls `supabaseAdmin.auth.admin.listUsers()` and searches the returned page for the invited email.
- `supabase/functions/accept-invite/index.ts:85-89` repeats the same pattern before creating a new invited user.

Impact:

As the auth user table grows, a single unpaginated `listUsers()` call can misclassify existing users that are not in the returned page. The invite UI may show the wrong path, and the new-user path may fail later with a duplicate-account error. It is also an inefficient use of the admin API on a public invite flow.

Recommendation:

Use a direct account lookup where available, or rely on the `profiles.email` table with a unique normalized email contract. If admin listing remains necessary, paginate deterministically and centralize the helper so invite metadata and acceptance cannot diverge.

### P3-01: Public repo identity still looks like a starter project

Evidence:

- `package.json` still uses the package name `vite_react_shadcn_ts` and version `0.0.0`.
- `README.md` contains Lovable starter copy and placeholder project URL text.

Impact:

This does not directly break the product, but it weakens operational clarity and makes the repository look less mature to collaborators, investors, auditors, or future maintainers.

Recommendation:

Update `package.json`, `README.md`, setup instructions, environment descriptions, and deployment notes to reflect LeaseIO's actual product and operations.

## Verification Log

Commands run locally:

```powershell
npm.cmd run typecheck
```

Result: failed with `src/integrations/supabase/types.ts(1,9): error TS1005: ';' expected.`

```powershell
npm.cmd run build
```

Result: failed while loading Vite config because `@swc/core-win32-x64-msvc/swc.win32-x64-msvc.node` could not load and a `spawn EPERM` error was raised.

```powershell
npm.cmd test
```

Result: failed with the same SWC/native dependency and `EPERM` error.

```powershell
npm.cmd run check:supabase-types
```

Result: passed, but this check is insufficient because it only looks for expected table-name substrings.

```powershell
npm.cmd run smoke:security
```

Result: skipped with `No Supabase smoke-test environments configured. Skipping.`

Additional targeted searches were run across `src`, `supabase/functions`, `supabase/migrations`, and `docs` for entitlement checks, AI consent gates, CORS origin handling, storage policies, report cleanup, public views, `security_invoker`, base table creation, workspace-scoped billing behavior, direct lifecycle updates, Edge Function auth config, CI release gates, and per-lease discount-rate usage.

## Recommended Remediation Order

1. Fix the malformed Supabase types file and make `typecheck`, `build`, and `test` reliable in CI and locally.
2. Make migrations replay cleanly from an empty database and regenerate Supabase types from that source of truth.
3. Fix onboarding so all client-created workspaces start as Starter and Stripe webhook promotion is the only path to Business entitlements.
4. Move approval, lifecycle, and model-lock mutations behind trusted Edge Functions or RPCs and block direct client updates to sensitive columns.
5. Fix billing CORS by reflecting the validated request origin.
6. Harden public tenant-sensitive views with `security_invoker`, revoked direct grants, or RPC/Edge boundaries.
7. Make Edge Function auth settings complete in `supabase/config.toml`, including public invite metadata.
8. Add centralized backend gates for plan entitlement, quota, rate limit, prompt-size, and AI consent before every expensive or AI-powered function.
9. Build invite URLs from canonical `APP_URL` and stop trusting request `Origin` for token-bearing links.
10. Tighten report PDF storage and expiry policies so storage authorization matches report finalization and retention state.
11. Extend account/workspace deletion to every customer-data bucket and add deletion tests.
12. Reconcile cron secret naming and add cron deployment verification.
13. Escape all user-controlled text in transactional email HTML.
14. Refactor the largest generated files and mirrored business logic after release blockers are closed.

## Release Gate Recommendation

Do not treat the current repository as production-ready until all P0 findings are fixed and verified. For a controlled private pilot, I would also require the P1 billing, quota, consent, legacy AI function, AI abuse-control, report integrity, direct lifecycle mutation, tenant-view, migration-replay, invite, and deletion findings to be fixed or explicitly accepted in a written risk register.
