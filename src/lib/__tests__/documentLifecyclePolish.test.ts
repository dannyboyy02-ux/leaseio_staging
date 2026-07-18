import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the 2026-06-12 leases/settings polish pass
// (commits b554452, 8f32e82, 043c9ef) — converts the review-gated fixes
// into permanent contracts:
//
//   - Document delete ordering (governed UPDATE → error-checked audit row →
//     storage removal LAST, with pointer restore on audit failure).
//   - Amendment "delete" = archive semantics, audited on BOTH leases,
//     admin-gated, archived rows filtered from the list.
//   - ArchiveButton logs lease_archived/lease_restored with an error check
//     (restore nulls the only column-level attribution).
//   - Migration 20260612210000 carries all five new activity types;
//     AuditLog renders labels for the user-facing ones.
//   - login_events: SELECT-only grant + auth.uid()-scoped SELECT policy,
//     no client write path.
//   - record-login-event: platform-set (last) X-Forwarded-For entry only,
//     IP shape validation, shared jsonResponse (no local reimplementation).
//   - Leases "Show archived" includes NULL-lifecycle rows so archived
//     failed/processing amendments stay reachable.
//   - en/es locale parity for the new documents./amendments./archive.
//     namespaces + the new account./workspace. keys.
//   - LockedHeader archived banner/badge + overflow menu with controlled
//     ArchiveButton dialog.
//
// Static-source idiom (see subscriptionSettingsPolish.test.ts): narrow the
// search window to the relevant block before asserting, so a match elsewhere
// in the file can't produce a false positive.

const root = process.cwd();
const readRepoFile = (path: string) => readFileSync(join(root, path), 'utf8');

/** Slice `source` from the first occurrence of `start` to the next occurrence of `end`. */
function sliceBetween(source: string, start: string, end: string): string {
  const i = source.indexOf(start);
  expect(i, `expected source to contain "${start}"`).toBeGreaterThanOrEqual(0);
  const j = source.indexOf(end, i + start.length);
  expect(j, `expected "${end}" after "${start}"`).toBeGreaterThan(i);
  return source.slice(i, j + end.length);
}

// ---------------------------------------------------------------------------
// 1. LeaseDocumentsTab — delete-path integrity + summary lifecycle
// ---------------------------------------------------------------------------

