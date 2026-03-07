import { useState } from "react";
import { Loader2, RefreshCcw, Trash2 } from "lucide-react";
import { format, isPast } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface PendingInvite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
}

interface PendingInvitesListProps {
  invites: PendingInvite[];
  onRefresh: () => void;
}

export function PendingInvitesList({ invites, onRefresh }: PendingInvitesListProps) {
  const [loadingId, setLoadingId] = useState<string | null>(null);

  if (invites.length === 0) return null;

  const handleResend = async (invite: PendingInvite) => {
    setLoadingId(invite.id);
    try {
      const { data, error } = await supabase.functions.invoke("resend-invite", {
        body: { id: invite.id },
      });

      if (error) {
        toast.error(error.message || "Failed to resend invitation");
        return;
      }

      if (!data?.ok) {
        toast.error(data?.message || "Failed to resend invitation");
        return;
      }

      toast.success(`Invitation resent to ${invite.email}`);
      onRefresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to resend invitation");
    } finally {
      setLoadingId(null);
    }
  };

  const handleRevoke = async (invite: PendingInvite) => {
    setLoadingId(invite.id);
    try {
      const { data, error } = await supabase.functions.invoke("revoke-invite", {
        body: { id: invite.id },
      });

      if (error) {
        toast.error(error.message || "Failed to revoke invitation");
        return;
      }

      if (!data?.ok) {
        toast.error(data?.message || "Failed to revoke invitation");
        return;
      }

      toast.success(`Invitation to ${invite.email} revoked`);
      onRefresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to revoke invitation");
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div>
      <p className="text-sm font-medium mb-3">Pending Invitations</p>
      <div className="space-y-0 rounded-md border divide-y">
        {invites.map((invite) => {
          const expired = isPast(new Date(invite.expires_at));
          const isLoading = loadingId === invite.id;
          return (
            <div
              key={invite.id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{invite.email}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <Badge variant="secondary" className="text-xs capitalize">
                    {invite.role}
                  </Badge>
                  <span className={`text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
                    {expired
                      ? `Expired ${format(new Date(invite.expires_at), "MMM d")}`
                      : `Expires ${format(new Date(invite.expires_at), "MMM d")}`}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleResend(invite)}
                  disabled={isLoading}
                  title="Resend invitation"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCcw className="h-4 w-4" />
                  )}
                  <span className="ml-1 hidden sm:inline">Resend</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRevoke(invite)}
                  disabled={isLoading}
                  className="text-destructive hover:text-destructive"
                  title="Revoke invitation"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  <span className="ml-1 hidden sm:inline">Revoke</span>
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
