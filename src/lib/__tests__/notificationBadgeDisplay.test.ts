import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const src = read('src/pages/Notifications.tsx');

// Fresh-eyes fix: fanned-out approval/delegation notification rows write
// title === body (both = the message), so the grey body used to duplicate the
// title verbatim. Now the body only renders when it differs from the title.
// And unmapped notify_<type> alerts resolve a LOCALIZED badge via a
// notifications.alert_type.<type> template (with a humanized, de-prefixed
// defaultValue) instead of showing the raw enum string.

describe('Notifications.tsx — badge + body display', () => {
  it('renders the body only when it differs from the title', () => {
    expect(src).toContain('alert.body.trim() !== alert.title.trim()');
  });

  it('resolves the badge via the notifications.alert_type template + a defaultValue', () => {
    expect(src).toContain('`notifications.alert_type.${alert.alert_type}`');
    expect(src).toContain('defaultValue:');
  });
});

describe('notifications.alert_type covers the fanned notification types', () => {
  const en = JSON.parse(read('src/locales/en/common.json'));
  const at = en.notifications?.alert_type ?? {};

  for (const key of [
    'signator_review_required',
    'notify_chain_step_users',
    'notify_submitter_concept_cleared',
    'execution_owner_assigned',
    'counter_signature_received',
  ]) {
    it(`has a localized label for ${key}`, () => {
      expect(typeof at[key]).toBe('string');
      expect((at[key] as string).trim()).not.toBe('');
    });
  }
});
