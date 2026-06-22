import { describe, it, expect } from 'vitest';
import { isWorkspaceReadOnly } from '@/lib/workspaceReadOnly';

// #136 — isWorkspaceReadOnly is the single source of truth for "view + export
// only". It must be true for BOTH the Vault retention tier AND the cancellation
// grace / soft-delete window; false for a live workspace on any normal plan.

describe('isWorkspaceReadOnly', () => {
  it('is false for null/undefined', () => {
    expect(isWorkspaceReadOnly(null)).toBe(false);
    expect(isWorkspaceReadOnly(undefined)).toBe(false);
  });

  it('is false for a live workspace on a normal plan', () => {
    expect(isWorkspaceReadOnly({ plan: 'starter' })).toBe(false);
    expect(isWorkspaceReadOnly({ plan: 'business' })).toBe(false);
    expect(
      isWorkspaceReadOnly({ plan: 'business', canceledAt: null, graceExpiresAt: null, softDeletedAt: null }),
    ).toBe(false);
  });

  it('is true for the Vault retention plan (plan-based)', () => {
    expect(isWorkspaceReadOnly({ plan: 'vault' })).toBe(true);
  });

  it('is true for a cancellation grace window — plan still starter/business (#136 gap)', () => {
    expect(
      isWorkspaceReadOnly({
        plan: 'business',
        canceledAt: '2026-06-01T00:00:00Z',
        graceExpiresAt: '2026-07-01T00:00:00Z',
        softDeletedAt: null,
      }),
    ).toBe(true);
  });

  it('is true for a soft-deleted workspace', () => {
    expect(
      isWorkspaceReadOnly({
        plan: 'starter',
        canceledAt: '2026-05-01T00:00:00Z',
        graceExpiresAt: '2026-06-01T00:00:00Z',
        softDeletedAt: '2026-06-01T00:00:00Z',
      }),
    ).toBe(true);
  });

  it('treats a plan-less but canceled workspace as read-only', () => {
    expect(isWorkspaceReadOnly({ plan: null, canceledAt: '2026-06-01T00:00:00Z' })).toBe(true);
  });
});
