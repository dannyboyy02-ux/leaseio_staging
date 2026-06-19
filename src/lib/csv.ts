/**
 * Escape a value for safe inclusion in a CSV cell. Two protections:
 *
 *  1. **Formula injection (#118 / OWASP).** A cell whose text starts with
 *     `=`, `+`, `-`, `@` (or a tab / carriage return) is executed by Excel and
 *     Google Sheets — e.g. `=HYPERLINK("http://evil")` or `=cmd|'/c calc'!A1`.
 *     Lease exports carry user- and AI-sourced fields (tenant / landlord names,
 *     addresses) that an attacker can seed with such a payload. We neutralize
 *     by prefixing a single quote, which spreadsheets render as plain text.
 *  2. **Delimiter / quote / newline (RFC 4180).** Quote fields containing a
 *     comma, double-quote, or newline so they don't shift columns.
 *
 * Use this for EVERY CSV export cell.
 */
export function escapeCsvCell(val: unknown): string {
  let str = val == null ? '' : String(val);
  // Formula-injection guard first, so the prefixed value is then quoted if needed.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
