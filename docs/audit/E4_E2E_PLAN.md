# E4 — Playwright e2e: scoped implementation plan (NOT yet built)

> **Status:** Scoped and decision-locked 2026-06-22 on branch `claude/affectionate-hamilton-bp58tu`. Build **deliberately deferred** to a dedicated session (owner decision) because bringup needs an iterative CI loop that can't be validated in the authoring container. This doc is the durable hand-off — a future session should be able to build E4 from this without re-deriving the decisions.

E4 is the last open item from `docs/audit/LEASEIO_AUDIT_2026-06-20.html` (all of P0–P3 + E1/E2/E3/F1 are done). The audit's finding: strong unit tests, **no end-to-end test for the full lease workflow**.

---

## Decisions already taken (don't re-litigate)

1. **Scope = the deterministic human-in-the-loop spine; quarantine the AI step.** The Path 1 happy path is: department submits a request → finance approves → executed document uploaded → **`process_lease` AI abstraction** → user confirms → lease locks into the repository. The AI extraction (`process_lease`) is slow, paid, and nondeterministic, so it must NOT live inside a reliable happy-path e2e. Seed past it.
2. **Backend = local hermetic (`supabase start`)**, NOT staging. Rationale: no staging-data pollution, no shared-env flake, and **no new GitHub secrets** (the local stack uses well-known local keys), so the e2e job can run on every PR including forks. Mirrors the existing `migration-replay` CI job's `supabase start` pattern.
3. **Two specs, split at the AI boundary:**
   - **Spec 1 — Intake & routing:** log in (seeded user) → submit `LeaseRequestForm` → assert it routes (`resolve-approval-chain`) → approve in `ApprovalQueue` → assert lifecycle `approved`.
   - **Spec 2 — Confirm & lock → repository:** service-role-seed a lease already at `status='Ready'` with canned `extracted_json` → open `LeaseReview` → confirm sections → "Lock Lease" → assert it lands `active` in `/app/leases` + `/app/portfolio`.
4. **The real-AI extraction gap is accepted**, covered by existing unit/contract tests. A nightly real-`process_lease` smoke test (gated on an Anthropic key, run off the PR path) is a documented FUTURE follow-up, explicitly **not part of E4**.

---

## Why this shape (the hard constraints found during scoping)

- **No e2e infra exists today** — greenfield. vitest runs `environment: "node"` only; only 2 files use `data-testid`. (`package.json`, `vite.config.ts`.)
- **No mock layer** — everything hits a real Supabase (`src/integrations/supabase/client.ts` reads `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`/`VITE_SUPABASE_PUBLISHABLE_KEY`). The happy path makes live `supabase.functions.invoke()` calls.
- **Auth = Supabase email/password** (`AuthContext.signInWithPassword`, `Login.tsx`). No test-login affordance, no seeded user. Active workspace resolves implicitly in `AppContext.fetchProfile` (needs a `profiles` row AND an owned `workspaces` row, else the app mounts but `workspace` stays null). `ProtectedRoute` gates on auth only.
- **Happy-path edge functions** (must be served locally): `resolve-approval-chain`, then `act-on-chain-step` (chain path) **or** `legacy-lease-action` (legacy fallback path), and `legacy-lease-action` again for the final model-lock. `process_lease` is the one we quarantine. **Simplest Spec 1 = no approval policies → legacy fallback** (fewer moving edge functions); `resolve-approval-chain` still runs but returns `legacyFallback`, and approval routes through `legacy-lease-action`.
- **Seeding must use the service-role key** (local), creating: confirmed auth user (`admin.createUser` with `email_confirm: true`) → `profiles` → owned `workspaces` → approver `workspace_roles` → (Spec 2) a `Ready` lease + canned `extracted_json` + a storage object under `${user.id}/${lease.id}/...`.
- **Auth reuse:** programmatic `signInWithPassword` in a Playwright `setup` project → persist `storageState` (Supabase stores the session in `localStorage`) → both specs reuse it. Don't drive the login form per test.
- **Async staleness:** wait on network-settled state, not fixed timeouts (`process_lease`→navigate→refetch; `AppContext` recomputes usage on every workspace load).

---

## Deliverables (build checklist)

1. `@playwright/test` devDependency + **`playwright.config.ts`** — a `setup` project (auth) + a `chromium` project depending on it; `webServer` boots `vite preview` (built with the local `VITE_*` env) against the local stack; `storageState` from the setup project.
2. **`e2e/` layer:**
   - `seed/seed.ts` (Node, local service-role) — creates user/profile/workspace/roles and the Spec-2 `Ready` lease + storage object. Idempotent + a teardown path.
   - `auth.setup.ts` — programmatic `signInWithPassword` → save `storageState`.
   - `tests/intake-routing.spec.ts` (Spec 1).
   - `tests/confirm-lock.spec.ts` (Spec 2).
   - `fixtures/` — a tiny valid test PDF + the canned `extracted_json` JSON.
3. **Stable selectors** — add `data-testid`s to the ~8–10 happy-path elements (request-form submit, approve button, confirm-tab + lock buttons, lease-list row, portfolio row). Additive, non-behavioral; route through `lease-product-polish` + `lease-code-auditor` since it touches src.
4. **CI** — a new parallel `e2e` job in `.github/workflows/ci.yml`: `supabase/setup-cli` → `supabase start` → serve the 3 happy-path edge functions (`resolve-approval-chain`, `legacy-lease-action`, `act-on-chain-step`) in the background → run `seed.ts` → `npm ci` → `npm run build` (local `VITE_*`) → `npx playwright install --with-deps chromium` → `npx playwright test`. **No secret-gating needed** (all local) — so unlike `smoke:security`, it runs on fork PRs too. Slow job; parallel with `test-and-build` + `migration-replay`.
5. `package.json` — `"test:e2e": "playwright test"`.
6. **`docs/E2E.md`** — how to run locally (`supabase start` + serve fns + seed + `test:e2e`), what the two specs cover, and the explicit AI-extraction gap + the nightly-smoke follow-up.

---

## Bringup reality (set expectations)

- The authoring container has **no Docker daemon and no browser/display**, so the stack and the e2e **cannot be run there**. Author + static-validate only (config/specs typecheck, seed-script review).
- **First green happens in CI.** Expect a few CI iterations (push → watch the `e2e` job → fix selectors/timing/seed → repeat) — normal e2e bringup, not a one-shot. Budget for it.
- Gotcha to watch: `supabase functions serve` fetches the functions' `https://deno.land` + `esm.sh` imports at serve time (CI has network); the edge functions need the local `SUPABASE_SERVICE_ROLE_KEY` in their env.

---

## First reads for the build session

1. `src/components/workflow/LeaseRequestForm.tsx:225-360` (submit + routing branch — Spec 1).
2. `src/pages/app/ApprovalQueue.tsx` `handleApprove` (~877) (Spec 1 approve).
3. `src/pages/app/LeaseReview.tsx:1126-1165` (confirm + `model_lock` — Spec 2).
4. `src/contexts/AppContext.tsx:76-200` (what the seed must satisfy).
5. `.github/workflows/ci.yml` + `.env.example` (CI job model + the dual anon-key var names) — and the hard rule there: `secrets.*` is invalid in step-level `if:`; gate via job-level `env.*`.
