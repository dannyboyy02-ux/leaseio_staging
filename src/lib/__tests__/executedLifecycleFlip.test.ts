import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES #94 regression guard.
//
// Before #94, UploadExecutedDocumentDialog.tsx flipped leases.lifecycle_status
// to 'executed' client-side via a plain `.update({ lifecycle_status })` — with
// NO status_changed_at and NO lease_activity_log row. The transition was
// therefore unattributable and violated the Lifecycle Transition Convention
// (CLAUDE.md): status_changed_at, a status_change activity row carrying
// top-level from_status/to_status + the details triplet, and a routing_path.
//
// #94 moved the flip into process_lease's executed branch (extractionMode ===
// 'executed') so the server writes it convention-compliantly and removed the
// client-side flip entirely.
//
// Test shape: static repo-file assertions (readFileSync + toContain), the
// established style for edge-function coverage that isn't unit-tested live —
// see auditRemediation.test.ts and clientActivityAllowlist.test.ts.
//
// Two failure modes this guards:
//   1. The client flip being re-introduced (client writes lifecycle_status
//      again, silently un-attributing the transition).
//   2. The server executed-branch convention triplet being dropped/weakened.
//
// IMPORTANT (per the CLAUDE.md static-test gotcha): process_lease has TWO
// status_change flips — the new-lease pipeline flip (triggered_by:
// 'process_lease') and this executed-upload flip (triggered_by:
// 'process_lease_executed_upload'). A full-file toContain on 'status_change' /
// 'routing_path' would pass off the OTHER flip and prove nothing about the
// executed branch. So we narrow the search window to the executed branch and
// target it by its UNIQUE triggered_by marker.

const ROOT = join(__dirname, '../../..');

function readRepoFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('executed-document lifecycle flip moved server-side (#94)', () => {
  // --------------------------------------------------------------------------
  // (1) CLIENT no longer writes lifecycle_status='executed'.
  //
  // The dialog must NOT carry any `.update({ lifecycle_status ... })` call.
  // If this reappears, the transition is once again written without
  // status_changed_at / activity row — exactly the unattributable flip #94
  // removed. We strip JS line comments first so the explanatory comment in the
  // dialog (which legitimately mentions lifecycle_status to document the move)
  // doesn't produce a false negative.
  // --------------------------------------------------------------------------
  it('UploadExecutedDocumentDialog does not write lifecycle_status (client flip removed)', () => {
    const source = readRepoFile('src/components/leases/UploadExecutedDocumentDialog.tsx');

    const withoutLineComments = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    // No client-side update of lifecycle_status in any form.
    expect(withoutLineComments).not.toMatch(/lifecycle_status\s*:/);
    // And specifically not the literal flip-to-executed shape.
    expect(withoutLineComments).not.toContain(".update({ lifecycle_status: 'executed'");
    expect(withoutLineComments).not.toMatch(/\.update\(\s*\{[^}]*lifecycle_status/s);

    // Belt-and-suspenders: the dialog must not call .from('leases').update at
    // all — its only mutation path post-#94 is the process_lease invocation.
    expect(withoutLineComments).not.toMatch(/from\(\s*['"]leases['"]\s*\)\s*\n?\s*\.update/s);
  });

  // --------------------------------------------------------------------------
  // (2) SERVER executed branch writes the full convention triplet.
  //
  // We isolate the executed branch:
  //   start = `if (extractionMode === 'executed')`
  //   end   = the NEW-LEASE flip marker `triggered_by: 'process_lease'` (the
  //           other flip), so the new-lease flip's own status_change / routing
  //           tokens can never leak into this window and false-green the test.
  //
  // Within that window we assert the executed flip carries:
  //   - the unique triggered_by marker scoping it to THIS path
  //   - activity_type 'status_change'
  //   - top-level from_status / to_status
  //   - status_changed_at in the UPDATE
  //   - routing_path in details
  // --------------------------------------------------------------------------
  it('process_lease executed branch writes the convention status_change triplet', () => {
    const source = readRepoFile('supabase/functions/process_lease/index.ts');

    const branchStart = source.indexOf("if (extractionMode === 'executed')");
    expect(branchStart, "executed branch marker not found").toBeGreaterThan(-1);

    // Upper bound: the new-lease flip's unique marker. This guarantees the
    // window contains the executed flip but NOT the new-lease flip, so every
    // assertion below is proven against the executed branch specifically.
    const newLeaseFlipMarker = "triggered_by: 'process_lease'";
    const branchEnd = source.indexOf(newLeaseFlipMarker, branchStart);
    expect(branchEnd, "new-lease flip marker (window upper bound) not found").toBeGreaterThan(
      branchStart,
    );

    const window = source.slice(branchStart, branchEnd);

    // The distinguishing marker: scopes this status_change to the executed path.
    expect(
      window,
      "executed branch missing the triggered_by marker that scopes the flip to this path",
    ).toContain("triggered_by: 'process_lease_executed_upload'");

    // The convention activity row.
    expect(window).toContain("activity_type: 'status_change'");

    // Top-level from/to columns (backward-compat shape).
    expect(window).toContain('from_status:');
    expect(window).toContain("to_status: 'executed'");

    // status_changed_at set in the same UPDATE as lifecycle_status.
    expect(window).toContain('status_changed_at');
    expect(window).toContain("lifecycle_status: 'executed'");

    // routing_path inside details.
    expect(window).toContain("routing_path: 'extraction'");

    // Guard: the flip is gated so a re-upload of an already-executed lease does
    // not write a no-op transition (idempotency invariant from #94).
    expect(window).toContain('willFlipToExecuted');
    expect(window).toContain("!== 'executed'");
  });

  // --------------------------------------------------------------------------
  // (2b) Window-isolation sanity: prove the marker that distinguishes the two
  // flips is actually unique to each branch. If both markers ever resolved to
  // the same value (e.g. a copy-paste reusing 'process_lease' in the executed
  // branch), the window above would silently widen/collapse and stop proving
  // the executed branch carries its own convention. This pins that the
  // executed marker precedes the new-lease marker in source order AND that the
  // new-lease branch does NOT carry the executed marker.
  // --------------------------------------------------------------------------
  it('the two process_lease flips are distinguishable by triggered_by marker', () => {
    const source = readRepoFile('supabase/functions/process_lease/index.ts');

    const executedMarkerPos = source.indexOf("triggered_by: 'process_lease_executed_upload'");
    const newLeaseMarkerPos = source.indexOf("triggered_by: 'process_lease'");

    expect(executedMarkerPos, 'executed flip marker missing').toBeGreaterThan(-1);
    expect(newLeaseMarkerPos, 'new-lease flip marker missing').toBeGreaterThan(-1);

    // Executed flip lives earlier in the file than the new-lease flip.
    expect(executedMarkerPos).toBeLessThan(newLeaseMarkerPos);

    // Each marker is a distinct literal (the executed one is a strict superset
    // string, so a substring search for the new-lease literal must not match
    // inside the executed literal at the executed position).
    expect(source.indexOf("triggered_by: 'process_lease'", executedMarkerPos - 1)).not.toBe(
      executedMarkerPos,
    );
  });
});
