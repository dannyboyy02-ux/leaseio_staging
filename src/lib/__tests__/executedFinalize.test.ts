import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// P1-5 (END_TO_END_REVIEW / j3-requestor §1.9 — CRITICAL) — close the executed
// dead-end. A counter-signed CHAIN lease lands at 'fully_executed' with (a) NO
// AI abstraction ever (chain request leases are created status:'Ready', never
// processed) and (b) no code path to 'active' — so it was invisible to the
// active-lease cap, amendment matching, unlock, and ASC-842 reports. The new
// process_lease 'finalize' mode is the human-triggered last step: abstract the
// stored counter-signed document into the PRIMARY term columns, recompute
// financials, and activate + model-lock the lease.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('P1-5 — process_lease finalize mode', () => {
  const pl = read('supabase/functions/process_lease/index.ts');
  const block = pl.slice(pl.indexOf("extractionMode === 'finalize'"), pl.indexOf('if (!file) {'));

  it('is keyed by leaseId and requires a fully_executed lease', () => {
    expect(block).toMatch(/leaseId is required for finalize mode/);
    expect(block).toContain("finLease.lifecycle_status !== 'fully_executed'");
  });
  it('is idempotent — a lease already active is a no-op', () => {
    expect(block).toMatch(/lifecycle_status === 'active'[\s\S]{0,120}alreadyActive: true/);
  });
  it('reads the stored counter-signed doc (no multipart file) and abstracts it', () => {
    expect(block).toContain("document_type', 'fully_executed_counterparty_returned'");
    expect(block).toMatch(/storage[\s\S]{0,40}from\('lease-documents'\)[\s\S]{0,40}\.download/);
    expect(block).toContain('extractLeaseDataWithClaude');
  });
  it('writes the PRIMARY term columns (not the executed_* parallel set) + calc_*', () => {
    // Primary columns the active-lease consumers + review UI read.
    expect(block).toMatch(/current_monthly_rent:\s+extractValue\(finData\.current_monthly_rent\)/);
    expect(block).toContain('extracted_json:         finData');
    expect(block).toContain('calc_total_commitment');
    // NOT the executed_* variance columns (those are the legacy executed mode).
    expect(block).not.toContain('executed_extracted_json');
  });
  it('activates + model-locks in one UPDATE and writes the convention status_change row', () => {
    expect(block).toMatch(/lifecycle_status:\s+'active'/);
    expect(block).toMatch(/model_locked:\s+true/);
    expect(block).toMatch(/status_changed_at:\s+finNow/);
    expect(block).toMatch(/from_status: 'fully_executed'[\s\S]{0,120}to_status: 'active'/);
    expect(block).toMatch(/routing_path: 'chain'/);
  });
  it('gates on liveness + AI consent + monthly quota before the paid Opus pass', () => {
    expect(block).toContain('checkWorkspaceLive');
    // P1-5 security review (HIGH): finalize must honor revoked AI-processing
    // consent, like the pipeline/executed paths.
    expect(block).toContain('assertAiConsent');
    expect(block).toContain("reason: 'ai_consent_required'");
    expect(block).toMatch(/checkProcessingQuota\([\s\S]{0,120}isNewLease: false/);
  });
});

describe('P1-5 — LeaseReview finalize action', () => {
  const lr = read('src/pages/app/LeaseReview.tsx');
  it('a fully_executed lease offers "Finalize & activate" invoking finalize mode', () => {
    expect(lr).toMatch(/lifecycleStatus === 'fully_executed'[\s\S]{0,220}finalize_activate/);
    expect(lr).toMatch(/formData\.append\('extractionMode', 'finalize'\)/);
    expect(lr).toContain('handleFinalize');
  });
  it('replaced the dead handleRunAbstraction hook (which minted a new lease)', () => {
    expect(lr).not.toMatch(/const handleRunAbstraction/);
  });
});
