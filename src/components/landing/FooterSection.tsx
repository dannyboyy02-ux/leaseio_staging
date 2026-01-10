import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

export function FooterSection() {
  const { t } = useLanguage();

  return (
    <footer className="py-12 px-4 sm:px-6 lg:px-8 border-t border-border">
      <div className="max-w-7xl mx-auto">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
          {/* Logo & Description */}
          <div className="sm:col-span-2 lg:col-span-1">
            <Link to="/" className="flex items-center gap-2 mb-4">
              <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
                <FileText className="h-4 w-4 text-primary-foreground" />
              </div>
              <span className="font-display font-bold text-lg text-foreground">
                Lease<span className="text-primary">IO</span>
              </span>
            </Link>
            <p className="text-sm text-muted-foreground">
              {t('landing.footer.description')}
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="font-semibold text-foreground mb-4">{t('landing.footer.product')}</h4>
            <ul className="space-y-2">
              <li>
                <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t('landing.footer.features')}
                </a>
              </li>
              <li>
                <a href="#pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t('landing.footer.pricing')}
                </a>
              </li>
              <li>
                <a href="#security" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t('landing.footer.security')}
                </a>
              </li>
              <li>
                <a href="#faq" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t('landing.nav.faq')}
                </a>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="font-semibold text-foreground mb-4">{t('landing.footer.legal')}</h4>
            <ul className="space-y-2">
              <li>
                <Link to="/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t('landing.footer.privacy')}
                </Link>
              </li>
              <li>
                <Link to="/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t('landing.footer.terms')}
                </Link>
              </li>
            </ul>
          </div>

          {/* Support */}
          <div>
            <h4 className="font-semibold text-foreground mb-4">{t('landing.footer.support')}</h4>
            <ul className="space-y-2">
              <li>
                <a href="mailto:support@leaseio.app" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                  {t('landing.footer.contact')}
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {t('landing.footer.copyright')}
          </p>
        </div>
      </div>
    </footer>
  );
}
