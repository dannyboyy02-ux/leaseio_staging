import { Upload, Sparkles, CheckCircle, Zap } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

export function HowItWorksSection() {
  const { t } = useLanguage();

  const steps = [
    {
      icon: Upload,
      titleKey: 'landing.how.step1.title',
      descKey: 'landing.how.step1.desc',
    },
    {
      icon: Sparkles,
      titleKey: 'landing.how.step2.title',
      descKey: 'landing.how.step2.desc',
    },
    {
      icon: CheckCircle,
      titleKey: 'landing.how.step3.title',
      descKey: 'landing.how.step3.desc',
    },
    {
      icon: Zap,
      titleKey: 'landing.how.step4.title',
      descKey: 'landing.how.step4.desc',
    },
  ];

  return (
    <section className="py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            {t('landing.how.title')}
          </h2>
          <p className="text-lg text-muted-foreground">
            {t('landing.how.subtitle')}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => (
            <div key={step.titleKey} className="relative">
              {/* Connector Line */}
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-8 left-[calc(50%+2rem)] w-[calc(100%-4rem)] h-0.5 bg-border" />
              )}
              
              <div className="text-center">
                <div className="relative inline-flex">
                  <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                    <step.icon className="h-8 w-8 text-primary" />
                  </div>
                  <div className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                    {index + 1}
                  </div>
                </div>
                <h3 className="font-semibold text-lg text-foreground mb-2">{t(step.titleKey)}</h3>
                <p className="text-muted-foreground text-sm">{t(step.descKey)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
