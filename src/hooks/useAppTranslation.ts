import { useTranslation } from 'react-i18next';
import { LANGUAGE_KEY } from '@/i18n';

export function useAppTranslation() {
  const { t, i18n } = useTranslation('common');

  const changeLanguage = (lang: 'en' | 'es') => {
    i18n.changeLanguage(lang);
    localStorage.setItem(LANGUAGE_KEY, lang);
  };

  return {
    t,
    i18n,
    lang: i18n.language as 'en' | 'es',
    changeLanguage,
  };
}