describe('LeaseDocumentsTab delete-path integrity', () => {
  const source = readRepoFile('src/components/leases/LeaseDocumentsTab.tsx');
  // The whole confirmed-delete handler, start to its dependency array.
  const handler = sliceBetween(
    source,
    'const handleConfirmedDelete = useCallback',
    '[pendingDelete, user?.id, leaseId, onDocumentDeleted, t]',
  );

  it('runs the governed leases UPDATE BEFORE storage removal (lock trigger fail-fasts before destruction)', () => {
    const updateIdx = handler.indexOf(".from('leases')");
    const storageIdx = handler.indexOf('supabase.storage');
    expect(updateIdx, 'leases UPDATE present in handler').toBeGreaterThanOrEqual(0);
    expect(storageIdx, 'storage removal present in handler').toBeGreaterThanOrEqual(0);
    expect(updateIdx, 'leases UPDATE must come before storage.remove').toBeLessThan(storageIdx);
    // ...and the audit insert sits between them.
    const auditIdx = handler.indexOf("activity_type: 'document_deleted'");
    expect(auditIdx).toBeGreaterThan(updateIdx);
    expect(auditIdx).toBeLessThan(storageIdx);
  });

  it('error-checks the audit insert and restores the column pointers on failure', () => {
    expect(handler).toContain('const { error: auditError }');
    const failureBranch = sliceBetween(handler, 'if (auditError) {', '}');
    expect(failureBranch).toContain('.update(restoreColumns)');
    // restoreColumns actually restores the original pointers per kind.
    const restore = sliceBetween(handler, 'const restoreColumns', '};');
    expect(restore).toContain('filename: pendingDelete.name, storage_path: pendingDelete.path');
    expect(restore).toContain(
      'executed_filename: pendingDelete.name, executed_storage_path: pendingDelete.path',
    );
  });

  it('verifies the storage .remove() result instead of trusting a non-error response', () => {
    const removal = sliceBetween(handler, 'const { data: removed', 'setPendingDelete(null)');
    expect(removal).toContain('.remove([pendingDelete.path])');
    expect(removal).toContain('removed.length === 0');
    expect(removal).toContain("t('documents.delete_file_pending')");
  });

  it('writes forensic details (storage_path, bucket, kind) into the audit row', () => {
    const auditRow = sliceBetween(handler, "activity_type: 'document_deleted'", '} as any);');
    expect(auditRow).toContain('storage_path: pendingDelete.path');
    expect(auditRow).toContain('bucket,');
    expect(auditRow).toContain('document_kind: pendingDelete.kind');
  });

  it('hides Generate Summary while a generated summary is listed', () => {
    expect(source).toContain('{isLocked && analyses.length === 0 ?');
  });

  it('has no inline iframe preview', () => {
    expect(source).not.toContain('<iframe');
    expect(source).not.toContain('iframe');
  });

  it('revokes blob URLs on unmount ONLY (empty-dep effect over a ref), not on every analyses change', () => {
    const effect = sliceBetween(source, 'const analysesRef', '}, []);');
    expect(effect).toContain('analysesRef.current = analyses');
    expect(effect).toContain('analysesRef.current.forEach(r => URL.revokeObjectURL(r.url))');
    // The old bug: a cleanup depending on [analyses] revoked live URLs.
    expect(source).not.toContain('}, [analyses]);');
  });
});

// ---------------------------------------------------------------------------
// 2. AmendmentsList — archive semantics, dual audit rows, admin gating
// ---------------------------------------------------------------------------

describe('AmendmentsList archive-delete', () => {
  const source = readRepoFile('src/components/leases/AmendmentsList.tsx');

  it('fetch filters out archived amendments', () => {
    const fetch = sliceBetween(source, 'const fetchAmendments', '[parentLeaseId]');
    expect(fetch).toContain(".eq('parent_lease_id', parentLeaseId)");
    expect(fetch).toContain(".eq('archived', false)");
  });

  it('archives (not destroys) with attribution columns set', () => {
    const handler = sliceBetween(source, 'const handleConfirmedDelete = useCallback', 'finally {');
    const update = sliceBetween(handler, '.update({', '})');
    expect(update).toContain('archived: true');
    expect(update).toContain('archived_at: new Date().toISOString()');
    expect(update).toContain('archived_by: user.id');
  });

  it('writes BOTH audit rows — amendment_archived on the parent, lease_archived on the child — and checks the error', () => {
    const handler = sliceBetween(source, 'const handleConfirmedDelete = useCallback', 'finally {');
    const insert = sliceBetween(handler, "from('lease_activity_log').insert([", '] as any);');
    // Parent-side row
    const parentRow = sliceBetween(insert, "activity_type: 'amendment_archived'", '},');
    expect(parentRow).toContain('amendment_lease_id: pendingDelete.id');
    expect(insert).toContain('lease_id: parentLeaseId');
    // Child-side row
    const childRow = sliceBetween(insert, "activity_type: 'lease_archived'", '},');
    expect(childRow).toContain('parent_lease_id: parentLeaseId');
    expect(insert).toContain('lease_id: pendingDelete.id');
    // Error-checked, surfaced to the user, not swallowed
    expect(handler).toContain('const { error: auditError }');
    const failureBranch = sliceBetween(handler, 'if (auditError) {', '} else {');
    expect(failureBranch).toContain("t('amendments.delete_audit_warning')");
  });

  it('renders the archive button only for admins, and hides it on read-only (Vault)', () => {
    // Audit D2: the per-amendment archive is a write, so it's gated on
    // `isAdmin && !readOnly` — hidden on a read-only retention workspace.
    const gated = sliceBetween(source, '{isAdmin && !readOnly && (', 'setPendingDelete(amendment)');
    expect(gated).toContain('<Button');
    // #92: archive vocabulary — the action archives, so the label says
    // "Archive", not "Delete". i18n sweep 2026-07-12: the label renders
    // through i18next now — pin the key (both locales say "Archive…", the
    // parity test guards key existence).
    expect(gated).toContain("aria-label={t('amendments.archive_aria', { name: amendment.filename })}");
  });
});

