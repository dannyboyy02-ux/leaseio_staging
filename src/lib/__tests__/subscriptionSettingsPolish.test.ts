import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the 2026-06-11 Settings > Subscription polish pass:
//   - renewalDate (fabricated as now+30d) removed from Workspace/AppContext;
//     renewal copy now guarded on real Stripe subscription state.
//   - documentsUsed is a live trailing-30-day extraction count (the
//     workspaces.documents_used DB column is dead — KNOWN_ISSUES #31).
//   - Cancel/downgrade are confirmation-dialog-first; billing actions are
//     admin-gated; usage meter has a NaN guard.
//   - en/es locale parity for the new account.* keys; 7-day (not 14-day)
//     trial copy everywhere.
//
// Static-source idiom (see lockedLeaseLayout.test.ts): narrow the search
// window to the relevant block before asserting, so a match elsewhere in the
// file can't produce a false positive.

const root = process.cwd();
const readRepoFile = (path: string) => readFileSync(join(root, path), 'utf8');

const THIS_TEST = 'src/lib/__tests__/subscriptionSettingsPolish.test.ts';

/** Slice `source` from the first occurrence of `start` to the next occurrence of `end`. */
function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  expect(i, `expected source to contain "${start}"`).toBeGreaterThanOrEqual(0);
  const j = source.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return source.slice(i, j + end.length);
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) {
      walkSourceFiles(rel, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

type LocaleTree = { [key: string]: string | LocaleTree };

const en = JSON.parse(readRepoFile('src/locales/en/common.json')) as LocaleTree;
const es = JSON.parse(readRepoFile('src/locales/es/common.json')) as LocaleTree;

function flattenKeys(tree: LocaleTree, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) {
      for (const sub of flattenKeys(v as LocaleTree, path)) out.add(sub);
    } else {
      out.add(path);
    }
  }
  return out;
}

