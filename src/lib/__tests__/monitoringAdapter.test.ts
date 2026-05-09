// Operational Monitoring — adapter contract + threshold ladder tests.
// Phase 3 of OPERATIONAL_MONITORING_SPEC.md.

import { describe, it, expect } from 'vitest';
import {
  thresholdCrossed,
  LADDERS,
  type VendorUsageSnapshot,
} from '../../adapters/monitoring/types';

const baseSnapshot: VendorUsageSnapshot = {
  vendor: 'test',
  metric: 'metric',
  current_value: 0,
  limit_value: 100,
  tier: 'test',
  category: 'soft_quota',
};

describe('thresholdCrossed', () => {
  it('returns null when limit_value is null (cost_runaway with no cap)', () => {
    expect(thresholdCrossed({ ...baseSnapshot, current_value: 1000, limit_value: null })).toBeNull();
  });

  it('returns null when limit_value is zero or negative', () => {
    expect(thresholdCrossed({ ...baseSnapshot, current_value: 100, limit_value: 0 })).toBeNull();
    expect(thresholdCrossed({ ...baseSnapshot, current_value: 100, limit_value: -1 })).toBeNull();
  });

  it('returns null below the lowest ladder rung', () => {
    expect(thresholdCrossed({ ...baseSnapshot, current_value: 50, limit_value: 100 })).toBeNull();
    // hard_cliff rung at 50 — below that returns null
    expect(thresholdCrossed({ ...baseSnapshot, current_value: 49, limit_value: 100, category: 'hard_cliff' })).toBeNull();
  });

  describe('soft_quota (70/85/95 ladder)', () => {
    it('warn at exactly 70%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 70, limit_value: 100, category: 'soft_quota' })).toBe('warn');
    });
    it('warn between 70 and 85', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 80, limit_value: 100, category: 'soft_quota' })).toBe('warn');
    });
    it('alert at exactly 85%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 85, limit_value: 100, category: 'soft_quota' })).toBe('alert');
    });
    it('alert between 85 and 95', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 90, limit_value: 100, category: 'soft_quota' })).toBe('alert');
    });
    it('critical at exactly 95%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 95, limit_value: 100, category: 'soft_quota' })).toBe('critical');
    });
    it('critical above 100% (over cap)', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 150, limit_value: 100, category: 'soft_quota' })).toBe('critical');
    });
  });

  describe('hard_cliff (50/75/90 ladder — tighter)', () => {
    it('warn at 50%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 50, limit_value: 100, category: 'hard_cliff' })).toBe('warn');
    });
    it('alert at 75%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 75, limit_value: 100, category: 'hard_cliff' })).toBe('alert');
    });
    it('critical at 90%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 90, limit_value: 100, category: 'hard_cliff' })).toBe('critical');
    });
  });

  describe('cost_runaway (50/75/90 ladder — same as hard_cliff)', () => {
    it('warn at 50%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 50, limit_value: 100, category: 'cost_runaway' })).toBe('warn');
    });
    it('alert at 75%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 75, limit_value: 100, category: 'cost_runaway' })).toBe('alert');
    });
    it('critical at 90%', () => {
      expect(thresholdCrossed({ ...baseSnapshot, current_value: 90, limit_value: 100, category: 'cost_runaway' })).toBe('critical');
    });
  });
});

describe('LADDERS', () => {
  it('has the three categories from the spec', () => {
    expect(LADDERS).toHaveProperty('soft_quota');
    expect(LADDERS).toHaveProperty('hard_cliff');
    expect(LADDERS).toHaveProperty('cost_runaway');
  });
  it('soft_quota uses the wider 70/85/95 ladder', () => {
    expect(LADDERS.soft_quota).toEqual({ warn: 70, alert: 85, critical: 95 });
  });
  it('hard_cliff and cost_runaway use the tighter 50/75/90 ladder', () => {
    expect(LADDERS.hard_cliff).toEqual({ warn: 50, alert: 75, critical: 90 });
    expect(LADDERS.cost_runaway).toEqual({ warn: 50, alert: 75, critical: 90 });
  });
});

describe('Phase 3 dedup expectations (per spec)', () => {
  // The dedup logic itself lives in the database (unique index on
  // vendor_alert_log per (vendor, metric, threshold_crossed, day-UTC)).
  // This test documents the intended behavior; the actual dedup is
  // exercised by integration smoke against the live DB.
  it('threshold crossed twice in the same day should produce one alert', () => {
    // Snapshot at noon — alert
    const noon = thresholdCrossed({ ...baseSnapshot, current_value: 90, limit_value: 100, category: 'soft_quota' });
    // Snapshot at 3pm same day — same threshold
    const threeOClock = thresholdCrossed({ ...baseSnapshot, current_value: 92, limit_value: 100, category: 'soft_quota' });
    expect(noon).toBe('alert');
    expect(threeOClock).toBe('alert');
    // The dedup happens at DB layer, not in this pure function. The
    // edge function attempts the second insert and gets a 23505
    // unique-violation, then silently continues.
  });
});
