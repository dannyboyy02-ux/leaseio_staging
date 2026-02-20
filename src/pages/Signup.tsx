import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { LanguageToggle } from '@/components/layout/LanguageToggle';

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
];

const PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: 'Free',
  starter: 'Starter',
  pro: 'Pro',
  business: 'Business',
};

export default function Signup() {
  const { t } = useAppTranslation();
  const [searchParams] = useSearchParams();
  const preselectedPlan = searchParams.get('plan') || 'free';
  const planDisplayName = PLAN_DISPLAY_NAMES[preselectedPlan] || 'Free';
  
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    companyName: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  });
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const validateForm = () => {
    if (!formData.firstName.trim()) {
      toast({ title: t('auth.errors.missing_fields'), description: t('auth.errors.missing_first_name'), variant: 'destructive' });
      return false;
    }
    if (!formData.lastName.trim()) {
      toast({ title: t('auth.errors.missing_fields'), description: t('auth.errors.missing_last_name'), variant: 'destructive' });
      return false;
    }
    if (!formData.email.trim()) {
      toast({ title: t('auth.errors.email_required'), description: t('auth.errors.enter_email'), variant: 'destructive' });
      return false;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      toast({ title: t('auth.errors.invalid_email'), description: t('auth.errors.enter_valid_email'), variant: 'destructive' });
      return false;
    }
    if (formData.password.length < 8) {
      toast({ title: t('auth.errors.missing_fields'), description: t('auth.errors.weak_password'), variant: 'destructive' });
      return false;
    }
    if (formData.password !== formData.confirmPassword) {
      toast({ title: t('auth.errors.missing_fields'), description: t('auth.errors.password_mismatch'), variant: 'destructive' });
      return false;
    }
    if (!acceptTerms) {
      toast({ title: t('auth.errors.missing_fields'), description: t('auth.errors.terms_required'), variant: 'destructive' });
      return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;

    setIsLoading(true);
    
    const { error } = await signUp(formData.email, formData.password, {
      first_name: formData.firstName,
      last_name: formData.lastName,
      company_name: formData.companyName,
      timezone: formData.timezone,
    });
    
    if (error) {
      setIsLoading(false);
      let message = t('auth.errors.signup_failed');
      if (error.message.includes('already registered')) {
        message = t('auth.errors.already_registered');
      }
      
      toast({
        title: t('auth.errors.signup_failed'),
        description: message,
        variant: 'destructive',
      });
      return;
    }

    toast({
      title: t('auth.success.account_created'),
      description: t('auth.success.check_email'),
    });
    
    setIsLoading(false);
    navigate('/app/onboarding');
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex items-center justify-center px-4 py-12">
      <div className="absolute top-4 right-4">
        <LanguageToggle />
      </div>

      <div className="w-full max-w-md">
        {/* Logo */}
        <Link to="/" className="flex items-center justify-center gap-2 mb-8">
          <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
            <FileText className="h-5 w-5 text-primary-foreground" />
          </div>
          <span className="font-display font-bold text-2xl text-foreground">
            Lease<span className="text-primary">IO</span>
          </span>
        </Link>

        <Card className="shadow-lg">
          <CardHeader className="text-center pb-2">
            <h1 className="font-display text-2xl font-bold text-foreground">{t('auth.create_your_account')}</h1>
            <p className="text-muted-foreground">
              {t('auth.start_with_plan', { plan: planDisplayName })}
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">{t('auth.first_name')}</Label>
                  <Input
                    id="firstName"
                    placeholder="Alex"
                    value={formData.firstName}
                    onChange={(e) => handleChange('firstName', e.target.value)}
                    disabled={isLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">{t('auth.last_name')}</Label>
                  <Input
                    id="lastName"
                    placeholder="Morgan"
                    value={formData.lastName}
                    onChange={(e) => handleChange('lastName', e.target.value)}
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.work_email')}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={formData.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  disabled={isLoading}
                  autoComplete="email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="companyName">{t('auth.company_name')}</Label>
                <Input
                  id="companyName"
                  placeholder="Acme Properties"
                  value={formData.companyName}
                  onChange={(e) => handleChange('companyName', e.target.value)}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="timezone">{t('auth.timezone')}</Label>
                <Select value={formData.timezone} onValueChange={(value) => handleChange('timezone', value)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    {timezones.map((tz) => (
                      <SelectItem key={tz.value} value={tz.value}>
                        {tz.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={formData.password}
                  onChange={(e) => handleChange('password', e.target.value)}
                  disabled={isLoading}
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">{t('auth.min_password')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t('auth.confirm_password')}</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="••••••••"
                  value={formData.confirmPassword}
                  onChange={(e) => handleChange('confirmPassword', e.target.value)}
                  disabled={isLoading}
                  autoComplete="new-password"
                />
              </div>

              <div className="flex items-start gap-2 pt-2">
                <Checkbox
                  id="terms"
                  checked={acceptTerms}
                  onCheckedChange={(checked) => setAcceptTerms(checked as boolean)}
                  className="mt-1"
                />
                <Label htmlFor="terms" className="text-sm text-muted-foreground cursor-pointer leading-relaxed">
                  {t('auth.agree_terms')}{' '}
                  <Link to="/terms" className="text-primary hover:underline">{t('auth.terms_of_service')}</Link>
                  {' '}{t('auth.and')}{' '}
                  <Link to="/privacy" className="text-primary hover:underline">{t('auth.privacy_policy')}</Link>
                </Label>
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('auth.creating_account')}
                  </>
                ) : (
                  t('auth.create_account')
                )}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                {t('auth.have_account')}{' '}
                <Link to="/login" className="text-primary hover:underline font-medium">
                  {t('auth.sign_in')}
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
