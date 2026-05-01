# Project Sweep Findings — GitHub + Supabase

**Date:** 2026-05-01
**Scope:** Code-level dead ends, workflow integrity, security posture, privacy posture across the LeaseIO repo and the Supabase project (`wwkwoxxcprnjjufkbzac`).

---

## Executive summary

| Severity | Count | Disposition |
|---|---|---|
| HIGH | 2 | **Fixed in this round** |
| MEDIUM | 4 | 2 fixed, 2 deferred |
| LOW | 7 | All deferred |
| INFO | 4 | Documented only |

No production-exposure issues remain open. The repo and database are clean of stranded data, dead RLS policies, leaked secrets, and broken core workflows.

---

## HIGH severity

### H-01 — Missing locale keys in AcceptInvite (FIXED ✓)
**Evidence:** `src/pages/AcceptInvite.tsx` references seven `t('accept_invite.*')` keys that did not exist in `src/locales/en/common.json` or `es/common.json`: `expired`, `already_accepted`, `login_context`, `wrong_account_title`, `wrong_account_invite_for`, `wrong_account_signed_in_as`, `sign_out_and_switch`. Result: invited users would see raw key strings rendered in the UI on the wrong-account, expired-token, and already-accepted code paths.
**Fix shipped:** Added all 7 keys to both en and es locale files with proper i18next interpolation tokens (`{{email}}`, `{{workspaceName}}`, `{{role}}`).

### H-02 — Missing DELETE RLS policies on `lease_change_sets` and `lease_unlock_requests` (FIXED ✓)
**Evidence:** `pg_policies` query showed both tables had `SELECT/INSERT/UPDATE` policies but no `DELETE`. Same silent-failure class that bit `risks` and `lease_change_set_items` earlier — a future code path that issues a DELETE returns 0 rows affected with no error, looking like success to the client.
**Fix shipped:** Migration `sweep_h02_missing_delete_policies` added DELETE policies on both tables, scoped to lease ownership / workspace membership (mirrors the existing INSERT/UPDATE policy shape).

---

## MEDIUM severity

### M-01 — `process_lease` did not check AI consent before extraction (FIXED ✓)
**Evidence:** `profiles.ai_processing_consent_at` is captured at signup and revocable from Settings → Privacy. The `process_lease` edge function never read it, so a user who revoked consent post-signup could still trigger AI extraction.
**Fix shipped:** New `assertAiConsent(userId)` helper in `supabase/functions/process_lease/index.ts` reads `ai_processing_consent_at` and throws if null. Called at both AI invocation sites (initial extraction line 1554, executed re-extraction line 1306). Error message: *"AI processing consent has not been granted. Re-enable consent in Settings → Privacy before uploading documents."*

### M-04 — Missing indexes on hot FK join paths (FIXED ✓)
**Evidence:** `pg_constraint` query found six FK columns lacking indexes that participate in frequent reads (risk render joins, change-set queue, summary-view telemetry, invite listing, audit lookups).
**Fix shipped:** Migration `sweep_indexes_hot_join_paths` added indexes:
- `risks(risk_template_id)` — every Risks tab render joins to templates
- `lease_change_sets(unlock_request_id)` — change-set queue
- `summary_views(lease_id)` — telemetry will grow unbounded
- `invite_tokens(workspace_id)` — pending invites list
- `lease_governance_audit(actor_user_id)` and `(related_unlock_request_id)` — audit lookups

### M-02 — `notifications` table missing DELETE policy (DEFERRED)
**Evidence:** RLS policies cover `SELECT/INSERT/UPDATE` only. Users cannot dismiss notifications.
**Recommendation:** Add a DELETE policy scoped to `user_id = auth.uid()`. Defer to whenever a "dismiss notification" UX is wired (no current call site).

### M-03 — `lease_approvers` missing UPDATE policy (DEFERRED)
**Evidence:** Has `SELECT/INSERT/DELETE` only. If a future feature upserts approvers, the UPDATE leg silent-fails.
**Recommendation:** Add UPDATE policy now as a guard rail, or commit to insert-then-delete contract via comment.

---

## LOW severity (deferred)

