import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle, XCircle, Clock } from "lucide-react";

type InviteStatus = "loading" | "valid" | "expired" | "already_accepted" | "not_found" | "error";

interface InviteData {
  workspace_id: string;
  workspace_name: string;
  role: string;
  email: string;
}

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<InviteStatus>("loading");
  const [inviteData, setInviteData] = useState<InviteData | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("not_found");
      return;
    }

    validateToken();
  }, [token]);

  const validateToken = async () => {
    try {
      // Fetch invite with expiration check
      const { data: invite, error: inviteError } = await supabase
        .from("invite_tokens")
        .select("*, workspaces(name)")
        .eq("token", token)
        .maybeSingle();

      if (inviteError) throw inviteError;

      if (!invite) {
        setStatus("not_found");
        return;
      }

      // Check if already accepted
      if (invite.accepted_at) {
        setStatus("already_accepted");
        return;
      }

      // Enforce expiration check
      const expiresAt = new Date(invite.expires_at);
      if (expiresAt < new Date()) {
        setStatus("expired");
        return;
      }

      setInviteData({
        workspace_id: invite.workspace_id,
        workspace_name: (invite.workspaces as { name: string })?.name || "Unknown Workspace",
        role: invite.role,
        email: invite.email,
      });
      setStatus("valid");
    } catch (err) {
      console.error("Error validating invite:", err);
      setError(err instanceof Error ? err.message : "Failed to validate invitation");
      setStatus("error");
    }
  };

  const handleAcceptInvite = async () => {
    if (!inviteData || !token) return;

    setAccepting(true);
    setError(null);

    try {
      // Check if user is logged in
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        // Redirect to signup with invite token
        navigate(`/signup?invite=${token}&email=${encodeURIComponent(inviteData.email)}`);
        return;
      }

      // Verify email matches
      if (user.email?.toLowerCase() !== inviteData.email.toLowerCase()) {
        setError(`This invitation was sent to ${inviteData.email}. Please log in with that email address.`);
        setAccepting(false);
        return;
      }

      // Re-validate expiration before accepting (double-check)
      const { data: currentInvite, error: checkError } = await supabase
        .from("invite_tokens")
        .select("expires_at, accepted_at")
        .eq("token", token)
        .single();

      if (checkError) throw checkError;

      if (currentInvite.accepted_at) {
        setStatus("already_accepted");
        setAccepting(false);
        return;
      }

      if (new Date(currentInvite.expires_at) < new Date()) {
        setStatus("expired");
        setAccepting(false);
        return;
      }

      // Add user as workspace member
      const { error: memberError } = await supabase
        .from("workspace_members")
        .insert({
          workspace_id: inviteData.workspace_id,
          user_id: user.id,
          role: inviteData.role as "admin" | "editor" | "viewer",
          invited_email: inviteData.email,
          invited_at: new Date().toISOString(),
          accepted_at: new Date().toISOString(),
        });

      if (memberError) {
        if (memberError.code === "23505") {
          // Already a member
          navigate("/app/dashboard");
          return;
        }
        throw memberError;
      }

      // Mark invite as accepted - use service role via edge function if needed
      // For now, users can't update invite_tokens, so we'll just proceed
      // The workspace owner can see the member was added

      navigate("/app/dashboard");
    } catch (err) {
      console.error("Error accepting invite:", err);
      setError(err instanceof Error ? err.message : "Failed to accept invitation");
      setAccepting(false);
    }
  };

  const renderContent = () => {
    switch (status) {
      case "loading":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground">Validating invitation...</p>
          </div>
        );

      case "expired":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <Clock className="h-12 w-12 text-destructive" />
            <div className="text-center">
              <h3 className="text-lg font-semibold">Invitation Expired</h3>
              <p className="text-muted-foreground mt-2">
                This invitation has expired. Please ask the workspace owner to send a new invitation.
              </p>
            </div>
            <Button onClick={() => navigate("/login")} variant="outline">
              Go to Login
            </Button>
          </div>
        );

      case "already_accepted":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <CheckCircle className="h-12 w-12 text-green-500" />
            <div className="text-center">
              <h3 className="text-lg font-semibold">Already Accepted</h3>
              <p className="text-muted-foreground mt-2">
                This invitation has already been accepted.
              </p>
            </div>
            <Button onClick={() => navigate("/app/dashboard")}>
              Go to Dashboard
            </Button>
          </div>
        );

      case "not_found":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <XCircle className="h-12 w-12 text-destructive" />
            <div className="text-center">
              <h3 className="text-lg font-semibold">Invitation Not Found</h3>
              <p className="text-muted-foreground mt-2">
                This invitation link is invalid or has been revoked.
              </p>
            </div>
            <Button onClick={() => navigate("/login")} variant="outline">
              Go to Login
            </Button>
          </div>
        );

      case "error":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <XCircle className="h-12 w-12 text-destructive" />
            <div className="text-center">
              <h3 className="text-lg font-semibold">Something Went Wrong</h3>
              <p className="text-muted-foreground mt-2">{error}</p>
            </div>
            <Button onClick={() => navigate("/login")} variant="outline">
              Go to Login
            </Button>
          </div>
        );

      case "valid":
        return (
          <div className="flex flex-col items-center gap-6 py-8">
            <div className="text-center">
              <h3 className="text-lg font-semibold">You've Been Invited!</h3>
              <p className="text-muted-foreground mt-2">
                You've been invited to join <strong>{inviteData?.workspace_name}</strong> as a{" "}
                <span className="capitalize">{inviteData?.role}</span>.
              </p>
            </div>

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <Button onClick={handleAcceptInvite} disabled={accepting} className="w-full max-w-xs">
              {accepting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Accepting...
                </>
              ) : (
                "Accept Invitation"
              )}
            </Button>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>Workspace Invitation</CardTitle>
          <CardDescription>LeaseIO</CardDescription>
        </CardHeader>
        <CardContent>{renderContent()}</CardContent>
      </Card>
    </div>
  );
}
