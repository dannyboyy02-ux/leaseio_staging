import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { FileText, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { LanguageToggle } from '@/components/layout/LanguageToggle';

export function LandingNav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const { t } = useLanguage();
  // A signed-in visitor's most prominent action shouldn't be signing up for
  // an account they already have — the CTA becomes their way back in.
  const { user } = useAuth();
  const ctaTarget = user ? '/app/dashboard' : '/signup';
  const ctaLabel = user ? 'landing.hero.cta_dashboard' : 'landing.hero.cta_trial';

  const navLinks = [
    { href: '#features', labelKey: 'landing.nav.product' },
    { href: '#pricing', labelKey: 'landing.nav.pricing' },
    { href: '#security', labelKey: 'landing.nav.security' },
    { href: '#faq', labelKey: 'landing.nav.faq' },
  ];

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    // If we're not on the landing page, navigate there first
    if (location.pathname !== '/') {
      e.preventDefault();
      window.location.href = '/' + href;
      return;
    }
    
    // If on landing page, smooth scroll to section
    e.preventDefault();
    const element = document.querySelector(href);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-lg border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <FileText className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="font-display font-bold text-xl text-foreground">
              Lease<span className="text-primary">IO</span>
            </span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.href)}
                className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                {t(link.labelKey)}
              </a>
            ))}
          </div>

          {/* Desktop Auth Buttons */}
          <div className="hidden md:flex items-center gap-3">
            <LanguageToggle />
            <Button variant="ghost" asChild>
              <Link to="/login">{t('landing.nav.sign_in')}</Link>
            </Button>
            <Button asChild>
              <Link to={ctaTarget}>{t(ctaLabel)}</Link>
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <div className="md:hidden flex items-center gap-2">
            <LanguageToggle />
            <button
              className="p-2 text-muted-foreground hover:text-foreground"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-background border-b border-border">
          <div className="px-4 py-4 space-y-3">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="block text-sm font-medium text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  handleNavClick(e, link.href);
                  setMobileMenuOpen(false);
                }}
              >
                {t(link.labelKey)}
              </a>
            ))}
            <div className="pt-4 flex flex-col gap-2">
              <Button variant="outline" asChild className="w-full">
                <Link to="/login">{t('landing.nav.sign_in')}</Link>
              </Button>
              <Button asChild className="w-full">
                <Link to={ctaTarget}>{t(ctaLabel)}</Link>
              </Button>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
