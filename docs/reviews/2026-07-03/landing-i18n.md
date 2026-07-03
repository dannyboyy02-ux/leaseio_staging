# Landing / Marketing Surfaces + i18n Integrity — Audit Report

Reviewer lane: landing & marketing pages, free lease-audit funnel, Terms/Privacy, i18n integrity.
Repo: `/home/user/leaseio_staging` · Date: 2026-07-03 · All claims verified from code; file:line evidence throughout.

Files read in full: `src/pages/{Landing,LeaseAudit,Terms,Privacy,NotFound,PublicSummaryPage,Signup,Login}.tsx`, all 8 `src/components/landing/*.tsx`, `src/hooks/useAppTranslation.ts`, `src/contexts/LanguageContext.tsx`, `src/i18n.ts`, `src/config/pricing.ts`, `supabase/functions/audit-session/index.ts`, `supabase/functions/create-checkout/index.ts` (checkout portion), `src/lib/cancellationLifecycle.ts`, `src/contexts/AppContext.tsx` (workspace resolution), `src/components/auth/ProtectedRoute.tsx`, `src/pages/app/Onboarding.tsx` (creation flow), plus locale JSON diffs and a 12-screen hardcoded-string sweep.

---

## 1. The Free Lease-Audit Funnel — BROKEN END-TO-END for its target audience (HIGH)

CLAUDE.md positions this as the GTM lead magnet: "5 docs free → portfolio summary → upgrade CTA to Starter." The landing hero's **primary** CTA is `Start Your Free Lease Audit` → `/lease-audit` (`src/components/landing/HeroSection.tsx:33-36`). Traced in code:

1. **`/lease-audit` is behind `ProtectedRoute`** (`src/App.tsx:129-135`). An anonymous visitor — the entire audience of a lead magnet — is bounced to `/login` before seeing the page.
2. **The return path is dead.** `ProtectedRoute` passes the intended destination as router state: `<Navigate to="/login" state={{ from: location }} />` (`src/components/auth/ProtectedRoute.tsx:23-25`). But `Login.tsx` never reads `location.state` — it only reads a `?next=` **query param** that ProtectedRoute never sets (`src/pages/Login.tsx:65-67`), then navigates to `/app/dashboard`. Repo-wide grep confirms `location.state`/`state?.from` is consumed nowhere. The visitor who logs in lands on the dashboard, not the audit.
3. **A brand-new prospect can never arrive at all.** From the login wall they'd click sign-up → `Signup.tsx` → `/app/onboarding` (`src/pages/Signup.tsx:162`) → creates a real Starter workspace → `/app/leases` (`src/pages/app/Onboarding.tsx:131-135`). The audit page is never revisited. The only route back is manually retyping the URL.
4. Even authenticated, the page double-gates: `startAudit` re-checks the session and shows "Please sign in before starting an audit." (`src/pages/LeaseAudit.tsx:91-95`) — with no sign-up link in that error state.
5. **The results-page CTA targets the wrong audience.** Since only authenticated users can reach results, "Start with Starter — $249/mo" linking to `/signup?plan=starter` (`src/pages/LeaseAudit.tsx:509-517`) sends an already-signed-in user to the account-creation form.
6. **Results are ephemeral.** Extracted leases are held in component state only; the page never re-fetches the audit workspace's existing leases on mount. A returning user sees the empty collect step, and once 5 slots are used every upload errors with the server 429 (`audit-session/index.ts:160-171`) — whose message tells the *authenticated* user to "Create an account to analyze your full portfolio."
7. `slotsRemaining` is returned by the server (`audit-session/index.ts:307-312`) but never displayed by the client.

**Verdict:** the funnel works only for a user who already has an account AND manually navigates to `/lease-audit`. For the marketing audience the hero CTA is a login wall with no way back. Either the audit should be truly anonymous (per the lead-magnet framing) or the CTA/copy must say "sign up to run your free audit" and the post-auth redirect must actually work.

