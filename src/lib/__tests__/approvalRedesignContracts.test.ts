import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Approval Rules redesign — contract pins the existing suites leave open.
//
// The redesign already has deep static coverage (approvalPhase0EngineTruth,
// approvalPolicyOrder, resolverDefaultFallback, signatorInheritance,
// inFlightRoutingDisclosure). These four contracts are the ones that are only
// stated in PROSE today, i.e. a future edit can break them silently:
//
//   1. The hand-reproduced version trigger is exactly baseline MINUS `priority`.
//      The shipped test hardcodes the eight surviving columns, so a migration
//      that dropped a column from the baseline set AND from the hardcoded list
//      would pass. Derive the expected set from baseline_schema.sql instead.
//
//   2. The legacy default-approver surfaces must NEVER call describeChain.
//      approvalDescribe's own doc comment says so ("DO NOT USE FOR THE LEGACY
//      DEFAULT PATH") because describeChain materializes an inherited signature
//      stage and would print "…and signs it too" for a path that never signs.
//      Nothing enforces it.
//
//   3. findShadowedRules documents "INPUT ORDER IS LOAD-BEARING: rules must
//      already be in the engine's exact evaluation order". If the list page ever
//      stops piping engineOrder() into it (or into the reorder hook), every
//      shadow warning and every ordinal silently becomes wrong while the unit
//      tests stay green.
//
//   4. Every i18n key on the redesign's surfaces resolves in BOTH locales unless
//      the call site ships an explicit defaultValue. A missing key renders the
//      raw dotted key to the user — the exact opposite of a surface whose thesis
//      is human-readable prose.

const repoRoot = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

// ─────────────────────────────────────────────────────────────────────────
// 1. approval_policies_version_increment == baseline MINUS priority
// ─────────────────────────────────────────────────────────────────────────

/** Column names on either side of an `IS DISTINCT FROM`, quoted or not. */
function distinctColumns(when: string): string[] {
  const out = new Set<string>();
  const re = /"?(?:old|OLD)"?\."?([a-z_]+)"?\s+IS DISTINCT FROM\s+"?(?:new|NEW)"?\."?([a-z_]+)"?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(when))) {
    expect(m[1], 'OLD/NEW compare different columns').toBe(m[2]);
    out.add(m[1]);
  }
  return [...out].sort();
}

