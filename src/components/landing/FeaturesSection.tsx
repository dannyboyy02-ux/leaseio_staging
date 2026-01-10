import { 
  FileSearch, 
  Bell, 
  TrendingUp, 
  FileSpreadsheet,
  Calendar,
  Shield 
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';

export function FeaturesSection() {
  const { t } = useLanguage();

  const features = [
    {
      icon: FileSearch,
      titleKey: 'landing.features.ai_extraction.title',
      descKey: 'landing.features.ai_extraction.desc',
    },
    {
      icon: Calendar,
      titleKey: 'landing.features.deadline_tracking.title',
      descKey: 'landing.features.deadline_tracking.desc',
    },
    {
      icon: TrendingUp,
      titleKey: 'landing.features.rent_schedule.title',
      descKey: 'landing.features.rent_schedule.desc',
    },
    {
      icon: Bell,
      titleKey: 'landing.features.notifications.title',
      descKey: 'landing.features.notifications.desc',
    },
    {
      icon: FileSpreadsheet,
      titleKey: 'landing.features.rent_roll.title',
      descKey: 'landing.features.rent_roll.desc',
    },
    {
      icon: Shield,
      titleKey: 'landing.features.security.title',
      descKey: 'landing.features.security.desc',
    },
  ];

  return (
    <section id="features" className="py-24 px-4 sm:px-6 lg:px-8 bg-muted/30">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="font-display text-3xl sm:text-4xl font-bold text-foreground mb-4">
            {t('landing.features.title')}
          </h2>
          <p className="text-lg text-muted-foreground">
            {t('landing.features.subtitle')}
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature) => (
            <Card key={feature.titleKey} className="relative overflow-hidden group hover:shadow-lg transition-shadow">
              <CardContent className="p-6">
                <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/20 transition-colors">
                  <feature.icon className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold text-lg text-foreground mb-2">{t(feature.titleKey)}</h3>
                <p className="text-muted-foreground text-sm">{t(feature.descKey)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
