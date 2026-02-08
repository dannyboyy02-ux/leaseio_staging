import { useTranslation } from 'react-i18next';
import { LANGUAGE_KEY } from '@/i18n';

type SupportedLanguage = 'en' | 'es';

function normalizeLanguage(lng?: string): SupportedLanguage {
  if (lng && lng.toLowerCase().startsWith('es')) {
    return 'es';
  }
  return 'en';
}

export function useAppTranslation() {
  const { t, i18n } = useTranslation('common');

  const changeLanguage = (lang: SupportedLanguage) => {
    i18n.changeLanguage(lang);
    localStorage.setItem(LANGUAGE_KEY, lang);
  };

  const language = normalizeLanguage(i18n.resolvedLanguage || i18n.language);

  return {
    t,
    i18n,
    lang: language,
    language,
    changeLanguage,
  };
}
