import { describe, it, expect } from 'vitest';
import {
  buildApproverCandidates,
  formatApproverLabel,
  mergeCandidateIds,
  type ApproverProfile,
} from '../approverCandidates';

function profile(p: Partial<ApproverProfile> & { id: string }): ApproverProfile {
  return {
    id: p.id,
    first_name: p.first_name ?? null,
    last_name: p.last_name ?? null,
    email: p.email ?? null,
  };
}

function profileMap(...ps: ApproverProfile[]): Map<string, ApproverProfile> {
  return new Map(ps.map((p) => [p.id, p]));
}

describe('mergeCandidateIds', () => {
  it('dedups across owner, admin members, and explicit approvers', () => {
    const ids = mergeCandidateIds({
      ownerId: 'a',
      memberAdminIds: ['a', 'b'],
      explicitApproverIds: ['b', 'c'],
      selfId: null,
    });
    expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('excludes self', () => {
    const ids = mergeCandidateIds({
      ownerId: 'a',
      memberAdminIds: ['b'],
      explicitApproverIds: ['c'],
      selfId: 'b',
    });
    expect(new Set(ids)).toEqual(new Set(['a', 'c']));
  });

  it('returns empty when every source resolves to self', () => {
    const ids = mergeCandidateIds({
      ownerId: 'me',
      memberAdminIds: ['me'],
      explicitApproverIds: ['me'],
      selfId: 'me',
    });
    expect(ids).toEqual([]);
  });

  it('handles null owner and empty arrays', () => {
    const ids = mergeCandidateIds({
      ownerId: null,
      memberAdminIds: [],
      explicitApproverIds: [],
      selfId: 'me',
    });
    expect(ids).toEqual([]);
  });
});

describe('formatApproverLabel', () => {
  it('renders "First Last (email)" when both name parts and email exist', () => {
    expect(
      formatApproverLabel(profile({ id: 'x', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@x.com' })),
    ).toBe('Ada Lovelace (ada@x.com)');
  });

  it('renders first name only + email when last_name is null', () => {
    expect(
      formatApproverLabel(profile({ id: 'x', first_name: 'Ada', last_name: null, email: 'ada@x.com' })),
    ).toBe('Ada (ada@x.com)');
  });

  it('falls back to bare email when both names are null', () => {
    expect(
      formatApproverLabel(profile({ id: 'x', first_name: null, last_name: null, email: 'ada@x.com' })),
    ).toBe('ada@x.com');
  });

  it('falls back to id when email is also null', () => {
    expect(
      formatApproverLabel(profile({ id: 'user-123', first_name: null, last_name: null, email: null })),
    ).toBe('user-123');
  });

  it('treats whitespace-only name as empty', () => {
    expect(
      formatApproverLabel(profile({ id: 'x', first_name: '  ', last_name: '', email: 'ada@x.com' })),
    ).toBe('ada@x.com');
  });
});

describe('buildApproverCandidates', () => {
  it('owner sorts first, then alphabetical by label', () => {
    const out = buildApproverCandidates({
      ownerId: 'owner',
      memberAdminIds: ['alice', 'bob'],
      explicitApproverIds: [],
      selfId: null,
      profilesById: profileMap(
        profile({ id: 'owner', first_name: 'Zelda', email: 'z@x.com' }),
        profile({ id: 'alice', first_name: 'Alice', email: 'a@x.com' }),
        profile({ id: 'bob', first_name: 'Bob', email: 'b@x.com' }),
      ),
    });
    expect(out.map((c) => c.id)).toEqual(['owner', 'alice', 'bob']);
    expect(out[0].isOwner).toBe(true);
    expect(out[1].isOwner).toBe(false);
  });

  it('excludes self and includes all others', () => {
    const out = buildApproverCandidates({
      ownerId: 'owner',
      memberAdminIds: ['alice', 'bob'],
      explicitApproverIds: [],
      selfId: 'alice',
      profilesById: profileMap(
        profile({ id: 'owner', first_name: 'Zelda', email: 'z@x.com' }),
        profile({ id: 'bob', first_name: 'Bob', email: 'b@x.com' }),
      ),
    });
    expect(out.map((c) => c.id).sort()).toEqual(['bob', 'owner']);
    expect(out.find((c) => c.id === 'alice')).toBeUndefined();
  });

  it('merges explicit approvers with dedup against admins', () => {
    const out = buildApproverCandidates({
      ownerId: 'owner',
      memberAdminIds: ['alice'],
      explicitApproverIds: ['alice', 'bob'],
      selfId: null,
      profilesById: profileMap(
        profile({ id: 'owner', first_name: 'Zelda', email: 'z@x.com' }),
        profile({ id: 'alice', first_name: 'Alice', email: 'a@x.com' }),
        profile({ id: 'bob', first_name: 'Bob', email: 'b@x.com' }),
      ),
    });
    expect(out).toHaveLength(3);
    expect(out.filter((c) => c.id === 'alice')).toHaveLength(1);
  });

  it('falls back to self when no other candidates exist', () => {
    const out = buildApproverCandidates({
      ownerId: 'me',
      memberAdminIds: ['me'],
      explicitApproverIds: [],
      selfId: 'me',
      profilesById: profileMap(
        profile({ id: 'me', first_name: 'Me', email: 'me@x.com' }),
      ),
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('me');
    expect(out[0].isOwner).toBe(true);
  });

  it('returns empty when no candidates AND no self', () => {
    const out = buildApproverCandidates({
      ownerId: null,
      memberAdminIds: [],
      explicitApproverIds: [],
      selfId: null,
      profilesById: profileMap(),
    });
    expect(out).toEqual([]);
  });

  it('skips ids that have no matching profile row', () => {
    const out = buildApproverCandidates({
      ownerId: 'owner',
      memberAdminIds: ['ghost'],
      explicitApproverIds: [],
      selfId: null,
      profilesById: profileMap(
        profile({ id: 'owner', first_name: 'Zelda', email: 'z@x.com' }),
      ),
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('owner');
  });

  it('sort order is stable across different input array orderings', () => {
    const a = buildApproverCandidates({
      ownerId: 'owner',
      memberAdminIds: ['alice', 'bob', 'charlie'],
      explicitApproverIds: [],
      selfId: null,
      profilesById: profileMap(
        profile({ id: 'owner', first_name: 'Zoe', email: 'z@x.com' }),
        profile({ id: 'alice', first_name: 'Alice', email: 'a@x.com' }),
        profile({ id: 'bob', first_name: 'Bob', email: 'b@x.com' }),
        profile({ id: 'charlie', first_name: 'Charlie', email: 'c@x.com' }),
      ),
    });
    const b = buildApproverCandidates({
      ownerId: 'owner',
      memberAdminIds: ['charlie', 'bob', 'alice'],
      explicitApproverIds: [],
      selfId: null,
      profilesById: profileMap(
        profile({ id: 'owner', first_name: 'Zoe', email: 'z@x.com' }),
        profile({ id: 'alice', first_name: 'Alice', email: 'a@x.com' }),
        profile({ id: 'bob', first_name: 'Bob', email: 'b@x.com' }),
        profile({ id: 'charlie', first_name: 'Charlie', email: 'c@x.com' }),
      ),
    });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });
});
