import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Building2, CheckCircle2, XCircle, Loader2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAppTranslation } from "@/hooks/useAppTranslation";

type Info = { firmName: string; role: string; email: string; expired: boolean; accepted: boolean; revoked: boolean; user_exists: boolean };
type Status = "loading" | "need_auth" | "email_mismatch" | "ready" | "accepting" | "done" | "error";

export default function AcceptFirmInvitation() {
  const { t } = useAppTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";

  const [status, setStatus] = useState<Status>("loading");
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    (async () => {
      if (!token) { setStatus("error"); setError(t("firm.accept.invalid")); return; }
      const { data, error: infoErr } = await supabase.functions.invoke("get-firm-invitation-info", { body: { token } });
      const i = data as (Info & { ok: boolean }) | null;
      if (infoErr || !i?.ok) { setStatus("error"); setError(t("firm.accept.not_found")); return; }
      setInfo(i);
      if (i.revoked) { setStatus("error"); setError(t("firm.accept.revoked")); return; }
      if (i.accepted) { setStatus("error"); setError(t("firm.accept.already")); return; }
      if (i.expired) { setStatus("error"); setError(t("firm.accept.expired")); return; }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setStatus("need_auth"); return; }
      if ((user.email ?? "").toLowerCase() !== i.email.toLowerCase()) { setStatus("email_mismatch"); return; }
      setStatus("ready");
    })();
  }, [token, t]);

  const accept = async () => {
    setStatus("accepting");
    const { data, error: acceptErr } = await supabase.functions.invoke("accept-firm-invitation", { body: { token } });
    if (acceptErr || (data as any)?.ok === false) { setStatus("error"); setError(t("firm.accept.failed")); return; }
    setStatus("done");
    setTimeout(() => navigate("/app/firm", { replace: true }), 800);
  };

  const goAuth = (mode: "login" | "signup") => {
    const next = encodeURIComponent(`/firm/accept-invitation?token=${token}`);
    navigate(`/${mode}?next=${next}`, { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="max-w-md w-full p-8 text-center space-y-4">
        <Building2 className="h-10 w-10 mx-auto text-primary" />
        {status === "loading" ? (
          <><Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("firm.accept.loading")}</p></>
        ) : status === "error" ? (
          <><XCircle className="h-8 w-8 mx-auto text-destructive" /><p className="text-sm">{error}</p><Button variant="outline" onClick={() => navigate("/app/dashboard")}>{t("firm.back_to_workspace")}</Button></>
        ) : status === "done" ? (
          <><CheckCircle2 className="h-8 w-8 mx-auto text-green-600" /><p className="text-sm font-medium">{t("firm.accept.success", { firm: info?.firmName })}</p></>
        ) : status === "need_auth" ? (
          <>
            <h1 className="text-lg font-semibold">{t("firm.accept.title", { firm: info?.firmName })}</h1>
            <p className="text-sm text-muted-foreground">{t("firm.accept.need_auth", { email: info?.email })}</p>
            <div className="flex gap-2 justify-center">
              {info?.user_exists
                ? <Button onClick={() => goAuth("login")}>{t("firm.accept.sign_in")}</Button>
                : <Button onClick={() => goAuth("signup")}>{t("firm.accept.create_account")}</Button>}
            </div>
          </>
        ) : status === "email_mismatch" ? (
          <><XCircle className="h-8 w-8 mx-auto text-destructive" /><p className="text-sm">{t("firm.accept.email_mismatch", { email: info?.email })}</p></>
        ) : (
          <>
            <h1 className="text-lg font-semibold">{t("firm.accept.title", { firm: info?.firmName })}</h1>
            <p className="text-sm text-muted-foreground">{t("firm.accept.as_role", { role: t(`firm.role.${info?.role}`) })}</p>
            <Button onClick={accept} disabled={status === "accepting"} className="w-full">
              {status === "accepting" ? <Loader2 className="h-4 w-4 animate-spin" /> : t("firm.accept.join")}
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