// ---------------------------------------------------------------------------
// 3. ArchiveButton — both directions logged, error-checked
// ---------------------------------------------------------------------------

describe('ArchiveButton audit logging', () => {
  const source = readRepoFile('src/components/leases/ArchiveButton.tsx');
  const apply = sliceBetween(source, 'const apply = async () => {', 'finally {');

  it('logs lease_restored on unarchive and lease_archived on archive', () => {
    expect(apply).toContain("activity_type: isArchived ? 'lease_restored' : 'lease_archived'");
  });

  it('error-checks the audit insert and warns the user instead of silently swallowing', () => {
    expect(apply).toContain('const { error: auditError }');
    const failureBranch = sliceBetween(apply, 'if (auditError) {', '} else {');
    expect(failureBranch).toContain("t('archive.audit_warning')");
  });

  it('restore nulls the column-level attribution (which is WHY the log row must exist)', () => {
    expect(apply).toContain('{ archived: false, archived_at: null, archived_by: null }');
  });
});

// ---------------------------------------------------------------------------
// 4. Migration 20260612210000 — new activity types + AuditLog labels
// ---------------------------------------------------------------------------

describe('document_activity_types migration', () => {
  const source = readRepoFile(
    'supabase/migrations/20260612210000_document_activity_types.sql',
  );

  it('re-creates the CHECK constraint with all five 2026-06-12 activity types', () => {
    const constraint = sliceBetween(
      source,
      'ADD CONSTRAINT lease_activity_log_activity_type_check',
      '));',
    );
    for (const type of [
      "'document_deleted'",
      "'amendment_archived'",
      "'amendment_restored'",
      "'lease_archived'",
      "'lease_restored'",
    ]) {
      expect(constraint, `constraint must include ${type}`).toContain(type);
    }
    // Snapshot+append pattern: the pre-existing values must still be present
    // (dropping the constraint and re-adding a partial list would break every
    // older writer).
    for (const preExisting of ["'status_change'", "'document_upload'", "'unlock_requested'"]) {
      expect(constraint).toContain(preExisting);
    }
  });

  it('drops the old constraint idempotently before re-adding', () => {
    expect(source).toContain(
      'DROP CONSTRAINT IF EXISTS lease_activity_log_activity_type_check',
    );
  });
});

describe('AuditLog labels for the new activity types', () => {
  it('ACTIVITY_LABELS maps document_deleted and amendment_archived to user-facing labels', () => {
    const source = readRepoFile('src/pages/app/AuditLog.tsx');
    const labels = sliceBetween(
      source,
      'const ACTIVITY_LABELS: Record<string, string> = {',
      '};',
    );
    expect(labels).toContain("document_deleted: 'Document deleted'");
    expect(labels).toContain("amendment_archived: 'Amendment deleted'");
  });
});

// ---------------------------------------------------------------------------
// 5. Migration 20260612220000 — login_events grant/RLS posture
// ---------------------------------------------------------------------------

