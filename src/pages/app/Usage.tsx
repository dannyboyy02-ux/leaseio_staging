import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { UsageContent } from './UsageContent';

/**
 * Standalone Usage route at /app/usage. Kept for back-compat / direct linking;
 * the same content is also rendered as a tab inside Settings.
 */
export default function Usage() {
  const { t } = useAppTranslation();
  return (
    <AppLayout>
      <AppHeader title={t('usage.title')} subtitle={t('usage.subtitle')} />
      <div className="p-6 max-w-4xl">
        <UsageContent showHeader />
      </div>
    </AppLayout>
  );
}
