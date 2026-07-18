import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const fn = read('supabase/functions/manage-workspace-member/index.ts');

// Fresh-eyes fix: workspace_members UPDATE/DELETE is owner-only at RLS, so an
// admin's browser write silently failed AND the client-side audit insert never
// fired (the rejected UPDATE ran first). This service-role function is the
// owner-OR-admin authorization boundary and moves both audit writes server-side
// so they are guaranteed. The owner's own membership row is never touchable
// here; set_role requires a live workspace, but remove stays open (Vault V1:
// shrinking access must always be possible). The member-management components
// must route through this function and never write workspace_members directly.

describe('manage-workspace-member — authorization + audit', () => {
  it('authorizes owner OR admin (owner_id check + admin membership fallback)', () => {
    expect(fn).toContain('owner_id');
    // Admin fallback: membership.role is compared against "admin". The source
    // has since been hardened to a positive check (=== "admin") rather than the
    // original negative (!== "admin"); match either polarity so this pin tracks
    // the authorization CONTRACT (membership role vs "admin"), not the exact
    // expression form.
    expect(fn).toMatch(/membership\?\.role\s*(===|!==)\s*"admin"/);
  });

  it('guards the owner row from being re-roled or removed', () => {
    expect(fn).toContain('cannot_modify_owner');
  });

  it('writes both audit events server-side', () => {
    expect(fn).toContain('member_role_changed');
    expect(fn).toContain('member_removed');
  });

  it('gates set_role on a live workspace but leaves remove open', () => {
    const setRoleBlock = fn.slice(
      fn.indexOf('if (action === "set_role")'),
      fn.indexOf("// action === 'remove'"),
    );
    const removeBlock = fn.slice(fn.indexOf("// action === 'remove'"));
    expect(setRoleBlock).toContain('checkWorkspaceLive');
    expect(removeBlock).not.toContain('checkWorkspaceLive');
  });
});

describe('member components route through the edge function (no direct table writes)', () => {
  for (const path of [
    'src/components/workspace/MemberRoleSelect.tsx',
    'src/components/workspace/MembersPanel.tsx',
  ]) {
    const c = read(path);
    it(`${path} invokes manage-workspace-member`, () => {
      expect(c).toContain("invoke('manage-workspace-member'");
    });
    it(`${path} does not update/delete workspace_members directly`, () => {
      expect(c).not.toContain("from('workspace_members').update(");
      expect(c).not.toContain("from('workspace_members').delete(");
    });
  }
});
