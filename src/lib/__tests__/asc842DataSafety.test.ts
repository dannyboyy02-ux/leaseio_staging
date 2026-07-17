import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Polish walkthrough 2026-07-17 (commit 9bce71a, cluster 1) — ASC 842 data
// safety. Three regressions this pins:
//   (a) Switching tabs unmounted the ASC 842 form and silently dropped every
//       unsaved input — both workbenches must forceMount the TabsContent and
//       hide it with CSS instead of unmounting it.
//   (b) A failed load rendered the EDITABLE form over EMPTY state; pressing
//       Save then upserted NULLs over previously captured data. The loadError
//       state must early-return a retry card BEFORE the editable form.
//   (c) Save was always enabled — a no-op save still wrote an activity-log row
//       and refreshed last_updated_by, corrupting attribution. Save must be
//       disabled unless dirty, and the dirty comparison must exclude exactly
//       the three meta keys (or has_row/last_updated_* churn makes every
//       loaded row permanently "dirty" / never "dirty").

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const FORCE_MOUNTED_ASC842 =
  /<TabsContent\s+value="asc842"\s+forceMount\s+className="[^"]*data-\[state=inactive\]:hidden[^"]*"/;

describe('cluster 1 — unsaved ASC 842 inputs survive tab switches', () => {
  for (const p of [
    'src/pages/app/LeaseReview.tsx',
    'src/components/leases/locked/LockedLeaseDetail.tsx',
  ]) {
    it(`${p} force-mounts the asc842 TabsContent and hides it via CSS`, () => {
      expect(read(p)).toMatch(FORCE_MOUNTED_ASC842);
    });
  }
});

describe('cluster 1 — failed load never renders the editable form', () => {
  const tab = read('src/components/leases/Asc842InputsTab.tsx');

  it('has a loadError state fed by the load effect', () => {
    expect(tab).toMatch(/const \[loadError, setLoadError\] = useState<string \| null>\(null\)/);
    expect(tab).toContain('setLoadError(error.message)');
  });

  it('the retry render early-returns BEFORE the editable form (file order)', () => {
    const retryAt = tab.indexOf('if (loadError)');
    const formAt = tab.indexOf("leases.asc842.summary_classification");
    expect(retryAt).toBeGreaterThan(-1);
    expect(formAt).toBeGreaterThan(-1);
    expect(retryAt).toBeLessThan(formAt);
    // The error state offers a real retry, not a dead end.
    const errorBlock = tab.slice(retryAt, formAt);
    expect(errorBlock).toContain("t('leases.asc842.load_error')");
    expect(errorBlock).toContain("t('common.retry')");
    expect(errorBlock).toContain('setReloadNonce');
  });
});

describe('cluster 1 — dirty-aware save', () => {
  const tab = read('src/components/leases/Asc842InputsTab.tsx');

  it('Save is disabled unless something actually changed', () => {
    expect(tab).toContain('disabled={saving || !dirty}');
  });

  it('dirty compares field snapshots (fieldsOf), not raw state identity', () => {
    expect(tab).toContain('const dirty = fieldsOf(state) !== savedSnapshot;');
  });

  it('fieldsOf excludes exactly the three META_KEYS', () => {
    // Pin the exact declaration: adding a field here silently exempts it from
    // dirty tracking; removing one makes every loaded row permanently dirty.
    expect(tab).toContain(
      "const META_KEYS: Array<keyof State> = ['has_row', 'last_updated_at', 'last_updated_by_label'];",
    );
    expect(tab).toMatch(/fieldsOf[\s\S]{0,120}filter\(\(\[k\]\) => !META_KEYS\.includes\(k as keyof State\)\)/);
  });
});
