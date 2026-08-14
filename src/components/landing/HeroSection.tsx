import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowRight, Sparkles, Shield, Clock, DollarSign } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { HeroMockup } from './HeroMockup';

export function HeroSection() {
  const { t } = useLanguage();
  const { user } = useAuth();
  // /lease-audit is protected: a logged-out visitor would hit ProtectedRoute →
  // /login → paid onboarding. Route them through signup carrying next so they
  // land back on the free audit (Signup honors ?next before onboarding).
  const auditTarget = user ? '/lease-audit' : '/signup?next=%2Flease-audit';

  return (
    <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-primary/5 via-background to-background">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-4xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-8">
            <DollarSign className="h-4 w-4" />
            {t('landing.hero.badge')}
          </div>

          {/* Headline */}
          <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold text-foreground leading-tight mb-6">
            {t('landing.hero.headline')}{' '}
            <span className="text-primary">{t('landing.hero.headline_accent')}</span>
          </h1>

          {/* Subheadline */}
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            {t('landing.hero.subheadline')}
          </p>

          {/* CTAs — ONE primary (FS-10): the trial is THE next step; the free
              audit is the demoted secondary so a first-timer isn't choosing
              between two equal-weight buttons. */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Button size="lg" asChild className="w-full sm:w-auto">
              <Link to="/signup">
                {t('landing.hero.cta_trial')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild className="w-full sm:w-auto">
              <Link to={auditTarget}>{t('landing.hero.cta_audit')}</Link>
            </Button>
          </div>

          {/* Trust Indicators */}
          <div className="flex flex-wrap items-center justify-center gap-8 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-accent" />
              <span>{t('landing.hero.trust_setup')}</span>
            </div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-accent" />
              <span>{t('landing.hero.trust_ai')}</span>
            </div>
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-accent" />
              <span>{t('landing.hero.trust_security')}</span>
            </div>
          </div>
        </div>

        {/* Hero visual — stylized miniature of the review workbench (#176) */}
        <div className="mt-16">
          <div className="bg-gradient-to-br from-card to-muted rounded-2xl border border-border shadow-2xl p-4 sm:p-8 max-w-3xl mx-auto">
            <HeroMockup />
          </div>
        </div>
      </div>
    </section>
  );
}
