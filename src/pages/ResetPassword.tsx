import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { FileText, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAppTranslation } from '@/hooks/useAppTranslation';

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { updatePassword, session } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useAppTranslation();

  // Check if user has a valid session from reset link
  useEffect(() => {
    if (!session) {
      // No session means the reset link wasn't valid or expired
      // We'll let them try anyway, but the updatePassword will fail
    }
  }, [session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (password.length < 8) {
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
    <div className="min-h-screen bg-gradient-to-b from-primary/5 via-background to-background flex items-center justify-center px-4">
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
                <p className="text-xs text-muted-foreground">{t('auth.min_password')}</p>
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
        </Card>
      </div>
    </div>
  );
}
