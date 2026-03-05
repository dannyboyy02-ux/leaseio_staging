import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { FileText, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { LanguageToggle } from '@/components/layout/LanguageToggle';

export default function Login() {
  const { t } = useAppTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!email || !password) {
      toast({
        title: t('auth.errors.missing_fields'),
        description: t('auth.errors.enter_email_password'),
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    
    const { error } = await signIn(email, password);
    
    setIsLoading(false);
    
    if (error) {
      let message = t('auth.errors.signin_failed');
      if (error.message.includes('Invalid login credentials')) {
        message = t('auth.errors.invalid_credentials');
      } else if (error.message.includes('Email not confirmed')) {
        message = t('auth.errors.email_not_confirmed');
      }
      
      toast({
        title: t('auth.errors.signin_failed'),
        description: message,
        variant: 'destructive',
      });
      return;
    }

    toast({
      title: t('auth.success.welcome_back'),
      description: t('auth.success.signed_in'),
    });
    
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    navigate(next || '/app/dashboard');
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex items-center justify-center px-4">
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
            <h1 className="font-display text-2xl font-bold text-foreground">{t('auth.welcome_back')}</h1>
            <p className="text-muted-foreground">{t('auth.sign_in_to_account')}</p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.email')}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isLoading}
                  autoComplete="email"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">{t('auth.password')}</Label>
                  <Link 
                    to="/forgot-password" 
                    className="text-sm text-primary hover:underline"
                  >
                    {t('auth.forgot_password')}
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isLoading}
                  autoComplete="current-password"
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="remember"
                  checked={rememberMe}
                  onCheckedChange={(checked) => setRememberMe(checked as boolean)}
                />
                <Label htmlFor="remember" className="text-sm text-muted-foreground cursor-pointer">
                  {t('auth.remember_me')}
                </Label>
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('auth.signing_in')}
                  </>
                ) : (
                  t('auth.sign_in')
                )}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                {t('auth.no_account')}{' '}
                <Link to="/signup" className="text-primary hover:underline font-medium">
                  {t('auth.create_account')}
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-8">
          {t('auth.by_signing_in')}{' '}
          <Link to="/terms" className="underline hover:text-foreground">{t('auth.terms_of_service')}</Link>
          {' '}{t('auth.and')}{' '}
          <Link to="/privacy" className="underline hover:text-foreground">{t('auth.privacy_policy')}</Link>
        </p>
      </div>
    </div>
  );
}
