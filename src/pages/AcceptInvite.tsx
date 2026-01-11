import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle } from "lucide-react";

type Status = "loading" | "needs_login" | "accepting" | "success" | "error";

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const token = searchParams.get("token") || "";
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState<string>("Preparing invitation...");

  useEffect(() => {
    (async () => {
      if (!token) {
        setStatus("error");
        setMessage("Invitation token missing.");
        return;
      }

      // Are we logged in?
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setStatus("needs_login");
        setMessage("Please log in (or create an account) using the email that received the invite.");
        return;
      }

      // Logged in -> accept via Edge Function (trusted path)
      setStatus("accepting");
      setMessage("Accepting invitation...");

      const { data, error } = await supabase.functions.invoke("accept-invite", {
        body: { token },
      });

      if (error) {
        setStatus("error");
        setMessage(error.message || "Failed to accept invitation.");
        return;
      }

      if (data?.error) {
        setStatus("error");
        setMessage(data.error);
        return;
      }

      setStatus("success");
      setMessage("Invitation accepted. Redirecting...");
      setTimeout(() => navigate("/app/dashboard", { replace: true }), 600);
    })();
  }, [token, navigate]);

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
            <h3 className="text-lg font-semibold">Login Required</h3>
            <p className="text-muted-foreground mt-2">{message}</p>
          </div>
          <Button onClick={goToLogin} className="w-full max-w-xs">
            Continue to Login
          </Button>
        </div>
      );
    }

    if (status === "success") {
      return (
        <div className="flex flex-col items-center gap-4 py-8">
          <CheckCircle className="h-12 w-12 text-green-500" />
          <div className="text-center">
            <h3 className="text-lg font-semibold">Accepted</h3>
            <p className="text-muted-foreground mt-2">{message}</p>
          </div>
          <Button onClick={() => navigate("/app/dashboard")} className="w-full max-w-xs">
            Go to Dashboard
          </Button>
        </div>
      );
    }

    // error
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <XCircle className="h-12 w-12 text-destructive" />
        <div className="text-center">
          <h3 className="text-lg font-semibold">Invite Failed</h3>
          <p className="text-muted-foreground mt-2">{message}</p>
        </div>
        <div className="flex gap-2 w-full">
          <Button onClick={goToLogin} variant="outline" className="flex-1">
            Login
          </Button>
          <Button onClick={() => window.location.reload()} className="flex-1">
            Retry
          </Button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Workspace Invitation</CardTitle>
          <CardDescription>LeaseIO</CardDescription>
        </CardHeader>
        <CardContent>{render()}</CardContent>
      </Card>
    </div>
  );
}
