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
 * Format currency with locale
 */
export function formatLocalizedCurrency(
  amount: number | null | undefined,
  language: SupportedLocale,
  currency: string = 'USD'
): string {
  if (amount === null || amount === undefined) return '—';
  
  const locale = LOCALE_MAP[language];
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
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