**Recommendations:** (a) consume `location.state.from` in Login (and thread a `next` through signup→onboarding) so the funnel resumes; (b) add a sign-up CTA on the audit page's unauthenticated state; (c) hide/replace the `/signup` CTA on results for signed-in users; (d) re-hydrate prior audit results on mount; (e) surface `slotsRemaining`.

### 1b. Audit workspaces leak into the real app (MEDIUM)

`audit-session` creates a service-role workspace `{ name: "Free Audit – <email>", plan: 'audit', document_limit: 5 }` (`supabase/functions/audit-session/index.ts:136-145`). Nothing in the frontend filters `plan='audit'`:
- `AppContext`'s owned-workspace queries have no plan filter (`src/contexts/AppContext.tsx:134-142, 301-304`), so "Free Audit – email" appears in the workspace switcher, displayed as plan **starter** because `normalizePlanId` coerces unknown plans to `'starter'` (`src/config/pricing.ts:222-226`).
- Worse, the current-workspace fallback picks the **oldest owned workspace** (`AppContext.tsx:134-142`); for a member-only user whose first owned workspace is the audit one, the audit workspace becomes their resolved workspace, with audit leases inserted as `status:'Ready', lifecycle_status:'active'` (`audit-session/index.ts:263-287`).

### 1c. Audit 5-doc cap is bypassable → unbounded Opus spend (MEDIUM, cost/abuse)

Workspace lookup uses `.maybeSingle()` with the error discarded (`audit-session/index.ts:126-134`). Two racing first requests each see "no audit workspace" and both insert one (no unique constraint on (owner_id, plan) exists — checked `supabase/migrations/20260516120000_baseline_schema.sql`; only `profiles_plan_check` found). Once a user has 2+ audit workspaces, every subsequent no-`workspaceId` call errors in `maybeSingle`, `existing` is null, and **another** workspace is created — each with a fresh 5-doc allowance and a fresh per-workspace rate-limit bucket (`enforceWorkspaceRateLimit` is workspace-scoped, `audit-session/index.ts:173-180`). Any authenticated account (signup is open/free) can loop this for unlimited Opus-4-6 PDF extractions. Recommendation: unique partial index on `workspaces(owner_id) WHERE plan='audit'`, treat lookup error as fatal, and add a per-USER rate limit.

---

## 2. Landing copy vs shipped reality (Hard Rule 6)

Pipe-verified claim by claim. Copy lives in `src/locales/en/common.json` under `landing.*` (line refs below are en/common.json; es mirrors every claim at the same keys).

