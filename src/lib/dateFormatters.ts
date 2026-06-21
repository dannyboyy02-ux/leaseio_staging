// Locale-aware date formatting utilities

export type SupportedLocale = 'en' | 'es';

const LOCALE_MAP: Record<SupportedLocale, string> = {
  en: 'en-US',
  es: 'es-419', // Latin American Spanish
};

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date-only ISO strings (`YYYY-MM-DD`) are parsed by `new Date()` as UTC
 * midnight, which renders as the previous day in any timezone west of UTC.
 * This helper builds a local-zone Date instead so rendering matches the
 * literal Y-M-D the database stored. Datetime strings keep the default path.
 */
export function parseToLocalDate(input: string | Date): Date {
  if (typeof input !== 'string') return input;
  if (ISO_DATE_ONLY.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(input);
}

/**
 * Format a date with locale-aware month names
 */
export function formatLocalizedDate(
  dateStr: string | Date | null | undefined,
  language: SupportedLocale,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!dateStr) return '—';

  try {
    const date = parseToLocalDate(dateStr);
    if (isNaN(date.getTime())) return '—';
    
    const locale = LOCALE_MAP[language];
    const defaultOptions: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    };
    
    return new Intl.DateTimeFormat(locale, options || defaultOptions).format(date);
  } catch {
    return typeof dateStr === 'string' ? dateStr : '—';
  }
}

/**
 * Format a date with full month name
 */
export function formatLocalizedDateLong(
  dateStr: string | Date | null | undefined,
  language: SupportedLocale
): string {
  return formatLocalizedDate(dateStr, language, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a date with weekday
 */
export function formatLocalizedDateWithWeekday(
  dateStr: string | Date | null | undefined,
  language: SupportedLocale
): string {
  return formatLocalizedDate(dateStr, language, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format month and year only
 */
export function formatLocalizedMonthYear(
  dateStr: string | Date | null | undefined,
  language: SupportedLocale
): string {
  return formatLocalizedDate(dateStr, language, {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Format time with locale
 */
export function formatLocalizedDateTime(
  dateStr: string | Date | null | undefined,
  language: SupportedLocale
): string {
  return formatLocalizedDate(dateStr, language, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Format currency with locale.
 *
 * Whole-dollars by default ($1,234) — the dominant convention across the app.
 * Pass `{ cents: true }` for line-item surfaces (rent schedules, variance
 * tables) that need $1,234.56. Pass `{ compact: true }` for chart axes/labels
 * that want abbreviated values ($1.2K, $3.4M). USD by default (USD-only
 * product), but `{ currency }` overrides it for the rare parameterized case
 * (e.g. Stripe invoice currency).
 *
 * This is the single canonical currency formatter — components must not roll
 * their own `Intl.NumberFormat` (doing so silently drops locale awareness,
 * which is how Spanish users ended up seeing en-US-formatted money).
 */
export function formatLocalizedCurrency(
  amount: number | null | undefined,
  language: SupportedLocale,
  options?: { cents?: boolean; compact?: boolean; currency?: string }
): string {
  if (amount === null || amount === undefined) return '—';

  const locale = LOCALE_MAP[language];
  const currency = options?.currency ?? 'USD';

  if (options?.compact) {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(amount);
  }

  const fractionDigits = options?.cents ? 2 : 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

/**
 * Format a percentage with locale (value is a 0–100 percent, not a 0–1 ratio).
 */
export function formatLocalizedPercent(
  value: number | null | undefined,
  language: SupportedLocale,
  decimals: number = 1
): string {
  if (value === null || value === undefined) return '—';

  const locale = LOCALE_MAP[language];
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value) + '%';
}

/**
 * Format number with locale
 */
export function formatLocalizedNumber(
  num: number | null | undefined,
  language: SupportedLocale
): string {
  if (num === null || num === undefined) return '—';

  const locale = LOCALE_MAP[language];
  return new Intl.NumberFormat(locale).format(num);
}
