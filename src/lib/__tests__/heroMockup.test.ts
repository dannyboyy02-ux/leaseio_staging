import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// #176 — the landing hero's empty "demo coming" placeholder is replaced with
// HeroMockup: a static, aria-hidden, Tailwind-only miniature of the review
// workbench. These pins keep it decorative (no focusable elements inside
// aria-hidden), i18n-routed, and keep the orphaned demo_coming key deleted.

const MOCKUP_KEYS = [
  'approve',
  'conf_commencement',
  'conf_renewal',
  'conf_rent',
  'doc_name',
  'extracted_note',
  'field_commencement',
  'field_renewal',
  'field_rent',
  'status',
  'value_commencement',
  'value_renewal',
  'value_rent',
];

describe('HeroSection — placeholder replaced by HeroMockup', () => {
  const src = read('src/components/landing/HeroSection.tsx');

  it('no longer references the deleted demo_coming key', () => {
    expect(src).not.toContain('demo_coming');
  });

  it('renders the HeroMockup component', () => {
    expect(src).toContain('<HeroMockup');
    expect(src).toMatch(/import\s*\{\s*HeroMockup\s*\}\s*from\s*'\.\/HeroMockup'/);
  });
});

describe('HeroMockup — decorative, aria-hidden, i18n-routed', () => {
  const src = read('src/components/landing/HeroMockup.tsx');
  const bodyStart = src.indexOf('export function HeroMockup');
  const body = src.slice(bodyStart);

  it('component body exists', () => {
    expect(bodyStart).toBeGreaterThan(-1);
  });

  it('root container carries aria-hidden="true"', () => {
    const firstDiv = body.indexOf('<div');
    const rootTag = body.slice(firstDiv, body.indexOf('>', firstDiv) + 1);
    expect(rootTag).toContain('aria-hidden="true"');
  });

  it('contains zero interactive/focusable elements', () => {
    for (const forbidden of ['<button', '<Button', '<a ', '<Link', 'onClick']) {
      expect(body, `decorative mockup must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('routes all visible strings through landing.hero.mockup.* keys', () => {
    expect(body).toContain("t('landing.hero.mockup.");
  });
});

describe('locale files — mockup keys present, demo_coming deleted', () => {
  const en = JSON.parse(read('src/locales/en/common.json'));
  const es = JSON.parse(read('src/locales/es/common.json'));

  it('landing.hero.mockup has the identical 13-key set in both locales', () => {
    const enKeys = Object.keys(en.landing.hero.mockup ?? {}).sort();
    const esKeys = Object.keys(es.landing.hero.mockup ?? {}).sort();
    expect(enKeys).toEqual(MOCKUP_KEYS);
    expect(esKeys).toEqual(MOCKUP_KEYS);
  });

  it('every mockup value is a non-empty string in both locales', () => {
    for (const key of MOCKUP_KEYS) {
      expect(typeof en.landing.hero.mockup[key]).toBe('string');
      expect(en.landing.hero.mockup[key].length).toBeGreaterThan(0);
      expect(typeof es.landing.hero.mockup[key]).toBe('string');
      expect(es.landing.hero.mockup[key].length).toBeGreaterThan(0);
    }
  });

  it('landing.hero.demo_coming is absent from both locales', () => {
    expect(en.landing.hero).not.toHaveProperty('demo_coming');
    expect(es.landing.hero).not.toHaveProperty('demo_coming');
  });
});