| # | Claim (location) | Reality in code | Verdict |
|---|---|---|---|
| C1 | "Start with a 7-day free trial" (`landing.pricing.subtitle`; button `start_trial`, PricingSection.tsx:58) | **No trial exists on the default signup path.** Onboarding inserts a Starter-default workspace and goes straight to `/app/leases` — no checkout, no trial clock, no gate (`src/pages/app/Onboarding.tsx:84-135`). `trial_period_days: 7` exists only inside Stripe checkout (`create-checkout/index.ts:46,210`), which a Starter signup never enters. Nothing server-side blocks a never-paying workspace: `checkProcessingQuota` checks caps/canceled/vault only (`process_lease/index.ts:990-1110`); `sweep-pending-workspaces` covers only `workspace_creation_requests` (additional workspaces), not first signups (`sweep-pending-workspaces/index.ts:50-55`). Net: signups get **indefinite free Starter usage incl. 15 Opus abstractions/month**. | **HIGH — claim unimplemented + revenue leak** |
| C2 | "No credit card required to start" (`src/pages/LeaseAudit.tsx:519`, hardcoded JSX) | The repo's own test **bans this exact copy** from locales (`src/lib/__tests__/subscriptionSettingsPolish.test.ts:143-158` — "stale trial copy"); it survives here only because it's hardcoded JSX, not a locale string. The actual trial checkout collects a card (no `payment_method_collection:'if_required'` in `create-checkout/index.ts:187-217`). | **MEDIUM — contradicts repo's own copy policy** |
| C3 | Roles: "Owner, Admin, Manager, Reviewer, or Read-only… permissions for billing, integrations, and lease management" (`landing.faq.multiple_users.a`, en:419-421) | Actual roles: `'admin' \| 'editor' \| 'viewer'` (`src/types/index.ts:38`) + owner. **"Manager" and "Reviewer" roles do not exist**; there is no "integrations" permission surface (Integrations page removed; only `integrations.upgrade_business` key still referenced, `src/pages/Reports.tsx:153`). | **MEDIUM-HIGH — false capability claim** |
| C4 | "…until you upgrade your plan or your billing period resets" (`landing.faq.document_limit.a`, en:409) | Quota is a **rolling trailing-30-day window**, explicitly not billing-period-aligned (`process_lease/index.ts:953-954,1059`; CLAUDE.md confirms descoped 2026-06-11). Also omits the two shipped relief valves: document packs and buy-1-lease credit (`LimitReachedDialog` mounted at `src/pages/Leases.tsx:1080`). | **MEDIUM — wrong mechanics, understates options** |
| C5 | "we delete your data within 30 days" (`landing.faq.data_ownership.a`, en:413) | Code: 30-day read-only grace **then** ~10-day purge buffer (`src/lib/cancellationLifecycle.ts:8-9` — `GRACE_DAYS=30`, `PURGE_BUFFER_DAYS=10`); deletion completes ~day 40. | **MEDIUM — inaccurate retention promise** (see §4) |
| C6 | Demo panel "See how LeaseIO reads a lease in 60 seconds" (`landing.hero.demo_coming`, en:304; HeroSection.tsx:61-73) | Renders a permanent empty placeholder box (icon + caption, no video/demo asset anywhere). A visible "coming soon" stub on the production hero. | **MEDIUM — shipped placeholder** |
| C7 | "SOC 2 compliant hosting … 99.9% uptime" (`landing.security.hosting`, en:387-390); "TLS 1.3… SOC 2 compliant" (`landing.faq.security.a`, en:417) | Vendor-inherited compliance claims presented as LeaseIO's own; 99.9% uptime is an SLA promise backed by nothing in code/ops. | **LOW — risky marketing copy** |
| C8 | "End-to-end encryption" (`landing.security.encryption.title`, en:379) | Body copy correctly says at-rest + in-transit; the **title** overclaims — data is server-readable and sent to Anthropic/Azure DI for processing (per Privacy §3 itself). | **LOW — technically wrong term** |
| C9 | "Every lease ends up in the repository… regardless of how it arrived" (`landing.features.subtitle`, en:308) | Only Path 1 (request workflow) + direct upload exist; email intake (Path 2) and the backdoor loader are NOT built (no code; matches CLAUDE.md "NOT YET BUILT"). No explicit email-intake promise on the page (good), but "regardless of how it arrived" gestures at multi-path intake. | **LOW — borderline** |
| C10 | "© 2024 LeaseIO" (`landing.footer.copyright`, en:439; es same) | It is 2026. | **LOW — stale** |
| C11 | Features grid — Lease Request Intake, Pipeline Visibility, AI Abstraction, Notifications, Audit Repository (`landing.features.*`) | All verifiably built (LeaseRequestForm/ApprovalQueue; Dashboard pipeline; process_lease two-pass; dispatch-notifications; lease_activity_log + Leases CSV export at `src/pages/Leases.tsx:670-697`). | **OK** |
| C12 | How-it-works step 2 "Attach LOIs, drafts, or term sheets" | Built — negotiation docs (Phase 4): `src/components/leases/documents/{UploadDocumentDialog,DocumentsTimeline}.tsx`. | **OK** |

Positive note: the hero's core positioning ("Send us your leases. We'll tell you what's in them.", awareness-not-accounting framing) matches PRODUCT_STRATEGY and Hard Rule 1/6 — no ASC-842/compliance promises on the landing page.

---

## 3. Pricing section vs `src/config/pricing.ts` — CONSISTENT (verified)

`PricingSection.tsx` renders **directly from config** (`PLAN_ORDER`, `PLANS`, `ANNUAL_DISCOUNT_PERCENT` — PricingSection.tsx:9,31-63), so drift risk is structurally low:

