// ─────────────────────────────────────────────────────────────────────────
// Bounding helpers for the ai-assistant context packet (audit F1).
//
// buildLeaseContext (ai-assistant/index.ts) concatenates a handful of free-text
// fields extracted from each lease — termination / escalation / renewal clauses,
// security-deposit text, party names, the risk list — into the system prompt.
// Those fields are unbounded extraction output, so a large portfolio of leases
// with verbose clauses could balloon the prompt and the per-call token cost in
// an unpredictable way. (Note: the FULL extracted_json blob is fetched from the
// DB but is NOT sent to the model — only the curated fields below reach the
// prompt — so the original audit framing of "full extracted_json per lease"
// overstated it; the real risk is these unbounded text fields.) These helpers
// cap each field to a predictable length, so prompt size is bounded by
// (lease count × a fixed per-lease budget).
//
// Pure + dependency-free on purpose: the edge function runs on Deno (no unit
// harness in this repo), but this module is importable from the Node (vitest)
// harness so the bounding behavior gets real regression coverage.
// ─────────────────────────────────────────────────────────────────────────

/** Max chars for a free-text clause field (termination / escalation / renewal / deposit). */
export const FIELD_MAX = 280;
/** Max chars for short identifiers (lease name, party names, address). */
export const NAME_MAX = 120;
/** Max risks listed per lease before collapsing the tail to "+N more". */
export const MAX_RISKS = 8;

/** Severity ordering so the risk cap drops the LEAST important risks, not
 *  whatever happened to land past the cap in document-discovery order. Lower
 *  rank = more important = survives the cap. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 0,
  medium: 1,
  med: 1,
  low: 2,
};

/**
 * Rank a severity for the cap. `extracted_json.risks` is the raw model blob and
 * is NOT CHECK-constrained (only the separate risks table is), so an
 * off-vocabulary value can reach here — the extraction prompt itself models
 * informal labels like "MEDIUM-HIGH". Two deliberate defaults:
 *   - a falsy/missing severity (no signal) sorts LAST (rank 3), matching how the
 *     renderer labels it a generic "RISK";
 *   - a PRESENT-but-unrecognized severity fails SAFE to rank 0 (surfaced), so a
 *     mis-spelled-but-serious risk is never the first thing hidden under the cap.
 */
function severityRank(value: unknown): number {
  if (!value) return 3;
  const known = SEVERITY_RANK[String(value).toLowerCase().trim()];
  return known !== undefined ? known : 0;
}

/**
 * Trim a value to a bounded string. Returns null for empty/missing input so
 * callers can fall back to their own "not stated" / "unknown" copy. Non-strings
 * are coerced (an extraction field is occasionally an object or number).
 */
export function truncate(value: unknown, max: number): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

/**
 * Format a bounded risk list: the first `max` entries as "SEVERITY - title"
 * (title itself bounded), with a "+N more" tail when the list is longer.
 * Returns null when there are no risks, so the caller can print "none".
 */
export function summarizeRisks(
  risks: unknown,
  max: number = MAX_RISKS,
): string | null {
  if (!Array.isArray(risks) || risks.length === 0) return null;
  // Sort by severity (stable for equal ranks) so the cap keeps the highest-
  // severity risks. The stored array has no inherent ordering, so a naive
  // slice could silently drop a HIGH risk while keeping LOWs (audit F1 HIGH).
  const ordered = [...risks].sort((a, b) => severityRank(a?.severity) - severityRank(b?.severity));
  const shown = ordered.slice(0, max).map((r) => {
    const sev = r?.severity ? String(r.severity).toUpperCase() : 'RISK';
    const title = truncate(r?.title, NAME_MAX) ?? 'untitled';
    return `${sev} - ${title}`;
  });
  const extra = ordered.length - shown.length;
  return extra > 0 ? `${shown.join('; ')}; +${extra} more` : shown.join('; ');
}
