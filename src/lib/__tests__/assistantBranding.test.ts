import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const en = JSON.parse(read('src/locales/en/common.json'));
const es = JSON.parse(read('src/locales/es/common.json'));

// Fresh-eyes fix: the embedded assistant is branded "Leo" in every user-facing
// string — never "Claude" (model selection is never user-facing, Hard Rule #3).
// BUT the legal sub-processor disclosure must still name "Anthropic" (the real
// data processor). This guards both directions at once: the Leo rename did not
// leak "Claude" into UI copy, AND an over-eager global rename did not scrub
// "Anthropic" out of the sub-processor disclosure.
//
// NOTE (spec key-path reconciliation): the driving task named these keys as
// subscription.features.ai_assistant / privacy_ai_desc /
// integrations.anthropic_provider, but the actual locale paths are
// plan.feature.ai_assistant / account.privacy_ai_desc /
// privacy.section3.anthropic_provider. Pinned against the real keys so the test
// asserts against strings that actually ship.

const dig = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);

// Leo-branded UI strings — must contain "Leo", must NOT contain "Claude".
const ASSISTANT_KEYS = [
  'assistant.title',
  'assistant.empty_prompt',
  'plan.feature.ai_assistant',
  'lease_audit.upgrade_desc',
];

// Legal sub-processor disclosure — must still name "Anthropic".
const SUBPROCESSOR_KEYS = [
  'account.privacy_ai_desc',
  'privacy.section3.anthropic_provider',
];

describe('assistant branding — "Leo" in UI, "Anthropic" in the sub-processor disclosure', () => {
  for (const [label, locale] of [['en', en], ['es', es]] as const) {
    describe(label, () => {
      for (const key of ASSISTANT_KEYS) {
        it(`${key} is Leo-branded and never says "Claude"`, () => {
          const val = dig(locale, key);
          expect(typeof val, `${key} should be a string`).toBe('string');
          expect(val as string).toContain('Leo');
          expect(val as string).not.toMatch(/Claude/);
        });
      }
      for (const key of SUBPROCESSOR_KEYS) {
        it(`${key} still names Anthropic`, () => {
          const val = dig(locale, key);
          expect(typeof val, `${key} should be a string`).toBe('string');
          expect(val as string).toContain('Anthropic');
        });
      }
    });
  }
});