| ID | Location | Issue | Recommendation |
|---|---|---|---|
| L-01 | `lease_activity_log` CHECK | 18 of 24 `activity_type` enum values have zero rows. `change_submitted` vs `change_set_submitted` are duplicate naming. | Pick one naming convention. Drop unused values in a follow-up if they remain unused after another quarter. |
| L-02 | `lease_governance_audit` CHECK | 9 of 12 `event_type` values unused. Headroom OK, but `change_set_created` count exceeds total `lease_change_sets` rows — check writer for double-emit. |
| L-03 | `src/pages/Signup.tsx:38` and `src/pages/app/Onboarding.tsx:20` | Plan defaults inconsistent: Signup defaults to `'starter'`, Onboarding to `'free'`. | Standardize to one constant. |
| L-04 | `workspaces.document_limit` column | Misleading name — stores `maxActiveLeases`, not file count. | Rename to `max_active_leases` in a future migration. |
| L-05 | 8 user-FK columns on `leases` lacking indexes | `archived_by`, `model_locked_by`, `unlock_requested_by`, etc. | Acceptable while leases <10k rows. Revisit at scale. |
| L-06 | `alert_rules` and `workspace_approvers` redundant policies | Both have `ALL` policy + redundant `SELECT` | Drop redundant SELECT. |
| L-07 | `risk_templates` workspace-scoped count = 0 | UI was added in earlier round but no users have promoted templates yet. | Monitor over 30 days. If still zero, validate the "Watch for this" checkbox is reachable. |

---

## INFO (documented)

| ID | Topic | Note |
|---|---|---|
| I-01 | Storage policy false positive | Subagent flagged null `polqual` on `leases` and `executed-leases` INSERT policies as "missing scoping." `polqual` (USING) is correctly null for INSERT — the relevant check is `polwithcheck` (WITH CHECK), which is properly set on both buckets to `(storage.foldername(name))[1] = (auth.uid())::text` plus workspace membership. **Storage is secure.** Verified via `pg_policy` SELECT. |
| I-02 | `get-summary-by-token` CORS | Hardcoded `Access-Control-Allow-Origin: '*'` is INTENTIONAL and CORRECT for this endpoint — it's a public, token-protected summary share for arbitrary external recipients. Replacing with the shared `getCorsHeaders` helper would BREAK the feature by restricting to a workspace allowlist. Authentication is enforced via the unguessable token + 30-day expiry + revocability. Added a clarifying comment to prevent future "fix" attempts. |
| I-03 | Orphaned edge functions | `handle-unlock-action` and `check-subscription` are deployed but have zero frontend call sites. May be staged feature work or pre-Stripe-refactor cruft. Recommendation: defer deletion until next quarterly cleanup; they're idle, not harmful. |
| I-04 | All 22 deployed edge functions validated | Auth posture: every function either validates the bearer JWT via `supabaseAdmin.auth.getUser(token)` or uses an explicit token-based public path (summary tokens, invite tokens, Stripe webhook signature). No privilege escalation paths. No service-role JWTs leaked into the frontend bundle. CORS centralized in `_shared/cors.ts` except for the one intentional public endpoint. |

---

## Pre-launch privacy checklist (status from prior memory)

| Item | Status |
|---|---|
| AcceptInvite redirect query-param preservation | ✓ Fixed (uses `encodeURIComponent`) |
| Account-deletion PII purge | ✓ Verified — cascades to leases, storage, profiles, workspace_members, draft change_sets, anonymizes audit actor fields |
| Share-token expiry + revocation | ✓ Verified — 30-day TTL, revocable by setting `summary_share_token=NULL` |
| AI consent gate at extraction | ✓ Fixed in this round (M-01) |
| Privacy Policy `/privacy` route | Still missing — **action item for launch** |
| Sub-processor disclosures | Not in repo — **action item for launch** |
| Data retention policy | Not in repo — **action item for launch** |
| SAR (subject access request) contact | Not surfaced in UI — **action item for launch** |

---

## Methodology notes

Audit was performed by three parallel Explore subagents against:
- The repo's source tree (frontend + edge functions)
- The Supabase project's `pg_policies`, `pg_tables`, `pg_constraint`, `information_schema.columns`, `pg_policy` (storage)
- Edge function deployment metadata

No DDL was issued in the audit phase — only SELECTs. Fixes were applied via targeted migrations and code changes, each validated with a follow-up SELECT confirming the change landed.

## Repository state after sweep

- All HIGH severity items closed.
- Two MEDIUM items closed (M-01 AI consent, M-04 indexes).
- All other items documented above with severity + recommendation; user can prioritize the remaining work into a future round.
- `vitest` 66/66 passing.
- `npm run build` clean.
- `process_lease` edge function redeployed with the consent gate.
