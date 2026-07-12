# Canonical asset-type matcher — deploy note (2026-07-12)

Branch `claude/leaseio-end-to-end-review-163v6w`. Fixes the approval-rule
matcher silently failing to route leases whose `asset_type` spelling differs
from the rule's (`property` vs `real_estate` vs `"Real Estate"` are one class).

## What shipped where

| Piece | State |
|---|---|
| `src/lib/assetTypes.ts` — `canonicalAssetType` + `buildAssetTypeOptions` | committed |
| Rule builder / tester / rules-list UI (workspace-configured Asset Types + canonical labels) | committed |
| Migration `20260712140000_canonical_asset_type_matching.sql` (`public.canonical_asset_type` + `preview_policy_resolution` rewrite) | **APPLIED to staging** ✅ |
| Migration `20260712150000_revoke_canonical_asset_type_anon.sql` (convention-clean anon revoke) | **APPLIED to staging** ✅ |
| `supabase/functions/resolve-approval-chain/index.ts` — Deno `canonicalAssetType` in `matchPolicy()` | committed; **NOT yet deployed** ⏳ |

## The one remaining step — redeploy `resolve-approval-chain`

The **tester** (`preview_policy_resolution`, deployed via the migration) is now
canonical, but the **live matcher** (edge function `resolve-approval-chain`,
deployed **v37**) still does exact-match. Until the redeploy, the tester will
say a `property` rule matches a `real_estate` lease while a real submission
would not route it. No active asset-restricted policy exists on staging today,
so nothing is mis-routing in the interim, but close the gap on the next deploy.

**Verified safe (2026-07-12):** the deployed v37 bundle was extracted and
diffed against the repo. The ONLY difference is this canonical change (~20
lines in `index.ts`); the four bundled `_shared` modules are byte-identical,
CORS is unchanged, and the change references **no new DB object** (it is pure
in-Deno string logic). v37 already contains the #84/#111 Phase-7 columns +
`reroute_reconcile_chain_steps` + `forceConceptReactivation`, so this redeploy
does NOT re-flip any of those — it ships only vocabulary-tolerant asset matching.

Deploy from a machine with the Supabase CLI linked to project
`wwkwoxxcprnjjufkbzac`:

```
supabase functions deploy resolve-approval-chain
```

(No CI auto-deploy exists for edge functions; the MCP inline-deploy path is
impractical for the 84 KB bundle.) After deploying, confirm the deployed copy
matches the repo and spot-check a `real_estate`-valued lease against a
`property` rule.

## Verification already run on staging

`public.canonical_asset_type` + the rewritten `preview_policy_resolution` were
verified live: against a real `match_asset_types = ['property']` rule, all of
`property` / `real_estate` / `"Real Estate"` now canonicalize to `realestate`
and match, while `equipment` and a NULL asset type correctly do not. The RPC
keeps its `Forbidden` membership gate and is convention-clean
(`{authenticated, service_role}`, no anon).
