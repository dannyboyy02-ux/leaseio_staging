import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { FileText, Loader2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { isPasswordValid } from '@/lib/passwordPolicy';
import { PasswordRequirementsChecklist } from '@/components/auth/PasswordRequirementsChecklist';
import { LanguageToggle } from '@/components/layout/LanguageToggle';

// GoTrue redirects expired/used recovery links back here with error params in
// the hash (implicit flow); auth-js swallows the error internally but leaves
// the hash intact, so reading it directly is the only reliable detector.
function hasRecoveryErrorInUrl(): boolean {
  return [
    window.location.hash.replace(/^#/, ''),
    window.location.search.replace(/^\?/, ''),
  ].some((fragment) => {
    const params = new URLSearchParams(fragment);
    return Boolean(params.get('error') || params.get('error_code') || params.get('error_description'));
  });
}

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { updatePassword, session, isLoading: isAuthLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useAppTranslation();

  const [linkState, setLinkState] = useState<'checking' | 'ready' | 'expired'>(() =>
    hasRecoveryErrorInUrl() ? 'expired' : 'checking'
  );

  // AuthContext's isLoading settles only after supabase-js finishes URL session
  // detection (getSession awaits initializePromise), so this is race-free.
  useEffect(() => {
    if (linkState !== 'checking' || isAuthLoading) return;
    setLinkState(session ? 'ready' : 'expired');
  }, [linkState, isAuthLoading, session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isPasswordValid(password)) {
      toast({
        title: t('auth.reset.weak_password_title'),
        description: t('auth.reset.weak_password_desc'),
        variant: 'destructive',
      });
      return;
    }

    if (password !== confirmPassword) {
      toast({
        title: t('auth.reset.password_mismatch_title'),
        description: t('auth.reset.password_mismatch_desc'),
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);

    const { error } = await updatePassword(password);

    setIsLoading(false);

    if (error) {
      const code = (error as { code?: string }).code;
      if (
        error.name === 'AuthSessionMissingError' ||
        code === 'session_expired' ||
        code === 'session_not_found'
      ) {
        // Recovery session gone (link consumed elsewhere / tab left open too
        // long): route the user to the request-a-new-link path, not a
        // dead-end toast.
        setLinkState('expired');
        return;
      }
      if (code === 'same_password') {
        toast({
          title: t('auth.reset.same_password_title'),
          description: t('auth.reset.same_password_desc'),
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: t('auth.reset.error_title'),
        description: t('auth.reset.error_desc'),
        variant: 'destructive',
      });
      return;
    }

    toast({
      title: t('auth.reset.success_title'),
      description: t('auth.reset.success_desc'),
    });

    navigate('/login');
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex items-center justify-center px-4">
      {/* Language toggle — parity with Login/Signup/ForgotPassword; the
          expired-link card is exactly where a Spanish-locale user lands
          from an old email. */}
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
          {linkState === 'expired' ? (
            <>
              <CardHeader className="text-center pb-2">
                <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
                  <AlertTriangle className="h-6 w-6 text-destructive" />
                </div>
                <h1 className="font-display text-2xl font-bold text-foreground">
                  {t('auth.reset.link_invalid_title')}
                </h1>
                <p className="text-muted-foreground">{t('auth.reset.link_invalid_desc')}</p>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <Button asChild className="w-full">
                    <Link to="/forgot-password">{t('auth.reset.request_new_link')}</Link>
                  </Button>
                  <Button variant="ghost" asChild className="w-full">
                    <Link to="/login">
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      {t('auth.forgot.back_to_signin')}
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </>
          ) : linkState === 'checking' ? (
            <CardContent className="py-10 flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('auth.reset.verifying_link')}</p>
            </CardContent>
          ) : (
            <>
              <CardHeader className="text-center pb-2">
                <h1 className="font-display text-2xl font-bold text-foreground">
                  {t('auth.reset.title')}
                </h1>
                <p className="text-muted-foreground">
                  {t('auth.reset.description')}
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="password">{t('auth.reset.new_password')}</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={isLoading}
                      autoComplete="new-password"
                    />
                    <PasswordRequirementsChecklist password={password} />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">{t('auth.reset.confirm_new')}</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      placeholder="••••••••"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={isLoading}
                      autoComplete="new-password"
                    />
                  </div>

                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t('auth.reset.resetting')}
                      </>
                    ) : (
                      t('auth.reset.reset_password')
                    )}
                  </Button>
                </form>

                <div className="mt-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('auth.reset.remember_password')}{' '}
                    <Link to="/login" className="text-primary hover:underline font-medium">
                      {t('auth.sign_in')}
                    </Link>
                  </p>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
