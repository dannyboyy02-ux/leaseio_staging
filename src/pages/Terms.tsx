import { LandingNav } from '@/components/landing/LandingNav';
import { FooterSection } from '@/components/landing/FooterSection';
import { useAppTranslation } from '@/hooks/useAppTranslation';

export default function Terms() {
  const { t, language } = useAppTranslation();

  return (
    <div className="min-h-screen bg-background">
      <LandingNav />
      <main className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="font-display text-4xl font-bold text-foreground mb-8">
            {t('terms.title')}
          </h1>
          
          <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-muted-foreground">
            <p className="text-lg">
              {t('terms.last_updated')}{' '}
              {new Date().toLocaleDateString(language === 'es' ? 'es-419' : 'en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </p>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section1.title')}
              </h2>
              <p>
                {t('terms.section1.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section2.title')}
              </h2>
              <p>
                {t('terms.section2.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section3.title')}
              </h2>
              <p>
                {t('terms.section3.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section4.title')}
              </h2>
              <p>
                {t('terms.section4.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section5.title')}
              </h2>
              <p>
                {t('terms.section5.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section6.title')}
              </h2>
              <p>
                {t('terms.section6.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section7.title')}
              </h2>
              <p>
                {t('terms.section7.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('terms.section8.title')}
              </h2>
              <p>
                {t('terms.section8.paragraph1')}{' '}
                <a href="mailto:legal@leaseio.com" className="text-primary hover:underline">
                  {t('terms.section8.email')}
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
