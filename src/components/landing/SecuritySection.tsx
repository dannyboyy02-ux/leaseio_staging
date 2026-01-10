import { Shield, Lock, Eye, Server } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

export function SecuritySection() {
  const { t } = useLanguage();

  const securityFeatures = [
    {
      icon: Lock,
      titleKey: 'landing.security.encryption.title',
      descKey: 'landing.security.encryption.desc',
    },
    {
      icon: Shield,
      titleKey: 'landing.security.access.title',
      descKey: 'landing.security.access.desc',
    },
    {
      icon: Eye,
      titleKey: 'landing.security.audit.title',
      descKey: 'landing.security.audit.desc',
    },
    {
      icon: Server,
      titleKey: 'landing.security.hosting.title',
      descKey: 'landing.security.hosting.desc',
    },
  ];

  return (
    <section id="security" className="py-24 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
              {t('landing.security.title')}
            </h2>
            <p className="text-lg text-muted-foreground mb-8">
              {t('landing.security.subtitle')}
            </p>

            <div className="space-y-6">
              {securityFeatures.map((feature) => (
                <div key={feature.titleKey} className="flex items-start gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <feature.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">{t(feature.titleKey)}</h3>
                    <p className="text-sm text-muted-foreground">{t(feature.descKey)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative">
            <div className="aspect-square bg-gradient-to-br from-primary/20 to-accent/20 rounded-3xl flex items-center justify-center">
              <div className="h-32 w-32 rounded-full bg-primary/10 flex items-center justify-center">
                <Shield className="h-16 w-16 text-primary" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
