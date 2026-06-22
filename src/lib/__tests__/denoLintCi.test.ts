import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Edge-function CI lint gate. `deno check` (full type-check) is blocked by an
// esm.sh type-resolution 404 on supabase-js (needs an import-map refactor), so
// CI runs `deno lint` on the edge files a PR changes, with no-explicit-any
// excluded (the deliberate Supabase-row casting pattern).

const root = process.cwd();
const fn = (p: string) => readFileSync(join(root, p), 'utf8');

describe('deno lint config (supabase/functions/deno.lint.json)', () => {
  const raw = fn('supabase/functions/deno.lint.json');
  const cfg = JSON.parse(raw);
  it('is a non-deno.json filename (so Supabase deploy does not auto-pick it as config)', () => {
    // The file is deno.lint.json, not deno.json / deno.jsonc / import_map.json.
    expect(() => fn('supabase/functions/deno.json')).toThrow();
  });
  it('excludes only no-explicit-any (keeps unused-vars, require-await, etc. enforced)', () => {
    expect(cfg.lint.rules.exclude).toContain('no-explicit-any');
    expect(cfg.lint.rules.exclude).not.toContain('no-unused-vars');
  });
});

describe('CI deno-lint job (.github/workflows/ci.yml)', () => {
  const ci = fn('.github/workflows/ci.yml');
  it('defines a PR-only deno-lint job using setup-deno', () => {
    expect(ci).toContain('deno-lint:');
    expect(ci).toMatch(/if:\s*github\.event_name == 'pull_request'/);
    expect(ci).toContain('denoland/setup-deno@v2');
    expect(ci).toContain('fetch-depth: 0');
  });
  it('lints ONLY changed edge .ts files, with the lint config', () => {
    expect(ci).toContain('git diff --name-only --diff-filter=ACMR "${PR_BASE_SHA}...HEAD" -- supabase/functions');
    expect(ci).toContain("grep -E '\\.ts$'");
    expect(ci).toContain('deno lint --config supabase/functions/deno.lint.json $CHANGED');
    // No-changes path must exit 0 (don't fail a PR that touches no edge fns).
    expect(ci).toContain('nothing to lint');
  });
  it('does not reference secrets in an if: (the documented parse-time footgun)', () => {
    expect(ci).not.toMatch(/^\s*if:.*secrets\./m);
  });
});
