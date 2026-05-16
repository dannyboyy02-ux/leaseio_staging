# LeaseIO

AI-powered lease intake, abstraction, and audit-defensible repository for mid-market finance teams.

LeaseIO is the **awareness and intake layer** for leases — it ensures finance teams know about every lease before or as it's signed, maintains a workspace-scoped repository, and uses Claude to abstract key terms from lease documents. It works alongside ASC 842 accounting tools (it is **not** one).

Positioning: AI-as-a-Service. The AI is the service; the software is the delivery mechanism.

## Tech stack

- **Frontend:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui
- **Backend:** Supabase (Postgres, Auth, Storage, Edge Functions, pg_cron)
- **AI:** Anthropic Claude — Opus for extraction, Sonnet for assistant + insights, Haiku for classification + page-mapping
- **Billing:** Stripe (Starter $249/mo, Business $499/mo, 7-day free trial, monthly + annual)
- **Deployment:** Vercel (frontend, CI/CD from GitHub) + Supabase (edge functions)
- **i18n:** i18next with English + Spanish locales

## Repository layout

| Path | What lives here |
|---|---|
| `src/` | React app (pages, components, hooks, contexts, lib helpers, locale files) |
| `supabase/functions/` | Deno edge functions — AI pipeline, approval workflow, reports, intake, billing |
| `supabase/migrations/` | Schema as code. Every schema change is a numbered `.sql` file. |
| `supabase/config.toml` | Per-function `verify_jwt` setting. Every function dir must have a matching stanza (CI-enforced). |
| `scripts/` | Build-time checks (typecheck-names, mirror-parity, edge-function config completeness, security smoke) |
| `docs/` | Product strategy, phase build specs, audit findings, known issues, operator playbook |

Read `CLAUDE.md` at the repo root first when working on this codebase — it's the strategic context, file map, and standing rules.

## Local development

Requires Node.js 20+. Supabase CLI optional but recommended for deploying edge functions.

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.example .env

# 3. Fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
#    (see .env.example for every required variable and where to find it)

# 4. Start the dev server
npm run dev
```

The dev server runs at <http://localhost:5173>. Edge functions run against the linked Supabase project — local Docker is not required for normal development.

## Quality gates

| Command | What it checks |
|---|---|
| `npm run typecheck`              | `tsc --noEmit` against `tsconfig.app.json` |
| `npm run typecheck:names`        | Undefined-identifier scan (catches typo'd context properties) |
| `npm run check:supabase-types`   | Generated Supabase types file is valid TypeScript |
| `npm run check:mirror-parity`    | Node/Deno mirror pairs (`lifecycleStates`, `approvalChainLogic`, etc.) stay byte-equivalent in behavior |
| `npm run check:edge-function-config` | Every `supabase/functions/<name>/index.ts` has a matching stanza in `supabase/config.toml` |
| `npm test`                       | Vitest unit suite (375+ tests) |
| `npm run build`                  | Production Vite build. Runs the full prebuild chain first. |
| `npm run smoke:security`         | Live Supabase smoke test of audit-RLS posture (requires env vars). Fail-closed on main pushes in CI. |

CI runs the whole chain on every PR and on every push to `main`.

## Schema source of truth

Every schema change is authored as a numbered `.sql` file under `supabase/migrations/` BEFORE being applied. The Schema Change Rule (`CLAUDE.md`) is enforced socially; `supabase/migrations/` is the canonical source of truth. See `docs/MIGRATION_DRIFT_REMEDIATION.md` for the current state of repo-vs-live alignment.

## Deployment

- **Frontend:** auto-deployed from `main` via Vercel (`vercel.json` ships CSP, HSTS preload, Permissions-Policy headers).
- **Edge functions:** `supabase functions deploy <name> --project-ref <ref>` for individual functions. The deployed source must match the file in the repo (`supabase/functions/<name>/index.ts`).
- **Migrations:** apply via `supabase db push` (preferred) or `mcp__supabase__apply_migration` (operator tooling).

## Documentation

- `CLAUDE.md` — repo-level context, file-to-feature map, strategic rules, active workstreams. Read first.
- `docs/PRODUCT_STRATEGY.md` — the ratified product strategy (tiers, positioning, sequencing).
- `docs/PHASE_<N>_BUILD_SPEC.md` — per-phase build specs (Phases 1–8 closed; 9–10 dormant).
- `docs/OPERATIONAL_MONITORING_SPEC.md` — vendor health + quota tracking module.
- `docs/EMAIL_INTAKE_PLAN.md` + `docs/EMAIL_INTAKE_DECISIONS.md` — Path 2 inbox spec.
- `docs/MARKET_DATA_IBR_MODULE.md` — Treasury / SOFR / CPI ingestion + IBR documentation packet module.
- `docs/KNOWN_ISSUES.md` — active bug tracker.
- `docs/LEASEIO_AI_BUILD_AUDIT_FINDINGS_2026-05-13.md` — most recent professional-grade audit; remediation status tracked in commit history.
- `docs/ops/OPERATOR_PLAYBOOK.md` — non-code dashboard steps for the human operator.

## License

Proprietary. Not open source.
