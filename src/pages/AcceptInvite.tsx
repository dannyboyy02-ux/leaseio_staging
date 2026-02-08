import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { useAppTranslation } from '@/hooks/useAppTranslation';

type Status = "loading" | "needs_login" | "accepting" | "success" | "error";

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useAppTranslation();

  const token = searchParams.get("token") || "";
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState<string>(t('accept_invite.preparing'));

  useEffect(() => {
    (async () => {
      if (!token) {
        setStatus("error");
        setMessage(t('accept_invite.token_missing'));
        return;
      }

      // Are we logged in?
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setStatus("needs_login");
        setMessage(t('accept_invite.login_required_message'));
        return;
      }

      // Logged in -> accept via Edge Function (trusted path)
      setStatus("accepting");
      setMessage(t('accept_invite.accepting'));

      const { data, error } = await supabase.functions.invoke("accept-invite", {
        body: { token },
      });

      if (error) {
        setStatus("error");
        setMessage(error.message || t('accept_invite.failed'));
        return;
      }

      if (data?.error) {
        setStatus("error");
        setMessage(data.error);
        return;
      }

      setStatus("success");
      setMessage(t('accept_invite.accepted_redirecting'));
      setTimeout(() => navigate("/app/dashboard", { replace: true }), 600);
    })();
  }, [token, navigate, t]);

  const goToLogin = () => {
    // preserve the invite token through login
    navigate(`/auth?next=/accept-invite?token=${encodeURIComponent(token)}`, { replace: true });
  };

  const render = () => {
    if (status === "loading" || status === "accepting") {
      return (
        <div className="flex flex-col items-center gap-4 py-8">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">{message}</p>
        </div>
      );
    }

    if (status === "needs_login") {
      return (
        <div className="flex flex-col items-center gap-4 py-8">
          <XCircle className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <h3 className="text-lg font-semibold">{t('accept_invite.login_required_title')}</h3>
            <p className="text-muted-foreground mt-2">{message}</p>
          </div>
          <Button onClick={goToLogin} className="w-full max-w-xs">
            {t('accept_invite.continue_to_login')}
          </Button>
        </div>
      );
    }

    if (status === "success") {
      return (
        <div className="flex flex-col items-center gap-4 py-8">
          <CheckCircle className="h-12 w-12 text-green-500" />
          <div className="text-center">
            <h3 className="text-lg font-semibold">{t('accept_invite.accepted_title')}</h3>
            <p className="text-muted-foreground mt-2">{message}</p>
          </div>
          <Button onClick={() => navigate("/app/dashboard")} className="w-full max-w-xs">
            {t('accept_invite.go_to_dashboard')}
          </Button>
        </div>
      );
    }

    // error
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <XCircle className="h-12 w-12 text-destructive" />
        <div className="text-center">
          <h3 className="text-lg font-semibold">{t('accept_invite.failed_title')}</h3>
          <p className="text-muted-foreground mt-2">{message}</p>
        </div>
        <div className="flex gap-2 w-full">
          <Button onClick={goToLogin} variant="outline" className="flex-1">
            {t('auth.login')}
          </Button>
          <Button onClick={() => window.location.reload()} className="flex-1">
            {t('accept_invite.retry')}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>{t('accept_invite.title')}</CardTitle>
          <CardDescription>{t('accept_invite.brand')}</CardDescription>
        </CardHeader>
        <CardContent>{render()}</CardContent>
      </Card>
    </div>
  );
}
