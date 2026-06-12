import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useApp } from '@/contexts/AppContext';
import { useWorkspaceQuota } from '@/hooks/useWorkspaceQuota';

// ============================================================================
// useWorkspaceQuota — client limit wall (Workstream C)
//
// Pure derivation over AppContext's workspace object (the only hook it calls
// is useApp), so it's unit-testable by mocking the context — no renderer
// needed. These tests pin the advisory-gate contract that mirrors the server's
// assertProcessingQuota: blocked only when over a cap AND creditless, packs
// raise BOTH caps, loading state never blocks (server is the backstop), and
// monthly wins blockedMetric ties because it always applies.
// ============================================================================

vi.mock('@/contexts/AppContext', () => ({ useApp: vi.fn() }));
const mockUseApp = vi.mocked(useApp);

type QuotaFields = {
  documentsUsed: number;
  documentLimit: number;
  activeLeasesUsed: number;
  maxActiveLeases: number;
  addonDocumentCapacity: number;
  purchasedLeaseCredits: number;
};

function setWorkspace(overrides: Partial<QuotaFields> | null) {
  const workspace =
    overrides === null
      ? null
      : {
          // Healthy starter baseline; tests override what they exercise.
          documentsUsed: 0,
          documentLimit: 15,
          activeLeasesUsed: 0,
          maxActiveLeases: 15,
          addonDocumentCapacity: 0,
          purchasedLeaseCredits: 0,
          ...overrides,
        };
  mockUseApp.mockReturnValue({ workspace } as unknown as ReturnType<typeof useApp>);
}

beforeEach(() => {
  mockUseApp.mockReset();
});

describe('useWorkspaceQuota', () => {
  it('never blocks while the workspace is still loading (null workspace)', () => {
    setWorkspace(null);
    const q = useWorkspaceQuota();
    expect(q.blocked).toBe(false);
    expect(q.blockedMetric).toBeNull();
    expect(q.atMonthlyLimit).toBe(false);
    expect(q.atActiveLimit).toBe(false);
    expect(q.monthlyLimit).toBe(0);
    expect(q.credits).toBe(0);
  });

  it('never blocks on a degenerate zero monthly limit (loaded guard)', () => {
    // documentLimit 0 + no addon means "not really loaded" — blocking here
    // would wall out a workspace over a data blip; the server backstops.
    setWorkspace({ documentLimit: 0, documentsUsed: 99, activeLeasesUsed: 99 });
    const q = useWorkspaceQuota();
    expect(q.blocked).toBe(false);
    expect(q.blockedMetric).toBeNull();
  });

  it('does not block under both caps', () => {
    setWorkspace({ documentsUsed: 14, activeLeasesUsed: 14 });
    const q = useWorkspaceQuota();
    expect(q.atMonthlyLimit).toBe(false);
    expect(q.atActiveLimit).toBe(false);
    expect(q.blocked).toBe(false);
    expect(q.blockedMetric).toBeNull();
  });

  it('blocks at the monthly cap with zero credits (>= boundary, not >)', () => {
    setWorkspace({ documentsUsed: 15 });
    const q = useWorkspaceQuota();
    expect(q.atMonthlyLimit).toBe(true);
    expect(q.blocked).toBe(true);
    expect(q.blockedMetric).toBe('monthly_extractions');
  });

  it('blocks at the active-lease cap with zero credits', () => {
    setWorkspace({ activeLeasesUsed: 15 });
    const q = useWorkspaceQuota();
    expect(q.atActiveLimit).toBe(true);
    expect(q.atMonthlyLimit).toBe(false);
    expect(q.blocked).toBe(true);
    expect(q.blockedMetric).toBe('active_leases');
  });

  it('does NOT block when over a cap but holding a credit (one upload passes)', () => {
    setWorkspace({ documentsUsed: 15, purchasedLeaseCredits: 1 });
    const q = useWorkspaceQuota();
    // Still AT the limit (meters should show it)...
    expect(q.atMonthlyLimit).toBe(true);
    // ...but the wall stays down because the credit covers the next upload.
    expect(q.blocked).toBe(false);
    expect(q.credits).toBe(1);
    // blockedMetric still reports which cap tripped (informational).
    expect(q.blockedMetric).toBe('monthly_extractions');
  });

  it('a document pack raises BOTH the monthly and active limits additively', () => {
    setWorkspace({
      addonDocumentCapacity: 10,
      documentsUsed: 20,
      activeLeasesUsed: 20,
    });
    const q = useWorkspaceQuota();
    expect(q.monthlyLimit).toBe(25); // 15 base + 10 pack
    expect(q.activeLimit).toBe(25); // 15 base + 10 pack
    expect(q.blocked).toBe(false);
    // And the raised boundary still blocks at >=.
    setWorkspace({
      addonDocumentCapacity: 10,
      documentsUsed: 25,
    });
    expect(useWorkspaceQuota().blocked).toBe(true);
  });

  it('monthly wins blockedMetric precedence when both caps trip', () => {
    setWorkspace({ documentsUsed: 15, activeLeasesUsed: 15 });
    const q = useWorkspaceQuota();
    expect(q.atMonthlyLimit).toBe(true);
    expect(q.atActiveLimit).toBe(true);
    expect(q.blocked).toBe(true);
    expect(q.blockedMetric).toBe('monthly_extractions');
  });

  it('treats missing numeric fields as zero rather than throwing', () => {
    // A partially hydrated workspace (e.g. older cached shape without the new
    // credit/addon columns) must degrade safely.
    mockUseApp.mockReturnValue({
      workspace: { documentLimit: 15, documentsUsed: 3 },
    } as unknown as ReturnType<typeof useApp>);
    const q = useWorkspaceQuota();
    expect(q.credits).toBe(0);
    expect(q.activeUsed).toBe(0);
    // No maxActiveLeases → activeLimit 0, and the activeLimit > 0 guard keeps
    // the zero-limit from reading as "at the cap".
    expect(q.activeLimit).toBe(0);
    expect(q.atActiveLimit).toBe(false);
    expect(q.blocked).toBe(false);
  });
});
