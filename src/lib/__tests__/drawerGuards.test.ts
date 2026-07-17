import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Polish walkthrough 2026-07-17 (commit 9bce71a, cluster 6) — request-drawer
// guards. Four silent failures this pins:
//   (a) a rejected file drop did NOTHING (user assumed the attach worked);
//   (b) Esc / overlay-click / Cancel on a filled form silently wiped it
//       (form.reset() runs on close) — dirty closes must confirm first;
//   (c) Submit lived mid-scroll — the pinned footer keeps it reachable, with
//       Submit in the terminal slot after Cancel;
//   (d) the route preview rendered ABOVE the inputs that drive it, predicting
//       a route from fields the user hadn't reached yet.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const frm = read('src/components/workflow/LeaseRequestForm.tsx');

describe('cluster 6 — rejected drops speak up', () => {
  it('defines an onDropRejected handler with per-cause messages', () => {
    const handler = frm.slice(
      frm.indexOf('const onDropRejected'),
      frm.indexOf('const { getRootProps'),
    );
    expect(handler).toContain("'file-too-large'");
    expect(handler).toContain("t('workflow.request.file_too_large')");
    expect(handler).toContain("t('workflow.request.file_pdf_only')");
    expect(handler).toContain("t('workflow.request.file_rejected')");
  });

  it('wires onDropRejected into useDropzone', () => {
    // Narrow to the useDropzone options object.
    const dz = frm.slice(frm.indexOf('useDropzone({'), frm.indexOf('formIsDirty'));
    expect(dz).toContain('onDropRejected');
  });
});

describe('cluster 6 — dirty close routes through a discard confirm', () => {
  it('formIsDirty covers form edits AND an attached file', () => {
    expect(frm).toContain('const formIsDirty = form.formState.isDirty || !!file;');
  });

  it('handleSheetOpenChange intercepts dirty closes (but never mid-submit)', () => {
    expect(frm).toMatch(/if \(!next && formIsDirty && !isSubmitting\) \{\s*setConfirmDiscardOpen\(true\);\s*return;/);
  });

  it('the Sheet itself closes through the guard', () => {
    expect(frm).toContain('<Sheet open={open} onOpenChange={handleSheetOpenChange}>');
  });

  it('the discard AlertDialog uses the dedicated keys', () => {
    const dialog = frm.slice(frm.indexOf('<AlertDialog open={confirmDiscardOpen}'));
    expect(dialog.length).toBeGreaterThan(0);
    expect(dialog).toContain("t('workflow.request.discard_title')");
    expect(dialog).toContain("t('workflow.request.discard_body')");
    expect(dialog).toContain("t('workflow.request.discard_keep')");
    expect(dialog).toContain("t('workflow.request.discard_confirm')");
  });
});

describe('cluster 6 — pinned footer, Submit in the terminal slot', () => {
  const footer = frm.slice(frm.indexOf('<SheetFooter'), frm.indexOf('</SheetFooter>'));

  it('the footer is pinned with a border-t separator', () => {
    expect(footer).toMatch(/<SheetFooter className="border-t/);
  });

  it('Submit comes AFTER Cancel in DOM order', () => {
    const cancelAt = footer.indexOf("t('common.cancel')");
    const submitAt = footer.indexOf("t('workflow.request.submit')");
    expect(cancelAt).toBeGreaterThan(-1);
    expect(submitAt).toBeGreaterThan(cancelAt);
  });

  it('Cancel routes through the same dirty-guard as Esc/overlay', () => {
    expect(footer).toContain('handleSheetOpenChange(false)');
  });
});

describe('cluster 6 — route preview renders below its inputs', () => {
  it('route_preview appears AFTER lease_terms, inside the form', () => {
    const termsAt = frm.indexOf("t('workflow.request.lease_terms')");
    const previewAt = frm.indexOf("t('workflow.request.route_preview')");
    const formCloseAt = frm.indexOf('</form>');
    expect(termsAt).toBeGreaterThan(-1);
    expect(previewAt).toBeGreaterThan(termsAt);
    expect(formCloseAt).toBeGreaterThan(previewAt);
  });
});