function flattenStrings(tree: LocaleTree, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) {
      out.push(...flattenStrings(v as LocaleTree, path));
    } else {
      out.push([path, String(v)]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Locale parity + key hygiene
// ---------------------------------------------------------------------------

describe('locale parity (en/es)', () => {
  it('en and es key sets are identical across the whole file', () => {
    const enKeys = flattenKeys(en);
    const esKeys = flattenKeys(es);
    const enOnly = [...enKeys].filter((k) => !esKeys.has(k));
    const esOnly = [...esKeys].filter((k) => !enKeys.has(k));
    expect(enOnly, 'keys present in en but missing from es').toEqual([]);
    expect(esOnly, 'keys present in es but missing from en').toEqual([]);
  });

  it('removed account.* keys are absent from BOTH locales', () => {
    for (const [name, tree] of [
      ['en', en],
      ['es', es],
    ] as const) {
      const account = tree.account as LocaleTree;
      expect(account, `${name} account section exists`).toBeTypeOf('object');
      expect(account, `${name} account.free_tier should be removed`).not.toHaveProperty('free_tier');
      expect(account, `${name} account.update_billing should be removed`).not.toHaveProperty(
        'update_billing',
      );
    }
  });

  it('every account.* key referenced in AccountSettings.tsx and AppSidebar.tsx exists in en', () => {
    const sources =
      readRepoFile('src/pages/settings/AccountSettings.tsx') +
      readRepoFile('src/components/layout/AppSidebar.tsx');
    const referenced = new Set<string>();
    for (const m of sources.matchAll(/t\('account\.([a-zA-Z0-9_]+)'/g)) {
      referenced.add(m[1]);
    }
    // Sanity: the new polish-pass keys are actually referenced.
    for (const expected of [
      'cancel_confirm',
      'cancel_confirm_desc_date',
      'downgrade_confirm_title',
      'downgrade_confirm_desc',
      'downgrade_confirm_cta',
      'upgrade_confirm_title',
      'view_usage_link',
      'billing_admin_only',
      'payment',
      'invoices',
      'adjust_plan',
      'auto_renews_on',
      'trial_pill',
            'checkout_success',
      'checkout_canceled',
    ]) {
      expect(referenced, `expected source to reference account.${expected}`).toContain(expected);
    }

    const account = en.account as LocaleTree;
    const missing = [...referenced].filter(
      (key) =>
        // Plural keys (used with { count }) resolve to key_one / key_other.
        !(key in account) && !(`${key}_one` in account && `${key}_other` in account),
    );
    expect(missing, 'account.* keys referenced in source but missing from en locale').toEqual([]);
  });

  it('no locale string claims a 14-day trial or "no credit card required"', () => {
    // The trial is 7-day. Guard against a "14-day trial" claim and the
    // "no credit card" claim — but scope the 14-day check to TRIAL context, so
    // legitimate unrelated copy (e.g. the lease 14-day delete-retention window)
    // doesn't false-positive. A bare "14 days" elsewhere is fine.
    // The lease_audit.* namespace is exempt from the no-card check: the Free
    // Lease Audit is a card-free lead magnet (5 docs free, no signup wall), so
    // its "no credit card required" copy is TRUE — this guard targets
    // subscription-trial surfaces, where the 7-day trial DOES take a card.
    const noCard = /no credit card|no requiere tarjeta/i;
    const fourteenDay = /14[-\s]?d[ií]a|14[-\s]?day/i;
    const trialContext = /trial|prueba/i;
    for (const [name, tree] of [
      ['en', en],
      ['es', es],
    ] as const) {
      const hits = flattenStrings(tree).filter(
        ([k, v]) =>
          (noCard.test(v) && !k.startsWith('lease_audit.')) ||
          (fourteenDay.test(v) && trialContext.test(v)),
      );
      expect(hits, `${name} locale contains stale trial copy`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Removed identifiers stay removed repo-wide
// ---------------------------------------------------------------------------

describe('removed subscription identifiers', () => {
  it('no src file references renewalDate, account.free_tier, or account.update_billing', () => {
    const offenders: string[] = [];
    for (const file of walkSourceFiles('src')) {
      if (file === THIS_TEST) continue;
      const source = readFileSync(join(root, file), 'utf8');
      for (const banned of ['renewalDate', 'account.free_tier', 'account.update_billing']) {
        if (source.includes(banned)) offenders.push(`${file}: ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. AppContext — live trailing-30-day abstraction count
// ---------------------------------------------------------------------------

describe('AppContext documentsUsed', () => {
  const source = readRepoFile('src/contexts/AppContext.tsx');

  it('counts trailing-30-day leases with a completed extraction, not the dead DB column', () => {
    // The monthly query mirrors process_lease's assertProcessingQuota window.
    const query = sliceBetween(source, 'const since30dIso', 'setUserRole');
    expect(query).toContain('30 * 24 * 60 * 60 * 1000');
    expect(query).toContain('.gte("uploaded_at", since30dIso)');
    expect(query).toContain('.not("extracted_json", "is", null)');

    // documentsUsed comes from that live count...
    expect(source).toContain('documentsUsed: monthlyRes.count || 0');
    // ...never from workspaces.documents_used (dead, always 0 — KNOWN_ISSUES #31).
    expect(source).not.toContain('documentsUsed: resolvedWorkspace.documents_used');
  });
});

// ---------------------------------------------------------------------------
// 4. AccountSettings — dialogs, guards, admin gating
// ---------------------------------------------------------------------------

describe('AccountSettings subscription tab', () => {
  const source = readRepoFile('src/pages/settings/AccountSettings.tsx');

  it('cancel button opens the confirmation dialog instead of calling the billing portal directly', () => {
    // Narrow to the cancel section (a borderless section since the 2026-06
    // Claude-alignment pass). Gated on subscription state (so paid Starter is
    // included — plan tier is not a proxy for "has a subscription") + admin.
    const cancelSection = sliceBetween(
      source,
      "['active', 'trialing', 'past_due'].includes(workspace.subscriptionStatus ?? '') &&",
      '</section>',
    );
    expect(cancelSection).toContain('onClick={() => setConfirmCancelOpen(true)}');
    // The destructive button must NOT jump straight to the Stripe portal.
    expect(cancelSection).not.toContain('handleManagePayment');
  });

  it('cancel confirmation dialog shows the period-end date when known and cancels IN-APP on confirm (no portal bounce)', () => {
    // 2026-07-11: the CTA used to bounce to the Stripe portal (double-cancel);
    // it now cancels in-app via handleSetCancellation(false) — the ONE
    // confirmation. preventDefault keeps the dialog open during the request.
    const dialog = sliceBetween(source, 'open={confirmCancelOpen}', '</AlertDialog>');
    expect(dialog).toContain("t('account.cancel_confirm')");
    expect(dialog).toContain("t('account.cancel_confirm_desc_date', { date: formattedPeriodEnd })");
    expect(dialog).toContain("t('account.cancel_confirm_desc')"); // fallback when no period end
    expect(dialog).toContain("t('account.keep_subscription')");
    expect(dialog).toContain('handleSetCancellation(false)');
    expect(dialog).not.toContain('handleManagePayment();'); // no portal round-trip anymore
  });

  it('downgrade routes through the adjust-plan picker to a confirmation dialog, then CHECKOUT (no portal)', () => {
    // The inline upgrade card + downgrade link were replaced by the "Adjust
    // plan" picker (2026-06 Claude-alignment pass). Selecting a downgrade
    // routes through handleAdjustPlanSelect → setConfirmDowngradePlan; an
    // upgrade goes through handleUpgrade. 2026-07-12: the confirm now routes
    // to CHECKOUT like an upgrade (the webhook cancels the displaced sub; the
    // portal is card-management-only, so the old portal handoff would
    // dead-end there with no plan controls).
    const router = sliceBetween(source, 'const handleAdjustPlanSelect', '};');
    expect(router).toContain('setConfirmDowngradePlan(planId)');
    expect(router).toContain('handleUpgrade(planId)');

    const dialog = sliceBetween(source, 'open={!!confirmDowngradePlan}', '</AlertDialog>');
    expect(dialog).toContain("t('account.downgrade_confirm_desc')");
    expect(dialog).toContain("t('account.downgrade_confirm_cta')");
    expect(dialog).toContain('proceedWithCheckout(planId)');
    expect(dialog).not.toContain('handleManagePayment');
  });

  it('renewal line renders for an active sub, but a SCHEDULED CANCEL wins over it', () => {
    // 2026-07-11: a scheduled cancel (billingSummary.subscription.cancelAtPeriodEnd)
    // must replace "Auto renews on {date}" with "Scheduled to cancel on {date}" —
    // otherwise the header lies (Stripe keeps status='active' after a cancel).
    const renewal = sliceBetween(
      source,
      "scheduledCancel && scheduledCancelDate ?",
      '</p>',
    );
    expect(renewal).toContain("t('account.scheduled_cancel_on', { date: scheduledCancelDate })");
    // The auto-renews line is the ELSE branch, and it is only ASSERTED when the
    // cancel flag is actually known (billingSummary.subscription present) — a
    // viewer who can't see the flag gets no line, never a possibly-false
    // "Auto-renews" (integrity review 2026-07-11).
    const renewElse = sliceBetween(
      source,
      'billingSummary?.subscription &&',
      '</p>',
    );
    expect(renewElse).toContain("workspace.subscriptionStatus === 'active'");
    expect(renewElse).toContain("t('account.auto_renews_on', { date: formattedPeriodEnd })");

    // formattedPeriodEnd is derived through the shared formatLongDate NaN guard
    // so "Invalid Date" can never render.
    const derivation = sliceBetween(source, 'const formatLongDate', 'return new Date(ms)');
    expect(derivation).toContain('Number.isFinite(ms)');
    expect(derivation).toContain('return null');
  });

  it('usage meter guards against division by zero and counts pack capacity (moved to UsageContent 2026-06-12)', () => {
    // The abstraction meter moved from the Billing tab to the Usage tab so
    // usage has exactly one home; the math contract moves with it.
    // Effective allowance = base documentLimit + active document-pack capacity;
    // the ratio guards on the effective limit so a 0 limit can't divide-by-zero.
    const usageSource = readRepoFile('src/pages/app/UsageContent.tsx');
    const derivation = sliceBetween(usageSource, 'const addonCapacity', 'const usageRatio');
    expect(derivation).toContain('workspace?.addonDocumentCapacity ?? 0');
    expect(derivation).toContain('(workspace?.documentLimit ?? 0) + addonCapacity');
    const ratio = sliceBetween(usageSource, 'const usageRatio', ';');
    expect(ratio).toContain('effectiveLimit > 0');
    expect(ratio).toContain(': 0');

    // And Billing must NOT regrow its own copy of the meter.
    expect(source).not.toContain('usageRatio');
    expect(source).toContain("handleTabChange('usage')");
  });

  it('billing portal actions are admin-gated with a visible non-admin explanation', () => {
    // Gated billing surfaces (trial/past-due/recovery banners + the Vault
    // section) each show the admin-only note to non-admins.
    const fallbacks = source.match(/t\('account\.billing_admin_only'\)/g) ?? [];
    expect(fallbacks.length).toBeGreaterThanOrEqual(3);

    // Plan changes are the admin-only "Adjust plan" button (opens the picker);
    // non-admins get the explanatory note instead of a hidden/disabled control.
    expect(source).toContain('onClick={() => setPlanPickerOpen(true)}');
    expect(source).toContain("t('account.plan_changes_admin_only')");
  });
});

// ---------------------------------------------------------------------------
// 5. AppSidebar — trial countdown pill
// ---------------------------------------------------------------------------

describe('AppSidebar trial countdown pill', () => {
  const source = readRepoFile('src/components/layout/AppSidebar.tsx');

  it('computes days left only while trialing, via the shared trialDaysRemaining helper', () => {
    const memo = sliceBetween(source, 'const trialDaysLeft = useMemo', ');');
    expect(memo).toContain("workspace?.subscriptionStatus === 'trialing'");
    expect(memo).toContain('trialDaysRemaining(workspace.subscriptionPeriodEnd)');
    expect(memo).toContain(': null');
    // The clamp/NaN logic lives in the shared helper, imported here.
    expect(source).toContain("import { trialDaysRemaining } from '@/lib/trialStatus'");
  });

  it('renders the pill only when a count exists and deep-links to the subscription tab', () => {
    const pill = sliceBetween(source, '{trialDaysLeft !== null && (', '</Link>');
    expect(pill).toContain('to="/app/settings/account?tab=billing"');
    // The pill text is computed once into trialPillText (shared by the expanded
    // pill and the collapsed-rail tooltip) rather than inline in the JSX.
    expect(pill).toContain('trialPillText');
    const text = sliceBetween(source, 'const trialPillText =', ';');
    expect(text).toContain("t('account.trial_pill', { count: trialDaysLeft ?? 0 })");
    // Day-of-charge collapses to a dedicated "ends today" string.
    expect(text).toContain("t('account.trial_pill_today')");
  });
});

// ---------------------------------------------------------------------------
// 6. Shared trial-days helper — single source of truth for both surfaces
// ---------------------------------------------------------------------------

describe('trialDaysRemaining helper', () => {
  it('clamps negatives to 0 and returns null for missing/invalid input', () => {
    const source = readRepoFile('src/lib/trialStatus.ts');
    expect(source).toContain('Math.max(0, Math.ceil((end - Date.now()) / 86_400_000))');
    expect(source).toContain('Number.isNaN(end)');
    expect(source).toContain('if (!periodEnd) return null');
  });
});