- Starter $249/mo, annual $2,390 → displays $199/mo (2390/12 rounded) — matches `pricing.ts:55`. Business $499 / $4,790 → $399 — matches `pricing.ts:83`. "Save 20%": 2390/2988 and 4790/5988 are both exactly 20% off ✓ (`ANNUAL_DISCOUNT_PERCENT=20`, pricing.ts:152).
- Feature lists match config `featureKeys` (pricing.ts:62-69, 90-98): Starter = intake/AI extraction/pipeline/audit export/15 abstractions/3 users; Business = everything + 50 abstractions/AI assistant/portfolio intelligence/amendment comparison/unlimited users/priority support. Locale strings exist for every key (en:1424-1449).
- Vault correctly absent (`PLAN_ORDER` excludes it, pricing.ts:149).
- LeaseAudit's hardcoded "$249/mo" (`LeaseAudit.tsx:511`) currently matches but is a drift trap — should read `PLANS.starter.price.monthly`.

**Two pricing-adjacent flags:**
1. **Starter advertises "Audit-ready lease population export"** (`pricing.ts:66`) while **CLAUDE.md's pricing table lists "Audit Package" as Business-only**. In code the Leases-page population CSV export is available to all plans (`src/pages/Leases.tsx:670-697,815-824`) but the Reports page (incl. `RentRollExport`, "Export all") is Business-gated (`src/pages/Reports.tsx:73`). Config, docs, and gating disagree → docsDrift, needs a ruling.
2. Dead entitlement flags: `hasAdvancedReports/hasRoleBasedAccess/hasBulkUpload/hasExportIntegrations` are set per-plan (pricing.ts:71-74,100-103) but **no gate anywhere reads them** (only a vault test references `hasBulkUpload`). Dead config implying features (bulk upload, export integrations) that don't exist.
3. Annual purchase depends on `STRIPE_PRICE_*_ANNUAL` env (fail-closed 503) — the landing annual toggle promises a path that 503s until the operator STOP-7 item is done (unverifiable from code; flagged for the ops lane).

---

## 4. Terms & Privacy staleness (both locales identical in content)

- **T1 (MEDIUM): "Last updated:" renders TODAY'S date, always.** Both pages print `new Date()` (`src/pages/Terms.tsx:19-24`, `src/pages/Privacy.tsx:19-24`). Legal docs claim they were updated the day you happen to read them. Should be a fixed constant bumped on real edits.
- **T2 (MEDIUM): Terms §2 claims "integrates with accounting systems"** (en:1876). No accounting integration exists anywhere in the repo, and the whole positioning is "works ALONGSIDE accounting tools" (Hard Rule 1). False service description in a legal doc.
- **T3 (MEDIUM): Terms §4** (en:1884): "billed monthly in advance" — annual billing exists (create-checkout annual price IDs; PricingSection annual toggle); "Document limits are enforced per billing period" — enforcement is a rolling 30-day window (`process_lease/index.ts:1059`), deliberately NOT billing-period-aligned. Also silent on packs/overage credits, which are real paid mechanics that belong in billing terms.
- **T4 (MEDIUM): deletion-window contradictions.** Terms §7 "deleted within 30 days" (en:1896) and Privacy §5 "we delete… within 30 days" (en:1851) contradict both the code (30-day grace + 10-day purge buffer ≈ 40 days, `cancellationLifecycle.ts:8-9`) and **Privacy §8 in the same document**, which states the correct 30+~10 policy (en: privacy.section8). Privacy §5's extra "up to 90 additional days" backup clause further muddies it. One document, two retention stories.
- **T5 (MEDIUM): wrong contact domain.** Terms §8 mailto is `legal@leaseio.com` (`Terms.tsx:96`; locale `terms.section8.email`) while every other surface uses `theleaseio.com` (footer `support@theleaseio.com` FooterSection.tsx:76; privacy `privacy@theleaseio.com`; CLAUDE.md registrar is `theleaseio.com`). Legal inquiries likely go to an unowned domain.
- **Accurate parts (verified, no finding):** Privacy §3 sub-processor table matches reality — Azure DI OCR path exists (`supabase/functions/retry_lease/index.ts:13-15,156-161`, `_shared/audit.ts:36+`), Resend/Stripe/Supabase/Vercel/Anthropic all real; §6 account deletion from Account Settings exists (`AccountSettings.tsx:367,920-947`); §8 matches `GRACE_DAYS/PURGE_BUFFER_DAYS` exactly.

