#!/usr/bin/env node
/**
 * Highlight matcher synthetic-page harness.
 *
 * For each scalar field in extracted_json, build a synthetic page haystack
 * by concatenating the source_text of every field that lives on the same
 * page. Then run the SAME matcher logic as src/components/leases/PdfViewer.tsx
 * against the field's (value, source_text) candidates.
 *
 * This isn't a full pdfjs E2E (RLS blocks anonymous PDF access), but
 * since Opus extracts source_text verbatim from the PDF, the synthetic
 * haystack mirrors what pdfjs would return for the candidate-side logic
 * we're trying to validate (date conversion, paraphrase fallback, etc).
 *
 * Usage:  node scripts/test-highlight-matcher.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Replicas of helpers from PdfViewer.tsx — kept in sync manually
// ============================================================

function normalizeChar(c) {
  const lower = c.toLowerCase();
  if (/[\p{L}\p{N}]/u.test(lower)) return lower;
  return ' ';
}

function normalizeForMatch(s) {
  let out = '';
  for (const c of s) out += normalizeChar(c);
  return out.replace(/\s+/g, ' ').trim();
}

function findLongestPhrase(haystack, target, minChars = 12) {
  if (target.length < minChars) return null;
  for (let len = target.length; len >= minChars; len -= Math.max(1, Math.floor(len / 16))) {
    for (let i = 0; i + len <= target.length; i++) {
      const sub = target.substring(i, i + len);
      const pos = haystack.indexOf(sub);
      if (pos !== -1) return { start: pos, end: pos + len };
    }
  }
  return null;
}

function expandCandidate(c) {
  const out = new Set([c]);
  if (/^-?\d+(\.\d+)?$/.test(c.trim())) {
    const n = Number(c);
    if (Number.isFinite(n)) {
      out.add(n.toLocaleString('en-US'));
      out.add(String(Math.round(n)));
      out.add(Math.round(n).toLocaleString('en-US'));
    }
  }
  const digitsOnly = c.replace(/[^\d]/g, '');
  if (digitsOnly.length >= 3) out.add(digitsOnly);
  return Array.from(out).filter((s) => s.trim().length > 0);
}

function isPurelyNumeric(s) {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return /^[$£€]?[\d,]+(?:\.\d+)?%?$/.test(trimmed);
}

// ============================================================
// Matcher — single-haystack version of what PdfViewer does
// ============================================================

function buildHaystacks(text) {
  // Treat the whole text as one big "item" for testing.
  let combined = '';
  let lastWasSpace = true;
  for (const c of text) {
    const norm = normalizeChar(c);
    if (norm === ' ' && lastWasSpace) continue;
    combined += norm;
    lastWasSpace = norm === ' ';
  }
  combined = combined.trim();

  let combinedDigits = '';
  for (const c of text) if (/\d/.test(c)) combinedDigits += c;

  return { combined, combinedDigits };
}

function matchOnHaystack(text, candidates) {
  const cleaned = candidates.filter((c) => typeof c === 'string' && c.trim().length > 0);
  if (cleaned.length === 0) return { kind: 'no-candidates' };

  const h = buildHaystacks(text);

  // Phase 1: exact text match across all candidates and variants.
  for (const candidate of cleaned) {
    for (const variant of expandCandidate(candidate)) {
      const normalized = normalizeForMatch(variant);
      if (normalized.length < 3) continue;
      const pos = h.combined.indexOf(normalized);
      if (pos !== -1) {
        return { kind: 'exact-text', candidate, variant, normalizedTarget: normalized, matchedNormalized: h.combined.slice(pos, pos + normalized.length) };
      }
    }
  }

  // Phase 2: digits-only haystack, only for purely-numeric candidates.
  for (const candidate of cleaned) {
    if (!isPurelyNumeric(candidate)) continue;
    const variantDigits = candidate.replace(/[^\d]/g, '');
    if (variantDigits.length < 3) continue;
    const dpos = h.combinedDigits.indexOf(variantDigits);
    if (dpos !== -1) {
      return { kind: 'digits-only', candidate, variant: variantDigits };
    }
  }

  // Phase 3: longest-substring fallback on last candidate (source_text).
  const fallbackSrc = cleaned[cleaned.length - 1];
  const fallbackTarget = normalizeForMatch(fallbackSrc);
  const minFallbackLen = Math.max(20, Math.floor(fallbackTarget.length * 0.5));
  const longest = findLongestPhrase(h.combined, fallbackTarget, minFallbackLen);
  if (longest) {
    return {
      kind: 'longest-substring',
      candidate: fallbackSrc,
      matchedNormalized: h.combined.slice(longest.start, longest.end),
    };
  }

  return { kind: 'not-found', candidate: cleaned[0] };
}

// ============================================================
// Main
// ============================================================

function valueAsString(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim().length > 0) return v;
  return undefined;
}

const ej = JSON.parse(readFileSync(join(__dirname, '.test-extracted.json'), 'utf8'));

const fields = [
  'landlord_name',
  'tenant_name',
  'property_address',
  'lease_start',
  'lease_end',
  'square_footage',
  'current_monthly_rent',
  'base_rent_amount',
  'base_rent_frequency',
  'security_deposit',
  'rent_commencement_date',
  'renewal_options',
  'escalation_clauses',
  'termination_clauses',
  'rent_escalation_type',
];

// Build per-page synthetic haystacks: concat all source_texts of fields on the page.
const pages = new Map(); // page -> [source_text, ...]
for (const fid of fields) {
  const f = ej[fid];
  if (!f || !f.page || !f.source_text) continue;
  if (!pages.has(f.page)) pages.set(f.page, []);
  pages.get(f.page).push(f.source_text);
}
const pageText = new Map();
for (const [p, texts] of pages.entries()) pageText.set(p, texts.join(' '));

// Run matcher per field
const results = [];
for (const fid of fields) {
  const f = ej[fid];
  if (!f) { results.push({ fid, status: 'no-data' }); continue; }
  const text = pageText.get(f.page);
  if (!text) { results.push({ fid, status: 'no-page-text' }); continue; }
  const value = valueAsString(f.value);
  const candidates = [value, f.source_text].filter(Boolean);
  const result = matchOnHaystack(text, candidates);
  results.push({ fid, page: f.page, value: f.value, source_text: f.source_text, ...result });
}

// Print report
console.log('='.repeat(80));
console.log('HIGHLIGHT MATCHER REPORT (synthetic haystacks built from source_text)');
console.log('='.repeat(80));

const tagFor = (k) =>
  k === 'exact-text' ? '✓ EXACT' :
  k === 'digits-only' ? '◉ DIGITS' :
  k === 'longest-substring' ? '~ FALLBK' :
  k === 'not-found' ? '✗ MISS' : '?';

for (const r of results) {
  console.log(`\n${tagFor(r.kind).padEnd(10)} ${r.fid} (page ${r.page})`);
  console.log(`  value:    ${typeof r.value === 'string' ? `"${r.value.slice(0, 90)}${r.value.length > 90 ? '…' : ''}"` : r.value}`);
  console.log(`  source:   "${(r.source_text ?? '').slice(0, 90)}${(r.source_text ?? '').length > 90 ? '…' : ''}"`);
  if (r.kind === 'exact-text') {
    console.log(`  via:      candidate="${r.candidate.slice(0, 60)}…", variant="${r.variant.slice(0, 60)}…"`);
  }
  if (r.matchedNormalized) {
    console.log(`  matched:  "${r.matchedNormalized.slice(0, 90)}${r.matchedNormalized.length > 90 ? '…' : ''}"`);
  }
}

// Summary
console.log('\n' + '='.repeat(80));
const summary = results.reduce((acc, r) => { acc[r.kind || 'other'] = (acc[r.kind || 'other'] || 0) + 1; return acc; }, {});
console.log('SUMMARY:', JSON.stringify(summary));
console.log('='.repeat(80));

// Identify the cases that need explicit handling
console.log('\nFIELDS NEEDING WORK:');
for (const r of results) {
  if (r.kind === 'not-found' || r.kind === 'longest-substring') {
    console.log(`  - ${r.fid}: ${r.kind}`);
  }
}
