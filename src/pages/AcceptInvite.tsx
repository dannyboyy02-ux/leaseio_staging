import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle, XCircle, Check, X } from "lucide-react";
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { toast } from "sonner";

type Status = "loading" | "create_password" | "needs_login" | "wrong_account" | "accepting" | "success" | "error";

interface InviteInfo {
  email: string;
  first_name: string | null;
  last_name: string | null;
  workspaceName: string;
  role: string;
  user_exists: boolean;
}

interface PasswordRequirement {
  label: string;
  met: (pw: string) => boolean;
}

const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  { label: "At least 8 characters",       met: (pw) => pw.length >= 8 },
  { label: "At least one uppercase letter", met: (pw) => /[A-Z]/.test(pw) },
  { label: "At least one lowercase letter", met: (pw) => /[a-z]/.test(pw) },
  { label: "At least one number",           met: (pw) => /[0-9]/.test(pw) },
];

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useAppTranslation();

  const token = searchParams.get("token") || "";
  const [status, setStatus]         = useState<Status>("loading");
  const [message, setMessage]       = useState<string>(t('accept_invite.preparing'));
  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [currentEmail, setCurrentEmail] = useState<string | null>(null);

  // Password creation state
  const [password, setPassword]               = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting]       = useState(false);

  const passwordRequirementsMet = PASSWORD_REQUIREMENTS.every((r) => r.met(password));
  const passwordsMatch          = password === confirmPassword && confirmPassword.length > 0;
  const canSubmitPassword       = passwordRequirementsMet && passwordsMatch && !isSubmitting;

  useEffect(() => {
    (async () => {
      if (!token) {
        setStatus("error");
        setMessage(t('accept_invite.token_missing'));
        return;
      }

      // Step 1: fetch invite metadata (no auth needed)
      const { data: info, error: infoError } = await supabase.functions.invoke("get-invite-info", {
        body: { token },
      });

      if (infoError || !info?.ok) {
        setStatus("error");
        setMessage(info?.message || t('accept_invite.failed'));
        return;
      }

      if (info.expired) {
        setStatus("error");
        setMessage(t('accept_invite.expired'));
        return;
      }

      if (info.accepted) {
        setStatus("error");
        setMessage(t('accept_invite.already_accepted'));
        return;
      }

      setInviteInfo({
        email: info.email,
        first_name: info.first_name ?? null,
        last_name:  info.last_name  ?? null,
        workspaceName: info.workspaceName,
        role: info.role,
        user_exists: info.user_exists ?? true,
      });

      // Step 2: new user — show password creation form
      if (!info.user_exists) {
        setStatus("create_password");
        return;
      }

      // Step 3: existing user — check auth
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        setStatus("needs_login");
        return;
      }

      // Step 4: email match check
      const userEmail = user.email?.toLowerCase() ?? '';
      if (userEmail !== info.email.toLowerCase()) {
        setCurrentEmail(userEmail);
        setStatus("wrong_account");
        return;
      }

      // Step 5: accept
      setStatus("accepting");
      setMessage(t('accept_invite.accepting'));

      const { data, error } = await supabase.functions.invoke("accept-invite", { body: { token } });
      if (error || data?.error) {
        setStatus("error");
        setMessage(error?.message || data?.error || t('accept_invite.failed'));
        return;
      }

      setStatus("success");
      setMessage(t('accept_invite.accepted_redirecting'));
      setTimeout(() => navigate("/app/dashboard", { replace: true }), 600);
    })();
  }, [token, navigate, t]);

  const handleCreatePassword = async () => {
    if (!canSubmitPassword || !inviteInfo) return;
    setIsSubmitting(true);
    try {
      // Call accept-invite with password — creates account + joins workspace in one step
      const { data, error } = await supabase.functions.invoke("accept-invite", {
        body: { token, password },
      });

      if (error || !data?.ok) {
        const msg = data?.message || error?.message || t('accept_invite.failed');
        if (data?.code === 'ACCOUNT_EXISTS') {
          // Edge case: account was created between info check and now — redirect to login
          toast.error("An account already exists for this email. Please log in.");
          navigate(`/login?next=/accept-invite?token=${encodeURIComponent(token)}`, { replace: true });
        } else {
          toast.error(msg);
        }
        return;
      }

      // Sign in automatically with the new credentials
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: inviteInfo.email,
        password,
      });

      if (signInError) {
        toast.error("Account created but sign-in failed. Please log in manually.");
        navigate(`/login?next=/app/dashboard`, { replace: true });
        return;
      }

      setStatus("success");
      setMessage(t('accept_invite.accepted_redirecting'));
      setTimeout(() => navigate("/app/dashboard", { replace: true }), 600);
    } catch (err: any) {
      toast.error(err?.message || t('accept_invite.failed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate(`/login?next=/accept-invite?token=${encodeURIComponent(token)}`, { replace: true });
  };

  const goToLogin = () => {
    navigate(`/login?next=/accept-invite?token=${encodeURIComponent(token)}`, { replace: true });
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

    if (status === "create_password") {
      const displayName = inviteInfo?.first_name
        ? `Hi ${inviteInfo.first_name},`
        : "Welcome,";
      return (
        <div className="flex flex-col gap-5">
          <div className="text-center">
            <p className="font-semibold text-lg">{displayName}</p>
            <p className="text-muted-foreground text-sm mt-1">
              Create your password to join <strong>{inviteInfo?.workspaceName}</strong> as a {inviteInfo?.role}.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">Password</Label>
              <Input
                id="new-password"
                type="password"
                placeholder="Create a password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            {/* Live requirements checklist */}
            <ul className="space-y-1 text-xs px-1">
              {PASSWORD_REQUIREMENTS.map((req) => {
                const met = req.met(password);
                return (
                  <li key={req.label} className={`flex items-center gap-1.5 ${met ? 'text-green-600' : 'text-muted-foreground'}`}>
                    {met
                      ? <Check className="h-3 w-3 shrink-0" />
                      : <X className="h-3 w-3 shrink-0" />}
                    {req.label}
                  </li>
                );
              })}
            </ul>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input
                id="confirm-password"
                type="password"
                placeholder="Confirm your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreatePassword()}
                autoComplete="new-password"
              />
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-destructive">Passwords do not match</p>
              )}
            </div>
          </div>

          <Button onClick={handleCreatePassword} disabled={!canSubmitPassword} className="w-full">
            {isSubmitting
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating account…</>
              : "Create Account & Join Workspace"}
          </Button>
        </div>
      );
    }

    if (status === "needs_login") {
      return (
        <div className="flex flex-col items-center gap-4 py-8">
          <XCircle className="h-12 w-12 text-muted-foreground" />
          <div className="text-center">
            <h3 className="text-lg font-semibold">{t('accept_invite.login_required_title')}</h3>
            <p className="text-muted-foreground mt-2">
              {inviteInfo
                ? t('accept_invite.login_context', { email: inviteInfo.email, workspaceName: inviteInfo.workspaceName, role: inviteInfo.role })
                : t('accept_invite.login_required_message')}
            </p>
          </div>
          <Button onClick={goToLogin} className="w-full max-w-xs">
            {t('accept_invite.continue_to_login')}
          </Button>
        </div>
      );
    }

    if (status === "wrong_account") {
      return (
        <div className="flex flex-col items-center gap-4 py-8">
          <XCircle className="h-12 w-12 text-destructive" />
          <div className="text-center space-y-2">
            <h3 className="text-lg font-semibold">{t('accept_invite.wrong_account_title')}</h3>
            <p className="text-muted-foreground">{t('accept_invite.wrong_account_invite_for', { email: inviteInfo?.email })}</p>
            <p className="text-muted-foreground">{t('accept_invite.wrong_account_signed_in_as', { email: currentEmail })}</p>
          </div>
          <Button onClick={handleSignOut} className="w-full max-w-xs">
            {t('accept_invite.sign_out_and_switch')}
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
          <Button onClick={goToLogin} variant="outline" className="flex-1">{t('auth.login')}</Button>
          <Button onClick={() => window.location.reload()} className="flex-1">{t('accept_invite.retry')}</Button>
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
