// Locale-aware formatting utilities
import { format, formatDistance, formatRelative, type Locale } from 'date-fns';
import { es, enUS } from 'date-fns/locale';

export type SupportedLocale = 'en' | 'es';

const LOCALE_MAP: Record<SupportedLocale, Locale> = {
  en: enUS,
  es: es,
};

/**
 * Get the date-fns locale object for a language
 */
export function getDateLocale(language: SupportedLocale): Locale {
  return LOCALE_MAP[language] || enUS;
}

/**
 * Format a date with locale-aware formatting
 */
export function formatDate(
  date: Date | string | null | undefined,
  formatStr: string,
  language: SupportedLocale
): string {
  if (!date) return '—';
  
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(dateObj.getTime())) return '—';
    
    const locale = getDateLocale(language);
    return format(dateObj, formatStr, { locale });
  } catch {
    return typeof date === 'string' ? date : '—';
  }
}

/**
 * Format a relative date (e.g., "3 days ago")
 */
export function formatRelativeDate(
  date: Date | string | null | undefined,
  baseDate: Date,
  language: SupportedLocale
): string {
  if (!date) return '—';
  
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(dateObj.getTime())) return '—';
    
    const locale = getDateLocale(language);
    return formatRelative(dateObj, baseDate, { locale });
  } catch {
    return '—';
  }
}

/**
 * Format a distance between dates (e.g., "about 2 hours")
 */
export function formatDateDistance(
  date: Date | string | null | undefined,
  baseDate: Date,
  language: SupportedLocale,
  options?: { addSuffix?: boolean }
): string {
  if (!date) return '—';
  
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    if (isNaN(dateObj.getTime())) return '—';
    
    const locale = getDateLocale(language);
    return formatDistance(dateObj, baseDate, { locale, ...options });
  } catch {
    return '—';
  }
}

/**
 * Format currency with locale-aware formatting
 */
export function formatCurrency(
  amount: number | null | undefined,
  language: SupportedLocale,
  currency: string = 'USD'
): string {
  if (amount === null || amount === undefined) return '—';
  
  const localeString = language === 'es' ? 'es-419' : 'en-US';
  return new Intl.NumberFormat(localeString, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format number with locale-aware formatting
 */
export function formatNumber(
  num: number | null | undefined,
  language: SupportedLocale
): string {
  if (num === null || num === undefined) return '—';
  
  const localeString = language === 'es' ? 'es-419' : 'en-US';
  return new Intl.NumberFormat(localeString).format(num);
}

/**
 * Format a percentage with locale-aware formatting
 */
export function formatPercent(
  value: number | null | undefined,
  language: SupportedLocale,
  decimals: number = 0
): string {
  if (value === null || value === undefined) return '—';
  
  const localeString = language === 'es' ? 'es-419' : 'en-US';
  return new Intl.NumberFormat(localeString, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value / 100);
}

/**
 * Format a short date (e.g., "Jan 15, 2024")
 */
export function formatShortDate(
  date: Date | string | null | undefined,
  language: SupportedLocale
): string {
  return formatDate(date, 'PP', language);
}

/**
 * Format a long date (e.g., "January 15, 2024")
 */
export function formatLongDate(
  date: Date | string | null | undefined,
  language: SupportedLocale
): string {
  return formatDate(date, 'PPPP', language);
}

/**
 * Format a date with time (e.g., "Jan 15, 2024, 3:45 PM")
 */
export function formatDateTime(
  date: Date | string | null | undefined,
  language: SupportedLocale
): string {
  return formatDate(date, 'PPp', language);
}

/**
 * Format month and year (e.g., "January 2024")
 */
export function formatMonthYear(
  date: Date | string | null | undefined,
  language: SupportedLocale
): string {
  return formatDate(date, 'MMMM yyyy', language);
}