---

## 5. i18n integrity

### 5a. Locale parity — PERFECT at the file level
Flattened key-set diff: **EN 1697 keys, ES 1697 keys; 0 missing in each direction.** Only 27 identical EN==ES values, essentially all legitimately language-neutral (brand names, "Total", "Error", "Plan", provider names). The two files are maintained together as CLAUDE.md mandates. `src/i18n.ts` config is sound (localStorage+navigator detection, en fallback); `useAppTranslation.ts` and `useLanguage` are thin correct wrappers over i18next.

### 5b. Actual coverage — HALF THE APP BYPASSES i18n ENTIRELY (HIGH)
The locale files are only half the story. A 12+-screen sweep for `t()` usage vs raw English:

| Screen | t() calls | Status |
|---|---|---|
| `src/pages/app/ApprovalQueue.tsx` | **0** | 100% hardcoded ("All Pending" :1329, "Approve & Unlock" :1388, dialogs :1570,1599) |
| `src/pages/app/SignatorReview.tsx` | **0** | hardcoded incl. toasts (:289,303) |
| `src/pages/app/FinancialReview.tsx` | **0** | hardcoded (:151-311) |
| `src/components/workflow/LeaseRequestForm.tsx` | **0** | "New Commitment Request" :431, all labels :508,661 |
| `src/pages/app/Portfolio.tsx` | **0** | ":357 Business-plan upsell", empty states :435-449 |
| `src/components/ai/AiAssistant.tsx` | **0** | ":208 Business plan required", placeholder :278 |
| Dashboard widgets (`SummaryStrip` :171-185 'Monthly Rent'/'Needs Action'/'Awaiting Approval'; `NeedsAction` :53,122,151; `RecentActivity` :173,202; +8 more) | ~0 | hardcoded |
| `src/pages/app/LeaseReview.tsx` | 22 (partial) | ~90 hardcoded toasts (:534-2400) |
| `src/pages/LeaseAudit.tsx` | **0** | entire funnel page hardcoded (imports i18n only for currency) |
| `src/pages/PublicSummaryPage.tsx` | **0** | hardcoded + hardcoded light-only palette (bg-gray-50 :56,67,80) |
| Leases (65), AccountSettings (145), WorkspaceSettings (31), Reports (18), AuditLog (20), Notifications (23), NotFound, FirmDashboard (14), auth pages | high | properly translated |

Toast layer: **189 hardcoded English toast strings across 45 files** (`grep toast.(error|success|…)('[A-Z]…')`). Server-returned errors shown to users (audit-session, process_lease quota messages `process_lease/index.ts:982-983`) are also English-only.

**Net effect:** a Spanish-language user gets a fully translated landing page, login, signup, settings, and Leases list — then hits an all-English approval workflow (the Path-1 core), all-English dashboard KPIs, and English toasts everywhere. The pattern is a translated shell around an untranslated core. CLAUDE.md's "i18n: i18next with English + Spanish locales" materially overstates coverage → docsDrift.

**Recommendation:** decide whether ES is a supported product surface or landing-only. If supported, the gap is ~45 files of toast extraction + 6 whole screens; if landing-only, say so in CLAUDE.md and hide the in-app toggle for consistency.

### 5c. Dead locale keys (LOW)
13 unused `landing.*` keys in both locales (`hero.cta_signin`, `pricing.{free,get_started,per_year,lease,leases,custom,contact,enterprise}`, `footer.{about,blog,careers,company}`) — leftovers from an older 3-tier render (the "Contact us for enterprise pricing" row is defined but never displayed). The `integrations.*` section (en: OAuth/SMS/sync-log copy) survives with only `upgrade_business` referenced (`Reports.tsx:153`) — orphaned copy describing features that don't exist.

---

## 6. NotFound / PublicSummaryPage

