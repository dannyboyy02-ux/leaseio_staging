# Migration Drift Remediation

**Original filing:** 2026-05-07 (audit pass).
**Last refreshed:** 2026-05-15 (audit P1-10 session — partial progress recorded; full remediation still owed).
**Severity:** P1 for production readiness. Not user-blocking right now; blocks DR drills, fresh-environment spin-up, and SOC schema-as-code claims.

---

## Why this matters

The repo's `supabase/migrations/` directory and the live Supabase
project's applied migration history are **out of sync in both
directions**. Per the project's standing **Schema Change Rule**
(`CLAUDE.md`), every schema change must be committed as a
`.sql` migration file. That rule has been violated multiple times,
and is structurally violated by MCP `apply_migration` itself (see
below).

**Concrete consequences:**

- A clean rebuild from `supabase/migrations/` will **not** reproduce
  the live schema. Tables, indexes, policies, and functions added
  via Studio / MCP without a matching committed file are missing.
- New Supabase environments (staging, branches, disaster-recovery
  restore) will fail to come up correctly.
- Any "schema as code" claim for SOC / customer audits is currently
  false.
- The risk grows: each new feature that depends on a drifted object
  will have an ambiguous source-of-truth.

---

## Root cause of the drift (added 2026-05-15)

The 2026-05-07 doc treated drift as a historical-only issue. It is not.
**Every call to `mcp__supabase__apply_migration` creates a new entry in
the live `supabase_migrations.schema_migrations` table using the
server's CURRENT timestamp as `version`, regardless of the timestamp
embedded in the local filename.** Example confirmed via execute_sql
on 2026-05-15:

| Local file | Live `version` | Live `name` |
|---|---|---|
| `20260515020000_security_invoker_audit_views.sql` | `20260515224221` | `security_invoker_audit_views` |
| `20260515010000_lease_workflow_field_guard.sql`   | `20260515223204` | `lease_workflow_field_guard` |
| `20260515000000_workspace_intended_plan.sql`      | `20260515205548` | `workspace_intended_plan` |

The local files' timestamps are the AUTHORING time (chosen by the
human for ordering). The live versions are the APPLICATION time
(stamped by the Management API at the moment the SQL ran).

This means `supabase migration list --linked` sees the same logical
migration as both "local-only" (under filename timestamp) AND
"remote-only" (under server timestamp). The 73/72/13 split as of
2026-05-15 is mostly this artifact — the underlying schema is
correct on live; the tracking table just doesn't know that.

`supabase db push` does not have this problem (it pushes the file's
version verbatim), but it requires Docker locally. MCP
`apply_migration` is the wrong tool for the job — convenient, but
poisons the migration history with every call.

---

## Current state of drift (counted 2026-05-15)

```
$ npx supabase migration list --linked | awk ...
Remote-only: 73
Local-only:  72
In-sync:     13
```

The 73 remote-only rows are roughly:
- **~50 phantom rows** from MCP `apply_migration` calls — same NAME as
  a local file but different `version`. The schema effect is in the
  live DB; the tracking is just misaligned.
- **~23 genuine drift** from Studio / MCP edits that were never
  committed as files (per the 2026-05-07 audit).

The 72 local-only files are roughly:
- **~50 files** that ARE applied on live (same name) but tracked
  under a different version key — see Root cause above.
- **~22 historical files** that were superseded by later
  reorganized migrations (UUID-named Lovable Studio artifacts,
  `phase1_*` files renamed when the phase-spec naming convention
  started).

The 2026-05-07 doc listed specific filenames as "stale local-only."
That list is no longer accurate: spot-checking against live shows
several of those names (e.g. `audit_remediation`,
`notify_abstraction_complete`, `governance_rls_tighten`) ARE applied
on live. They're not stale — they're phantom-tracked. Archiving them
based on filename alone would risk deleting active migrations.

---

## Remediation path (requires Supabase CLI + Docker — owner runs locally)

This step requires the `supabase` CLI plus **Docker Desktop** running
locally. `db pull` and `db dump` both spin up a Docker container
internally to run pg_dump against the live project. It cannot be
done via the MCP tools.

### Step 0 — Install Docker Desktop

Required by `supabase db pull` / `db dump`. Sessions in 2026-05-15
without Docker confirmed neither command can run; the CLI fails with
"docker client must be run with elevated privileges to connect" or
"open //./pipe/docker_engine: The system cannot find the file specified."

### Step 1 — Snapshot before touching anything

```bash
# From the repo root
supabase db dump --schema public -f _backup_schema_$(date +%Y_%m_%d).sql
```

Keep this file. It's your safety net if anything goes sideways.

### Step 2 — Generate the canonical baseline