describe('login_events migration', () => {
  const source = readRepoFile('supabase/migrations/20260612220000_login_events.sql');

  it('revokes the default grants from authenticated (and anon/PUBLIC) before granting', () => {
    expect(source).toContain(
      'REVOKE ALL ON public.login_events FROM PUBLIC, anon, authenticated;',
    );
  });

  it('grants SELECT only — no client INSERT/UPDATE/DELETE grant', () => {
    const grants = source.match(/^GRANT .*$/gm) ?? [];
    expect(grants).toEqual(['GRANT SELECT ON public.login_events TO authenticated;']);
  });

  it('SELECT policy is scoped to auth.uid()', () => {
    const policy = sliceBetween(source, 'CREATE POLICY "users read own login events"', ';');
    expect(policy).toContain('FOR SELECT');
    expect(policy).toContain('user_id = auth.uid()');
  });

  it('defines NO INSERT/UPDATE/DELETE policies (service-role writer only)', () => {
    const policies = source.match(/CREATE POLICY/g) ?? [];
    expect(policies, 'exactly one policy (the SELECT one)').toHaveLength(1);
    expect(source).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  it('enables RLS on the table', () => {
    expect(source).toContain('ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;');
  });
});

// ---------------------------------------------------------------------------
// 6. record-login-event edge function — IP provenance + shared helpers
// ---------------------------------------------------------------------------

describe('record-login-event edge function', () => {
  const source = readRepoFile('supabase/functions/record-login-event/index.ts');

  it('takes the LAST (platform-set) X-Forwarded-For entry, never the client-forgeable first', () => {
    const candidate = sliceBetween(source, 'const candidate', 'null;');
    expect(candidate).toContain('x-forwarded-for")?.split(",").at(-1)');
    expect(candidate).not.toContain('split(",")[0]');
    // Dedicated real-IP headers take precedence over the XFF chain.
    const cfIdx = candidate.indexOf('cf-connecting-ip');
    const xffIdx = candidate.indexOf('x-forwarded-for');
    expect(cfIdx).toBeGreaterThanOrEqual(0);
    expect(cfIdx).toBeLessThan(xffIdx);
  });

  it('validates the candidate against IP_PATTERN (and a length cap) before storing', () => {
    expect(source).toContain('const IP_PATTERN');
    const ip = sliceBetween(source, 'const ip =', ';');
    expect(ip).toContain('IP_PATTERN.test(candidate)');
    expect(ip).toContain('candidate.length <= 45');
    expect(ip).toContain(': null');
  });

  it('imports jsonResponse from the shared cors module instead of reimplementing it', () => {
    expect(source).toContain('jsonResponse } from "../_shared/cors.ts"');
    expect(source).not.toContain('function jsonResponse');
  });

  it('derives the user from the verified JWT — the client cannot specify a target user', () => {
    expect(source).toContain('auth.getUser(token)');
    const insert = sliceBetween(source, 'from("login_events").insert(', '});');
    expect(insert).toContain('user_id: userId');
    // No req.json()/body parsing at all — nothing client-supplied is trusted.
    expect(source).not.toContain('req.json()');
  });

  it('truncates the user agent to MAX_UA_LENGTH', () => {
    expect(source).toContain('.slice(0, MAX_UA_LENGTH)');
  });

  it('retention prune is scoped to the authenticated user (keeps 25 of THEIR rows, touches no one else)', () => {
    expect(source).toContain('const KEEP_ROWS = 25');
    const prune = sliceBetween(source, '.delete()', 'lt("created_at", cutoff)');
    expect(prune).toContain('.eq("user_id", userId)');
  });

  it('is registered in config.toml with verify_jwt', () => {
    const config = readRepoFile('supabase/config.toml');
    const block = sliceBetween(config, '[functions.record-login-event]', 'verify_jwt = true');
    expect(block).toContain('verify_jwt = true');
  });
});

// ---------------------------------------------------------------------------
// 7. Leases.tsx — archived visibility includes NULL-lifecycle rows
// ---------------------------------------------------------------------------

describe('Leases scope-based visibility', () => {
  const source = readRepoFile('src/pages/Leases.tsx');
  // The Leases redesign replaced the showArchived boolean with a single
  // StatusScope ('active' | 'archived' | 'all'). The fetch builds three
  // disjoint query branches; this block lives between portfolioList and the
  // awaited query. We slice it and assert each branch's filter shape (#91 +
  // the redesign default-ALL behavior).
  const block = sliceBetween(
    source,
    "const portfolioList = PORTFOLIO_STATUSES.join(',');",
    'const { data, error } = await query;',
  );
  const activeIdx = block.indexOf("scope === 'active'");
  const archivedIdx = block.indexOf("scope === 'archived'");
  const elseIdx = block.indexOf('} else {');
  const activeBranch = block.slice(activeIdx, archivedIdx);
  const archivedBranch = block.slice(archivedIdx, elseIdx);
  const allBranch = block.slice(elseIdx);

  it('active scope filters to the portfolio statuses AND non-archived', () => {
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(activeBranch).toContain(".in('lifecycle_status', PORTFOLIO_STATUSES)");
    expect(activeBranch).toContain(".eq('archived', false)");
  });

  it('archived scope shows ONLY archived rows and ORs in lifecycle_status.is.null (#91)', () => {
    expect(archivedIdx).toBeGreaterThan(activeIdx);
    // archived = true so the live portfolio is excluded...
    expect(archivedBranch).toContain(".eq('archived', true)");
    // ...while still ORing in NULL lifecycle_status so an archived failed/
    // processing upload or amendment remains reachable here to restore.
    expect(archivedBranch).toContain('lifecycle_status.is.null');
    expect(archivedBranch).toContain('.or(');
    expect(archivedBranch).not.toContain(".eq('archived', false)");
  });

  it('default (ALL) scope unions the live portfolio with archived NULL-lifecycle rows', () => {
    expect(elseIdx).toBeGreaterThan(archivedIdx);
    // ALL is the new default: portfolio statuses (any archived flag) PLUS
    // archived rows that never got a lifecycle_status. Non-archived drafts/
    // failures stay out (they live in ImportHistory / processing).
    expect(allBranch).toContain('lifecycle_status.in.(${portfolioList})');
    expect(allBranch).toContain('and(archived.eq.true,lifecycle_status.is.null)');
  });
});

// ---------------------------------------------------------------------------
// 8. Locale parity — new namespaces exist in BOTH en and es
// ---------------------------------------------------------------------------

type LocaleTree = { [key: string]: string | LocaleTree };

const en = JSON.parse(readRepoFile('src/locales/en/common.json')) as LocaleTree;
const es = JSON.parse(readRepoFile('src/locales/es/common.json')) as LocaleTree;

function keysOf(tree: LocaleTree | undefined): string[] {
  return tree && typeof tree === 'object' ? Object.keys(tree).sort() : [];
}

describe('locale parity for 2026-06-12 polish namespaces', () => {
  it('documents.* key sets are identical in en and es and include every key the components reference', () => {
    expect(keysOf(en.documents as LocaleTree)).toEqual(keysOf(es.documents as LocaleTree));
    for (const key of [
      'delete_doc_title', 'delete_original_desc', 'delete_executed_desc',
      'remove_summary_title', 'remove_summary_desc', 'remove_cta',
      'delete_success', 'delete_failed', 'delete_audit_failed',
      'delete_file_pending', 'locked_note', 'summary_session_note',
    ]) {
      expect(en.documents, `en documents.${key}`).toHaveProperty(key);
      expect(es.documents, `es documents.${key}`).toHaveProperty(key);
    }
  });

  it('amendments.* key sets are identical in en and es and include the delete-flow keys', () => {
    expect(keysOf(en.amendments as LocaleTree)).toEqual(keysOf(es.amendments as LocaleTree));
    for (const key of [
      'delete_title', 'delete_desc', 'delete_success', 'delete_failed',
      'delete_audit_warning',
    ]) {
      expect(en.amendments, `en amendments.${key}`).toHaveProperty(key);
      expect(es.amendments, `es amendments.${key}`).toHaveProperty(key);
    }
  });

  it('archive.* gains audit_warning / deleted_badge / deleted_banner in both locales', () => {
    expect(keysOf(en.archive as LocaleTree)).toEqual(keysOf(es.archive as LocaleTree));
    for (const key of ['audit_warning', 'deleted_badge', 'deleted_banner']) {
      expect(en.archive, `en archive.${key}`).toHaveProperty(key);
      expect(es.archive, `es archive.${key}`).toHaveProperty(key);
    }
  });

  it('account.consent_revoke_* and workspace.back_to_workspace_settings exist in both locales', () => {
    for (const key of ['consent_revoke_title', 'consent_revoke_desc', 'consent_revoke_cta']) {
      expect(en.account, `en account.${key}`).toHaveProperty(key);
      expect(es.account, `es account.${key}`).toHaveProperty(key);
    }
    expect(en.workspace).toHaveProperty('back_to_workspace_settings');
    expect(es.workspace).toHaveProperty('back_to_workspace_settings');
    // common.more_actions backs the new overflow trigger's aria-label.
    expect(en.common).toHaveProperty('more_actions');
    expect(es.common).toHaveProperty('more_actions');
  });

  it('every t() key referenced by the new/changed components resolves in the en locale', () => {
    const sources = [
      'src/components/leases/LeaseDocumentsTab.tsx',
      'src/components/leases/AmendmentsList.tsx',
      'src/components/leases/ArchiveButton.tsx',
      'src/components/leases/locked/LockedHeader.tsx',
    ]
      .map(readRepoFile)
      .join('\n');
    const missing: string[] = [];
    for (const m of sources.matchAll(/t\('([a-z0-9_]+)\.([a-z0-9_]+)'/gi)) {
      const [, ns, key] = m;
      const section = en[ns] as LocaleTree | undefined;
      if (!section || !(key in section)) missing.push(`${ns}.${key}`);
    }
    expect(missing, 'keys referenced in source but missing from en locale').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. LockedHeader — archived banner/badge + overflow menu
// ---------------------------------------------------------------------------

describe('LockedHeader archived state + overflow menu', () => {
  const source = readRepoFile('src/components/leases/locked/LockedHeader.tsx');

  it('renders the deleted badge from isArchived', () => {
    const badge = sliceBetween(source, '{isArchived && (', ')}');
    expect(badge).toContain("t('archive.deleted_badge')");
  });

  it('renders an unmissable archived banner with an inline admin restore action', () => {
    // Archive is non-destructive → the banner is neutral (muted, with an icon), not red.
    const banner = sliceBetween(source, 'Neutral, not destructive-red', '</Card>');
    expect(banner).toContain("t('archive.deleted_banner')");
    // Audit D2: restore (unarchive) is a write, so it's also gated on !readOnly
    // — hidden on a read-only retention workspace.
    const restore = sliceBetween(banner, '{!readOnly && isAdmin && leaseId && (', '</Button>');
    expect(restore).toContain('setArchiveDialogOpen(true)');
    expect(restore).toContain("t('archive.unarchive')");
  });

  it('has an overflow menu containing the audit-trail link and the admin archive item', () => {
    const menu = sliceBetween(source, '<DropdownMenu>', '</DropdownMenu>');
    expect(menu).toContain('audit-log?leaseId=${leaseId}');
    // Audit D2: the archive item is a write, gated on !readOnly (hidden on Vault).
    const adminItems = sliceBetween(menu, '{!readOnly && isAdmin && (', '</DropdownMenuContent>');
    expect(adminItems).toContain('setArchiveDialogOpen(true)');
    // Trigger is labeled for screen readers.
    expect(menu).toContain("aria-label={t('common.more_actions')}");
  });

  it('mounts ArchiveButton in controlled mode (open/onOpenChange) so the menu item and banner share one dialog', () => {
    const mount = sliceBetween(source, '<ArchiveButton', '/>');
    expect(mount).toContain('open={archiveDialogOpen}');
    expect(mount).toContain('onOpenChange={setArchiveDialogOpen}');
  });
});
