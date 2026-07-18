/**
 * Security deposit is stored as free TEXT (the AI extracts whatever the lease
 * says, and users can enter anything). Return a numeric amount ONLY when the
 * ENTIRE value is a single, unambiguous currency amount — optional leading `$`,
 * thousands separators, and up to two decimals.
 *
 * Anything else — "$5,000 (2 months)", "two months' rent", "$5,000 + $500
 * cleaning" — returns null so the caller shows the raw text verbatim.
 *
 * The old formatter stripped every non-digit character and `Number()`d the
 * result, so "$5,000 (2 months)" became "50002" → a confidently-formatted
 * **$50,002.00** — an order-of-magnitude-wrong figure a finance user could
 * cite in a reconciliation. We now never fabricate: if it isn't a clean single
 * amount, we don't format it.
 */
export function parseSingleCurrencyAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // ^ optional $, optional space, then either grouped thousands (1,234,567)
  // or a bare run of digits, then optional .dd — and nothing else.
  const m = raw.trim().match(/^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/);
  if (!m) return null;
  const n = Number(`${m[1].replace(/,/g, '')}${m[2] ?? ''}`);
  return Number.isFinite(n) && n > 0 ? n : null;
}
