// @vitest-environment jsdom
import '../../workspace/__tests__/_jsdomPolyfills';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18n from 'i18next';
import enCommon from '../../../locales/en/common.json';
import {
  LeaseStatusBadge,
  isProcessingStatus,
  isFailedStatus,
  needsReviewStatus,
} from '../LeaseStatusBadge';
import { LifecycleStatusBadge } from '@/components/lifecycle/LifecycleStatusBadge';

// Badge labels render through i18next (i18n sweep 2026-07-12). Initialize the
// singleton with the REAL en resources so the assertions below pin the exact
// per-status copy users see (lifecycle.status.* / lifecycle.status_short.*).
await i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common'],
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
});

// Pins the badge unification: LeaseStatusBadge is the single canonical badge
// (variant + soft appearances, one label source via displayLabel), and
// LifecycleStatusBadge is a thin soft-appearance wrapper. Regressions here would
// reintroduce the divergent label paths the unification removed.

afterEach(cleanup);

describe('LeaseStatusBadge — variant appearance (default)', () => {
  it('renders the displayLabel for a lifecycle/chain status', () => {
    render(<LeaseStatusBadge status="pending_counter_signature" />);
    expect(screen.getByText('Awaiting Counter-Signature')).toBeTruthy();
  });

  it('falls back to the raw string for AI-extraction statuses', () => {
    render(<LeaseStatusBadge status="Processing" />);
    expect(screen.getByText('Processing')).toBeTruthy();
  });

  it('renders "Unknown" for a null status', () => {
    render(<LeaseStatusBadge status={null} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
  });
});

describe('LeaseStatusBadge — soft appearance', () => {
  it('renders the full label at the default size', () => {
    render(<LeaseStatusBadge status="pending_counter_signature" appearance="soft" />);
    // Full label matches displayLabel — the single source of truth.
    expect(screen.getByText('Awaiting Counter-Signature')).toBeTruthy();
  });

  it('renders the short label at size="sm"', () => {
    render(<LeaseStatusBadge status="pending_counter_signature" appearance="soft" size="sm" />);
    expect(screen.getByText('Counter-Sign')).toBeTruthy();
  });
});

describe('LifecycleStatusBadge wrapper', () => {
  it('delegates to the soft full label at default size', () => {
    render(<LifecycleStatusBadge status="in_negotiation" />);
    expect(screen.getByText('In Negotiation')).toBeTruthy();
  });

  it('delegates to the soft short label at size="sm"', () => {
    render(<LifecycleStatusBadge status="in_negotiation" size="sm" />);
    expect(screen.getByText('Negotiation')).toBeTruthy();
  });
});

describe('status predicates', () => {
  it('isProcessingStatus covers Processing + Uploaded only', () => {
    expect(isProcessingStatus('Processing')).toBe(true);
    expect(isProcessingStatus('Uploaded')).toBe(true);
    expect(isProcessingStatus('Ready')).toBe(false);
    expect(isProcessingStatus(null)).toBe(false);
  });

  it('isFailedStatus covers only Failed', () => {
    expect(isFailedStatus('Failed')).toBe(true);
    expect(isFailedStatus('Ready')).toBe(false);
  });

  it('needsReviewStatus covers the review aliases', () => {
    expect(needsReviewStatus('Needs Review')).toBe(true);
    expect(needsReviewStatus('Review Required')).toBe(true);
    expect(needsReviewStatus('pending_review')).toBe(true);
    expect(needsReviewStatus('Ready')).toBe(false);
  });
});
