import { LandingNav } from '@/components/landing/LandingNav';
import { FooterSection } from '@/components/landing/FooterSection';
import { useAppTranslation } from '@/hooks/useAppTranslation';

export default function Privacy() {
  const { t, language } = useAppTranslation();

  return (
    <div className="min-h-screen bg-background">
      <LandingNav />
      <main className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="font-display text-4xl font-bold text-foreground mb-8">
            {t('privacy.title')}
          </h1>
          
          <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-muted-foreground">
            <p className="text-lg">
              {t('privacy.last_updated')}{' '}
              {new Date().toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('privacy.section1.title')}
              </h2>
              <p>
                {t('privacy.section1.paragraph1')}
              </p>
              <p>
                {t('privacy.section1.paragraph2')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('privacy.section2.title')}
              </h2>
              <p>{t('privacy.section2.intro')}</p>
              <ul className="list-disc pl-6 space-y-2">
                <li>{t('privacy.section2.bullet1')}</li>
                <li>{t('privacy.section2.bullet2')}</li>
                <li>{t('privacy.section2.bullet3')}</li>
                <li>{t('privacy.section2.bullet4')}</li>
                <li>{t('privacy.section2.bullet5')}</li>
              </ul>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('privacy.section3.title')}
              </h2>
              <p>
                {t('privacy.section3.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('privacy.section4.title')}
              </h2>
              <p>
                {t('privacy.section4.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('privacy.section5.title')}
              </h2>
              <p>
                {t('privacy.section5.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('privacy.section6.title')}
              </h2>
              <p>
                {t('privacy.section6.paragraph1')}{' '}
                <a href="mailto:privacy@leaseio.com" className="text-primary hover:underline">
                  {t('privacy.section6.email')}
                </a>
              </p>
            </section>
          </div>
        </div>
      </main>
      <FooterSection />
    </div>
  );
}