- `NotFound.tsx` — properly translated (`not_found.message/return_home`), fine. Renders for any unmatched route incl. under `/app` (App.tsx:443).
- `PublicSummaryPage.tsx` — functional end-to-end: `/share/:token` (public, App.tsx:140) → `get-summary-by-token` edge fn (exists, `supabase/functions/get-summary-by-token/index.ts`) → renders `FinancialImpactSummary`. Findings: 100% hardcoded English (:59,70-73,86,91) on a page explicitly meant for external recipients; hardcoded light palette (`bg-gray-50`, `text-gray-900` :56,67,80) diverges from the theme system; "Download PDF" button is actually `window.print()` (:50,89-92) — mislabeled (prints, doesn't download) — LOW polish.

---

## 7. docsDrift summary (docs claim ≠ code)

1. **CLAUDE.md pricing table**: "Audit Package" Business-only vs `pricing.ts:66` selling it on Starter (and plan-agnostic Leases CSV in code). Needs a ruling; today three sources disagree.
2. **CLAUDE.md "Free Lease Audit… 5 docs free → upgrade CTA"**: code implements it authenticated-only behind ProtectedRoute with a broken post-login return path (§1) — the "lead magnet" cannot be reached by leads.
3. **CLAUDE.md "i18n: i18next with English + Spanish locales (both locale files updated together)"**: file parity is real, but ~half the app's surfaces never call `t()` (§5b) — the doc implies a bilingual product that doesn't exist beyond the shell.
4. **CLAUDE.md pricing model "7-day trial"** (and landing copy): no trial is implemented on the default signup path (§2 C1); the only trial is inside an optional Stripe checkout.
5. Terms §2 "integrates with accounting systems" contradicts both code (no integrations) and CLAUDE.md's own "NOT a lease accounting tool / works alongside" identity.

---

## 8. Rebuild vs fix

**Fix.** The landing architecture is genuinely good: config-driven pricing (single source of truth, zero drift found in numbers), clean section components, solid i18n plumbing, perfect locale-file parity, and a working public share page. Everything found is copy drift, one broken funnel handoff (2 small code changes: consume `state.from` in Login; thread `next` through signup), legal-page constants, and a mechanical (if large) t()-extraction backlog. Nothing structural needs rebuilding.

## 9. Prioritized fix list

1. (HIGH) Repair the lease-audit funnel: post-login/signup redirect honoring the intended destination; unauthenticated-state signup CTA on `/lease-audit`; or make the audit genuinely anonymous per the GTM framing.
2. (HIGH) Resolve the trial story: either implement the 7-day trial for Starter signups (checkout-first or a trial clock + gate) or change the landing copy; today's copy promises something that doesn't exist and the current behavior is indefinite free usage with real Opus spend.
3. (MEDIUM) audit-session: unique partial index + treat lookup errors as fatal + per-user rate limit (cost-abuse hole); filter `plan='audit'` workspaces out of AppContext (or exclude from the fallback picker).
4. (MEDIUM) Terms/Privacy: fixed last-updated date; remove "integrates with accounting systems"; correct §4 billing mechanics (annual + rolling window + packs); reconcile the 30-day vs 30+10 retention story (make §5/§7/FAQ match §8/code); fix `legal@leaseio.com` → `@theleaseio.com`.
5. (MEDIUM) FAQ: correct the roles list to Owner/Admin/Editor/Viewer; correct document-limit answer to rolling-30-day + packs/credit.
6. (MEDIUM) Remove or fulfill the hero demo placeholder; remove "No credit card required" from LeaseAudit (banned copy per repo test).
7. (LOW) Copyright year; dead locale keys; dead entitlement flags in pricing.ts; PublicSummaryPage i18n/theme/"Download PDF" label; LeaseAudit hardcoded $249.
8. (LARGE, scope decision) ES coverage for the app core (~45 files of toasts + ApprovalQueue/Portfolio/AiAssistant/LeaseRequestForm/SignatorReview/FinancialReview/dashboard widgets + LeaseAudit) — or an explicit "landing-only Spanish" ruling.
