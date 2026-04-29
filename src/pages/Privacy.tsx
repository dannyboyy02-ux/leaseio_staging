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
              <p>{t('privacy.section3.intro')}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border border-border rounded-md">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left p-3 font-semibold text-foreground">{t('privacy.section3.header_provider')}</th>
                      <th className="text-left p-3 font-semibold text-foreground">{t('privacy.section3.header_purpose')}</th>
                      <th className="text-left p-3 font-semibold text-foreground">{t('privacy.section3.header_data')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {['anthropic', 'azure', 'supabase', 'stripe', 'resend', 'vercel'].map((key) => (
                      <tr key={key} className="border-t border-border">
                        <td className="p-3 align-top font-medium text-foreground whitespace-nowrap">
                          {t(`privacy.section3.${key}_provider`)}
                        </td>
                        <td className="p-3 align-top">{t(`privacy.section3.${key}_purpose`)}</td>
                        <td className="p-3 align-top">{t(`privacy.section3.${key}_data`)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                {t('privacy.section6.paragraph1')}
              </p>
            </section>

            <section className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">
                {t('privacy.section7.title')}
              </h2>
              <p>
                {t('privacy.section7.paragraph1')}{' '}
                <a href="mailto:privacy@theleaseio.com" className="text-primary hover:underline">
                  {t('privacy.section7.email')}
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
