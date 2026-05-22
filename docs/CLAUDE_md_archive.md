# CLAUDE.md Archive

Historical content trimmed out of the root `CLAUDE.md` to keep it under the Claude Code context-budget threshold (~40k chars). Nothing here is active guidance — it is preserved **verbatim** as a point-in-time record so the history is recoverable without polluting active session context. Active rules live in `CLAUDE.md`; resolved/closed detail, finished-module standing rules, and hard-won incident lessons live here.

When in doubt, `CLAUDE.md` + the underlying `docs/` specs are the source of truth, not this file.

---

## 2026-05-21 — CLAUDE.md trim (50.4k → ~28k chars)

Root `CLAUDE.md` had grown to 50,386 characters, above the 40k threshold that slows session startup and burns context budget. The sections below were copied here verbatim and either removed from `CLAUDE.md` or replaced with a compact pointer/checklist. The reorganization preserved every active rule, convention, and live gotcha in `CLAUDE.md`.

Verification done at trim time:
- **Phase 7 `resolve-approval-chain` redeploy** — confirmed still permanently deferred (graceful degradation; remediation SQL in `PHASE_7_BUILD_SPEC.md` A4). Kept in active `CLAUDE.md` in compact form.
- **Ops Monitoring "Sentry + Anthropic pending tokens"** — Anthropic confirmed DONE 2026-05-11; Sentry optional/owed. Dated snapshot archived below.
- **Ops Monitoring "~60 min Daniel-side dashboard work"** — Anthropic cap + registrar confirmed DONE 2026-05-11; live-mode Stripe webhook + renewal calendar still owed. Dated snapshot archived below.

---

### [Archived 2026-05-21] Approval Routing Architecture — closed-phase as-built detail

> Replaced in `CLAUDE.md` by a compact pointer + table. All of Phases 1–8 are CLOSED; the per-phase as-built prose below is reference-only. The underlying `docs/PHASE_*_BUILD_SPEC.md` files remain the source of truth.

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

#### Owner Workspace Management — CLOSED 2026-05-05

- **`docs/OWNER_WORKSPACE_MGMT_BUILD_SPEC.md`** — **CLOSED.** Owner-facing UI at `/app/account/workspaces`. Reusable `MembersPanel`, rename inline, type-name-confirm delete backed by `delete-workspace` edge function with transactional cascade + storage cleanup. `deleted_workspaces` audit table.

#### Parallel module — Market Data & IBR (spec only, not yet started)

- **`docs/MARKET_DATA_IBR_MODULE.md`** — **SPEC FILED 2026-05-05.** Independent workstream, NOT a phase. Does NOT consume a phase number. Migration SQL is inline in the spec doc, NOT in `supabase/migrations/` until the module opens. Standing rules below.

---

### [Archived 2026-05-21] Active Workstreams — Operational Monitoring dated status detail

> Replaced in `CLAUDE.md` by a compact pointer. The dated per-phase status below is a 2026-05-09 snapshot; several items have since completed (see verification note at top of this dated section). `docs/OPERATIONAL_MONITORING_SPEC.md` + `docs/ops/OPERATOR_PLAYBOOK.md` + `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md` are the live source of truth.

Parallel workstreams currently in flight, beyond the numbered phases. Each has a dedicated spec; the entries here are pointers, not full status.

**Module: Operational Monitoring** — vendor health, quota tracking, renewal calendar, customer-facing quota warnings. Spec: `docs/OPERATIONAL_MONITORING_SPEC.md`.

- Phase 1 (no-code operational hardening) — VERIFICATION ARTIFACT FILED 2026-05-09 at `docs/ops/PHASE_1_VERIFICATION_2026-05-09.md`. ~60 min of Daniel-side dashboard work still owed (Anthropic spending cap, registrar 2FA + auto-renew, Stripe webhook health, manual renewal calendar).
- Phase 2 (core monitoring infrastructure) — SHIPPED 2026-05-09 (commit `9a05bd7`). Admin dashboard at `/app/admin/operations`.
- Phase 3 (customer-facing & coverage expansion) — SHIPPED 2026-05-09 (commit `6393b25`). QuotaWarningBanner mounted in AppLayout (80% dismissible / 95% persistent). Backup-restore runbook at `docs/ops/backup-restore-runbook.md`. Stripe activated automatically; Sentry + Anthropic pending operator-side tokens.
- Phase 4 (firm-layer aggregation) — blocked until Phase 9 ships.

