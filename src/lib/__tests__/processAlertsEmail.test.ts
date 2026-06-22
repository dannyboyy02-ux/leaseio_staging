import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// process-alerts email delivery — emails each newly-created alert_rules
// notification to the lease owner (in-app rail previously had no email path).

const root = process.cwd();
const src = readFileSync(
  join(root, 'supabase/functions/process-alerts/index.ts'),
  'utf8',
);

describe('process-alerts → email the lease owner', () => {
  it('carries the lease owner through evaluate and strips it before the notifications insert', () => {
    expect(src).toContain('type EmailableAlert = NotificationRow & { ownerId: string | null }');
    expect(src).toContain('ownerId: lease.user_id');
    // ownerId is local-only — must NOT be inserted into the notifications table.
    expect(src).toMatch(/alerts\.map\(\(\{ ownerId: _ownerId, \.\.\.row \}\) => row\)/);
    expect(src).toContain('user_id') /* added to the leases select + Lease type */;
  });

  it('resolves the owner email + respects the email_notifications_enabled opt-out (default on)', () => {
    expect(src).toContain("from(\"profiles\")");
    expect(src).toContain('email_notifications_enabled');
    expect(src).toContain('profile.email_notifications_enabled === false'); // opt-out skip
    expect(src).toContain('if (!profile?.email) continue');
  });

  it('sends via Resend with the alerts FROM, and is best-effort (never throws/fails the cron)', () => {
    expect(src).toContain('new Resend(resendApiKey)');
    expect(src).toContain('RESEND_ALERTS_FROM_EMAIL');
    expect(src).toContain('try {');
    expect(src).toContain('catch (e)');
    // No RESEND_API_KEY → skip emails, still return (don't crash the cron).
    expect(src).toContain('RESEND_API_KEY unset');
    // Hard rule #9: a profiles-lookup error is logged + skipped, not silent.
    expect(src).toContain('error: profilesErr');
    expect(src).toContain('profiles lookup failed');
  });

  it('only emails newly-created alerts (reuses the wasRecentlyAlerted dedup — no re-email)', () => {
    // The alerts passed to sendAlertEmails are the evaluate() output, which is
    // already gated by wasRecentlyAlerted; the email loop adds no second insert.
    expect(src).toContain('const emailed = await sendAlertEmails(supabase, alerts)');
    expect(src).toContain('wasRecentlyAlerted');
  });

  it('escapes user-controlled title/body in the email HTML', () => {
    expect(src).toContain('escapeHtml(alert.title)');
    expect(src).toContain('escapeHtml(alert.body)');
  });
});