```bash
# This is the operative step. It writes a single migration that, when
# replayed against an empty database, produces the current live schema.
supabase db pull --schema public
```

The file lands as `supabase/migrations/<timestamp>_remote_schema.sql`.
Inspect it line by line before committing. It should describe:
- `CREATE TABLE public.profiles`
- `CREATE TABLE public.leases`
- Every other base table that existing local migrations only ALTER
- Every RLS policy currently in production
- Every function, view, trigger, sequence, type, extension grant
- Storage buckets + policies

### Step 3 — Decide what to do with the existing local files

You have two clean options:

**Option A — Squash to the baseline.**
Move every existing file in `supabase/migrations/` (except the new
remote_schema.sql) to `supabase/migrations/_archived_pre_baseline/`.
`supabase db reset` then runs only the baseline + future migrations.
Loses migration granularity but gives a clean replayable chain.

**Option B — Keep history, layer the baseline first.**
Rename the baseline to a very early timestamp (e.g.
`19700101000000_baseline.sql`), then teach `db reset` to run it first
followed by the existing migrations. Existing migrations need to be
idempotent (most are, since they use `IF NOT EXISTS` / `CREATE OR
REPLACE`). Risk: some early migrations contain `CREATE TABLE` without
`IF NOT EXISTS` and would fail on a baseline'd DB. Verify by attempting
a clean reset.

Recommendation: **Option A**. Future migrations build on the baseline,
and the audit-driven migrations from 2026-05-15 (P1-09 views,
P1-11 trigger, P1-06 storage policies, etc.) are already
self-contained and would re-apply cleanly after the baseline.

### Step 4 — Re-align the live `schema_migrations` table

After Step 2, the live tracking table still has phantom-versioned
rows from prior MCP `apply_migration` calls. Either:
- Leave them alone (cosmetic only — `db reset` produces the right
  schema regardless), or
- Truncate `supabase_migrations.schema_migrations` and re-stamp it
  with the post-baseline timeline. This requires elevated
  privileges and a clear rollback plan.

### Step 5 — Verify a clean rebuild

```bash
# In a fresh Supabase project (or local Docker target)
supabase db reset
# Then run a smoke check that the app boots and a lease can be uploaded.
```

### Step 6 — Stop poisoning the history going forward

Re-affirm the Schema Change Rule in `CLAUDE.md`:

> **Every schema change MUST be authored as a `.sql` migration file
> committed under `supabase/migrations/` AND applied via
> `supabase db push` (CLI), not via `mcp__supabase__apply_migration`.**

The MCP tool is convenient but stamps the wrong version onto the
tracking table. If `db push` isn't possible (no Docker), then:
1. Author the file.
2. Commit it.
3. Apply via MCP `apply_migration`, knowing this creates drift.
4. File a follow-up to repair the drift on the next operator session.

---

## What's been done since the original filing

Between 2026-05-07 and 2026-05-15, every schema change in this
repo has been authored as a `.sql` file FIRST, committed, then
applied. Specifically the audit-driven migrations:

| Migration | Audit ID |
|---|---|
| `20260515000000_workspace_intended_plan.sql` | P0-01 |
| `20260515010000_lease_workflow_field_guard.sql` | P1-11 |
| `20260515020000_security_invoker_audit_views.sql` | P1-09 |
| `20260515030000_lease_reports_storage_finalization_guard.sql` | P1-06 |

All four are in `supabase/migrations/` AND applied to live, just
with the version-mismatch caveat from the Root cause section above.
After the operator runs Step 2, these will all show as in-sync
(or be absorbed into the baseline).

---

## Risk if not remediated

| Scenario | Impact |
|---|---|
| Spinning up a staging environment | Will not have the missing 19+ schema objects. Many features will silently break. |
| Disaster recovery (Supabase outage / data center loss) | Schema cannot be rebuilt from repo alone. Customer-data restore from backup works, but schema reconstruction relies on the surviving live state. |
| Supabase branching for PRs (Pro plan) | Fresh branch will not match prod, so PR previews break. |
| Phase 9 (firm layer) opens | Adding the firm-tier schema starts from ambiguous state. Future migrations may collide. |
| Customer / SOC audit | "We use schema-as-code" is currently inaccurate. |

**Time to remediate:** 1–2 hours for an owner with the Supabase CLI
and Docker Desktop. The longest part is reviewing the `db pull`
output line by line before committing.

---

## What this doc replaces

This file supersedes any verbal claim that the repo migrations folder
is the schema's source of truth. Until Step 6 is signed off, treat
the live database as authoritative for schema-state questions.

The session-context memory at
`memory/session_context.md` references this remediation; both should
be updated together when the operator completes Step 2.