describe('#redesign — the version trigger is baseline minus exactly one column', () => {
  const baseline = read('supabase/migrations/20260516120000_baseline_schema.sql');
  const baselineStmt = (() => {
    const i = baseline.indexOf('CREATE OR REPLACE TRIGGER "approval_policies_version_increment"');
    expect(i, 'baseline defines the version trigger').toBeGreaterThan(-1);
    return baseline.slice(i, baseline.indexOf('EXECUTE FUNCTION', i));
  })();

  const migrationsDir = join(repoRoot, 'supabase', 'migrations');
  const file = readdirSync(migrationsDir)
    .filter((f) => f.includes('approval_policies_version_ignores_priority'))
    .sort()
    .pop()!;
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const newStmt = sql.slice(
    sql.indexOf('CREATE OR REPLACE TRIGGER approval_policies_version_increment'),
    sql.indexOf('EXECUTE FUNCTION'),
  );

  it('baseline watched priority (so removing it is a real change, not a no-op)', () => {
    expect(distinctColumns(baselineStmt)).toContain('priority');
  });

  it('the new WHEN clause is the baseline set with ONLY priority removed', () => {
    const expected = distinctColumns(baselineStmt).filter((c) => c !== 'priority');
    expect(distinctColumns(newStmt)).toEqual(expected);
  });

  it('no column was silently ADDED to the trigger either', () => {
    const baselineSet = new Set(distinctColumns(baselineStmt));
    for (const col of distinctColumns(newStmt)) {
      expect(baselineSet.has(col), `${col} is not in the baseline WHEN clause`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. The legacy default-approver path never goes through describeChain
// ─────────────────────────────────────────────────────────────────────────

/** The identifier list of an `import { … } from '@/lib/approvalDescribe'`. */
function approvalDescribeImports(src: string): string[] {
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@\/lib\/approvalDescribe'/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/^\s*type\s+/, '').trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('#redesign — the legacy default route composes its own copy', () => {
  const LEGACY_SURFACES = [
    'src/components/settings/ApprovalEverythingElseRow.tsx',
    'src/components/settings/ApprovalDefaultAnswer.tsx',
  ];

  it.each(LEGACY_SURFACES)('%s never imports describeChain', (path) => {
    const src = read(path);
    const imported = approvalDescribeImports(src);
    expect(imported.length, `${path} should import from approvalDescribe`).toBeGreaterThan(0);
    expect(imported).not.toContain('describeChain');
  });

  it.each(LEGACY_SURFACES)('%s names its humans via describeApprover', (path) => {
    expect(approvalDescribeImports(read(path))).toContain('describeApprover');
  });

  it.each(LEGACY_SURFACES)('%s never calls describeChain(', (path) => {
    // Comments legitimately mention the name; an actual CALL is the violation.
    expect(read(path)).not.toMatch(/\bdescribeChain\s*\(/);
  });

  it('the chain renderer, by contrast, DOES use describeChain (the pin is scoped)', () => {
    expect(approvalDescribeImports(read('src/components/settings/ApprovalRuleRow.tsx'))).toContain(
      'describeChain',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. The list page hands findShadowedRules + the reorder hook engine order
// ─────────────────────────────────────────────────────────────────────────

describe('#redesign — engine order is what the overlap maths and the reorder see', () => {
  const page = read('src/pages/settings/ApprovalPoliciesListPage.tsx');

  it('sorts the fetched rules with engineOrder() before anything else reads them', () => {
    expect(page).toContain("import { engineOrder } from '@/lib/approvalPolicyOrder'");
    expect(page).toMatch(/const policies = useMemo\(\s*\(\)\s*=>\s*engineOrder\(/);
  });

  it('feeds findShadowedRules the engine-ordered list, not the raw query data', () => {
    expect(page).toContain('findShadowedRules(policies)');
    expect(page).not.toMatch(/findShadowedRules\(\s*policiesQuery/);
  });

  it('derives the reorder payload from the same ordered list', () => {
    expect(page).toMatch(/const policyIds = useMemo\(\s*\(\)\s*=>\s*policies\.map\(/);
    expect(page).toContain('orderedIds: policyIds');
  });

  it('never writes approval_policies.priority directly — the RPC is the one path', () => {
    // A second writer is exactly how two admins interleave into an order
    // neither chose; the RPC exists to be the only one.
    expect(page).not.toMatch(/update\(\s*\{[^}]*priority/s);
    expect(read('src/hooks/useApprovalRuleOrder.ts')).toContain("'set_approval_policy_order'");
  });

  it('the editor form no longer carries a priority field', () => {
    const editor = read('src/pages/settings/ApprovalPolicyEditPage.tsx');
    expect(editor).not.toMatch(/\bpriority:\s*(?:Number|parseInt|form\.priority)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Every referenced i18n key resolves in BOTH locales
// ─────────────────────────────────────────────────────────────────────────

const REDESIGN_SURFACES = [
  'src/components/settings/ApprovalAnswerInputs.tsx',
  'src/components/settings/ApprovalAnswerPanel.tsx',
  'src/components/settings/ApprovalAnswerStrip.tsx',
  'src/components/settings/ApprovalDefaultAnswer.tsx',
  'src/components/settings/ApprovalEverythingElseRow.tsx',
  'src/components/settings/ApprovalRuleDeleteDialog.tsx',
  'src/components/settings/ApprovalRuleRow.tsx',
  'src/components/settings/ApprovalRuleRowMenu.tsx',
  'src/components/settings/ApprovalRuleWarnings.tsx',
  'src/components/settings/approvalMatchSentence.ts',
  'src/hooks/useApprovalRuleOrder.ts',
  'src/lib/approvalDescribe.ts',
  'src/pages/settings/ApprovalPoliciesListPage.tsx',
  'src/pages/settings/ChainDiagram.tsx',
  'src/pages/settings/MatchCriteriaSentence.tsx',
];

interface KeyUse {
  file: string;
  key: string;
  hasDefault: boolean;
}

function collectKeys(): KeyUse[] {
  const uses: KeyUse[] = [];
  for (const file of REDESIGN_SURFACES) {
    if (!existsSync(join(repoRoot, file))) continue;
    const src = read(file);
    const re = /\bt\(\s*'([a-zA-Z0-9_.]+)'/g;
    const hits: Array<{ key: string; at: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) hits.push({ key: m[1], at: m.index });
    hits.forEach((hit, i) => {
      // Window = this call up to the next t( call (or +400 chars), so a
      // defaultValue belonging to a LATER call is never miscredited to this one.
      const end = Math.min(hits[i + 1]?.at ?? src.length, hit.at + 400);
      uses.push({
        file,
        key: hit.key,
        hasDefault: src.slice(hit.at, end).includes('defaultValue'),
      });
    });
  }
  return uses;
}

describe('#redesign — i18n keys resolve in en AND es', () => {
  const en = JSON.parse(read('src/locales/en/common.json'));
  const es = JSON.parse(read('src/locales/es/common.json'));
  const lookup = (bundle: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined,
      bundle,
    );

  const uses = collectKeys();

  it('found keys to check (the scanner itself must not silently no-op)', () => {
    expect(uses.length).toBeGreaterThan(40);
    expect(new Set(uses.map((u) => u.file)).size).toBeGreaterThan(8);
  });

  it('every key WITHOUT a defaultValue exists in English', () => {
    const missing = uses
      .filter((u) => !u.hasDefault && typeof lookup(en, u.key) !== 'string')
      .map((u) => `${u.file} → ${u.key}`);
    expect(missing, `missing en keys:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every key WITHOUT a defaultValue exists in Spanish (locales ship together)', () => {
    const missing = uses
      .filter((u) => !u.hasDefault && typeof lookup(es, u.key) !== 'string')
      .map((u) => `${u.file} → ${u.key}`);
    expect(missing, `missing es keys:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no key exists in one locale only (half-translated is worse than absent)', () => {
    const lopsided = uses
      .filter((u) => (typeof lookup(en, u.key) === 'string') !== (typeof lookup(es, u.key) === 'string'))
      .map((u) => `${u.file} → ${u.key}`);
    expect(lopsided, `lopsided keys:\n${lopsided.join('\n')}`).toEqual([]);
  });
});