**Module: Email Intake (Path 2)** — strategic capture path for post-execution leases. Plan: `docs/EMAIL_INTAKE_PLAN.md`. Decisions ratified 2026-05-09 in `docs/EMAIL_INTAKE_DECISIONS.md`. Vendor: Resend Inbound. Sender policy: domain allowlist + pending-sender queue at v1. Tier gating: all tiers with per-tier daily caps. Status: ratified, not yet built.

**Module: Market Data & IBR** — see standing rules below. Spec: `docs/MARKET_DATA_IBR_MODULE.md`. Status: spec only, not yet started.

**Verification update at trim time (2026-05-21):** Anthropic spending cap DONE 2026-05-11; domain registrar hardened DONE 2026-05-11; Anthropic monitoring token landed (`ANTHROPIC_ADMIN_API_KEY`, `ANTHROPIC_MONTHLY_CAP_USD=100`). Still owed: live-mode Stripe webhook destination (before customer #1), manual renewal calendar (~30 min), optional Sentry token.

---

### [Archived 2026-05-21] Module: Market Data & IBR — Standing Rules (full)

> Replaced in `CLAUDE.md` by a compact pointer. Module is spec-only, not started; full rules live in `docs/MARKET_DATA_IBR_MODULE.md`. Restore these to active context when the module opens.

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

---

### [Archived 2026-05-21] Always Check For — full original (touchpoints + incident narratives)

> Replaced in `CLAUDE.md` by a compressed checklist of the actionable one-liners. The full touchpoint lists and the long hard-won incident narratives (migration-squash/drift saga, security-migration pre-push review story, etc.) are preserved verbatim here. Cross-reference the named `docs/` specs for current detail.

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
- Restoring a previously-shrunk drift-detection function will surface drift on its first run. When restoring `audit_rls_smoke_check()` (or any similar function) to its full key set after a period of narrowed coverage, expect new KNOWN_ISSUES filings on the first post-apply run — those represent drift that accumulated silently during the narrowed window. Plan for triage time on the first post-apply smoke run after any drift-detection scope restoration. Each Category A false return is a new beat candidate, not a single-fix problem.

**Security migrations — pre-push reviewer routing is required** (cross-reference: any migration touching RLS policies, role grants, SECURITY DEFINER functions, audit infrastructure, or trigger functions):

- Reviewer routing happens BEFORE `db push`, not after. The default workflow elsewhere in CLAUDE.md (reviewers post-apply on non-security changes) is wrong for this class. Concretely validated 2026-05-16: a first migration shipped pre-review caught a Critical post-apply (smoke check coverage regression) that required a follow-up migration to exist. The follow-up went through 5 rounds of pre-push review and converged through Critical → High → Medium → Low. Pre-push review catches what a single post-apply review misses.
- Iterative pre-push review converges. On security-sensitive migrations of this complexity, expect 3+ rounds before reviewers clear. The cost of running another round (5 min agent time when clean) is dramatically less than the cost of skipping it when it would have caught something (another prod migration to write, plus erosion of trust in the review-before-push rule).
- "Predicted-clean" is not the rule. Even when the trajectory of findings is converging (Critical → High → Medium → Low), continue iterating until reviewers actually return clean. Skipping the final round because "it will probably be clean" is the failure mode.
- When reviewers find gaps in a piecemeal pattern (field X missing, then field Y, then field Z), step back to the class shape: is the gap field-shaped or class-shaped? Comprehensive coverage over an enumerated set is usually less total work than chasing reviewer-surfaced symptoms across iterations. For RLS / trigger changes, enumerate ALL columns on the table and categorize each; for policy changes, enumerate ALL operations (INSERT/UPDATE/DELETE/SELECT) and verify each.
  - **Procedure for comprehensive column coverage on a trigger guarding governance tables:** (1) Pull the full column list from the live schema via `pg_attribute` query, not from the schema dump (which may be stale). (2) For each column, assign exactly one category: universal-immutable, role-restricted-mutable, or freely-mutable. (3) If a column doesn't fit cleanly, that's a finding — surface the ambiguity for discussion rather than guessing. (4) The trigger code derives from the categorization, not the other way around — enumeration first, code second.
- Faithfully reproducing a known-incomplete hardening is the failure mode, not an excuse. If an archived migration had `WITH CHECK (true)` and a new migration restoring that policy reproduces `WITH CHECK (true)` verbatim, the new migration is itself incomplete — the point of the restoration is to make prod match intent, not to make prod match a prior incomplete attempt. **The corollary:** when restoring archived hardening that never applied, the archive is input, not specification. Read what the archive intended to do, then write what should be there. If the archive's predicate is incomplete by current standards, the restoration is the right moment to fix it — not to faithfully reproduce the incompleteness.
- When surfacing a bug class on one governance table (e.g., RLS UPDATE policy too permissive), sweep adjacent governance tables proactively in the same review pass. Don't wait for one-at-a-time discovery. `lease_unlock_requests`, `lease_change_sets`, `lease_governance_audit`, and any other table with USER → admin approval flows share the same write-path threat model.
- Symmetric structural decisions: when scope-disciplining one finding (file as KNOWN_ISSUES, defer), apply the same discipline to structurally identical findings on adjacent tables. The scope discipline rule has to hold when bundling would be convenient — otherwise it's not a rule, it's a preference.

**Trigger ordering and column ownership** (cross-reference: any new BEFORE UPDATE / BEFORE INSERT trigger on a table that already has triggers):

- Postgres fires triggers in alphabetical order of trigger NAME (not function name). Multiple BEFORE UPDATE triggers on the same table that touch the SAME columns are implicit coupling — order matters and isn't documented in the trigger definition itself.
- Prefer the disjoint-columns pattern: each trigger owns a non-overlapping set of columns. `set_updated_at` owns `updated_at`; field-tampering triggers own their guarded columns; etc. Document the ownership invariant in the migration that adds the trigger.
- Before adding a trigger to a table that already has them, run: `SELECT tgname, proname FROM pg_trigger JOIN pg_proc ON pg_proc.oid = pg_trigger.tgfoid WHERE tgrelid = 'public.<table>'::regclass AND NOT tgisinternal ORDER BY tgname;` — verify column interactions from the live inventory, not from the schema dump (the dump may not reflect Studio-applied triggers).

**Static migration-file tests — `toContain` false positives** (cross-reference: any `src/lib/__tests__/*.test.ts` that reads migration files via `readFileSync`):

- When asserting properties of a specific named function / policy / trigger via `toContain` on a multi-object migration file, narrow the search window to that object's declaration block before applying `toContain`. Full-file `toContain` produces false positives that look like passing tests — e.g., `expect(migration).toContain('SECURITY DEFINER')` on a trigger function passes silently because another function later in the same file has `SECURITY DEFINER`. Pattern:

  ```typescript
  const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.target_fn()');
  const fnEnd = migration.indexOf('AS $$', fnStart);
  const declarationBlock = migration.slice(fnStart, fnEnd);
  expect(declarationBlock).not.toContain('SECURITY DEFINER');
  ```

- Static tests catch in-repo drift (someone edits a migration file). They do NOT catch live-DB drift (migration applies but live state diverges later via Studio). The complementary live-DB layer is `scripts/smoke-audit-hardening.mjs` via `npm run smoke:security` — wire it into CI when the SUPABASE_* secrets are configured (currently KNOWN_ISSUES #26).

---

### [Archived 2026-05-21] Subagent Routing — trailing lesson paragraphs

> The Subagent Routing table + "routing in practice" + "surfacing Critical/High findings" rule remain active in `CLAUDE.md`. These two trailing lesson-paragraphs were compressed there and are preserved verbatim here.

**Pre-existing issues surfaced (not introduced) by the current beat are their own beat.** When a reviewer or baseline pass surfaces production issues that predate the current change (security regressions, broken policies, dropped guards), file them in `docs/KNOWN_ISSUES.md` with stub remediation migrations and a brief root-cause hypothesis. Do **not** bundle the fix into the current commit. The current beat's scope is what got it routed through review; the surfaced issues deserve their own scoped commits with their own reviewer routing. Surfacing-vs-fixing are separate concerns. A baseline squash that documents a broken state is not the same as a commit that fixes the broken state, and conflating them muddies both the audit trail and the reviewer history.

**Smoke check categorization for governance hardening migrations.** When a migration extends `audit_rls_smoke_check()` or any similar drift-detection function, document expected behavior in three categories: (A) drift candidates — keys whose false return means an unrelated guard drifted, triage as new KNOWN_ISSUES; (B) name-based prior-migration assertions — keys that MUST return true post-apply or the prior migration silently failed, stop and investigate; (C) this-migration's hardening — keys that MUST return true post-apply or an active vulnerability survived. Encode the triage rule in `COMMENT ON FUNCTION` so operators triaging at 2am don't have to open the migration file.

---

### [Archived 2026-05-21] Files That Were Deleted (orphaned dead code — removed per audit)

> Replaced in `CLAUDE.md` by a one-line pointer. One-time cleanup aid; if you encounter references to these files, they are stale and should be cleaned up.

Pages: `Index.tsx`, `Auth.tsx`, `Integrations.tsx`, `LeaseDetail.tsx`
Components: `NavLink.tsx`, `CreateLeaseDrawer.tsx`, `WorkflowStatusBadge.tsx`, `NudgeButton.tsx` (lifecycle/), `ApproverSelect.tsx`, `ApprovalActions.tsx`, `RejectedLeaseCallout.tsx`, `LeaseCard.tsx`, `ReviewCard.tsx`, `PipelineView.tsx`, `NotificationConfigurator.tsx`, `QuickStats.tsx`, `UsageMeter.tsx`, `LeaseQuickView.tsx`
Archived (not deleted, may reuse): `CovenantHealthPanel.tsx`

---

### [Archived 2026-05-21] Task Queue — Closed (do not re-open)

> Replaced in `CLAUDE.md` by the active "Open / unstarted" queue only. The closed items below are historical; see git log for commit detail.

- Tasks 1–5 — shipped (orphaned-file cleanup; Support.tsx email + Onboarding plan default + AcceptInvite redirect + QuickBooks removal + FAQSection cleanup; AaaS landing copy + ASC 842 references removed; intake_source provenance; backdoor toggle in WorkspaceSettings). Owner workspace management also shipped (separate workstream). See git log.
- **Embedded AI assistant** — shipped at `src/components/ai/AiAssistant.tsx` + `supabase/functions/ai-assistant/index.ts`. Business-tier only, workspace-scoped RLS, mounted in `AppLayout.tsx`.
- **AI engine migration to Claude two-pass extraction (Tier 1)** — shipped in `supabase/functions/process_lease/index.ts`. Haiku page-mapping + single combined Opus call with page-group hints injected (as-built deviation from per-spec separate calls — same accuracy, lower cost). Azure DI removed. Deprecated OpenAI path remains as `_extractLeaseDataWithOpenAI_DEPRECATED` (~340 dead lines, safe to delete in a cleanup commit).
- **Tier 2 classification AI** — CLOSED 2026-05-08. Five-phase build: hard-gate pre-Tier-1; soft warnings; parent-lease auto-detection; in-context learning from corrections (`classification_corrections` table); override path for false rejections. NOT model fine-tuning — in-context only; corrections never cross workspace boundaries.
- **Tier 3 contextual AI v1** — SHIPPED 2026-05-08 (commit `7aeae7d`). `lease_insights` table, `generate-lease-insights` edge function (Sonnet, Business-gated, ~$0.04-0.08/call), `LeaseInsightsCard` on lease review. Manual-trigger only; auto-trigger wiring is v2.
- **Pricing reconciliation** — closed 2026-05-07. starter/business at $249/$499 with monthly + annual + 7-day free trial.
