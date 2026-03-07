import { useState, KeyboardEvent } from "react";
import { Loader2, Mail, UserPlus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { WorkspaceRole } from "@/types";
import { useApp } from "@/contexts/AppContext";

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onInviteSent: () => void;
}

const roleDescriptions: Record<WorkspaceRole, string> = {
  admin: "Full access including billing & member management",
  editor: "Upload, edit, export leases. No billing or member access",
  viewer: "Read-only access to view leases and reports",
};

export function InviteMemberDialog({ open, onOpenChange, workspaceId, onInviteSent }: InviteMemberDialogProps) {
  const { workspace } = useApp();
  const [emailInput, setEmailInput] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [role, setRole] = useState<WorkspaceRole>("editor");
  const [isInviting, setIsInviting] = useState(false);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const addEmail = (email: string) => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    if (!emailRegex.test(trimmed)) {
      toast.error(`Invalid email: ${trimmed}`);
      return;
    }

    if (emails.includes(trimmed)) {
      toast.error("Email already added");
      return;
    }

    setEmails([...emails, trimmed]);
    setEmailInput("");
  };

  const removeEmail = (email: string) => {
    setEmails(emails.filter((e) => e !== email));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addEmail(emailInput);
    } else if (e.key === "Backspace" && !emailInput && emails.length > 0) {
      removeEmail(emails[emails.length - 1]);
    }
  };

  const handleBlur = () => {
    if (emailInput.trim()) {
      addEmail(emailInput);
    }
  };

  const handleInvite = async () => {
    if (!workspaceId) {
      toast.error("Workspace not found. Refresh and try again.");
      return;
    }

    if (emails.length === 0) {
      toast.error("Please add at least one email address");
      return;
    }

    setIsInviting(true);

    try {
      const { data, error } = await supabase.functions.invoke("send-invite", {
        body: {
          emails,
          role,
          workspaceId,
          workspaceName: workspace?.name ?? "Workspace",
        },
      });

      // Supabase invoke error (network / auth / 4xx/5xx)
      if (error) {
        console.error("send-invite invoke error:", error);
        toast.error(error.message || "Failed to send invitations");
        return;
      }

      // Edge function returned an application-level error
      if (!data || typeof data !== "object") {
        console.error("send-invite unexpected response:", data);
        toast.error("Invite service returned an unexpected response");
        return;
      }

      // Top-level guard: no results array and top-level failure
      if (!data?.ok && !Array.isArray((data as any)?.data?.results)) {
        toast.error((data as any)?.message || "Failed to send invitations");
        return;
      }

      // New response contract: { ok, code, message, data: { results: [...] } }
      const perEmailResults: Array<{ email: string; ok: boolean; code: string; message: string }> =
        Array.isArray((data as any).data?.results) ? (data as any).data.results : [];

      // top-level ok:false with an empty results array — surface the top-level message
      if (perEmailResults.length === 0) {
        toast.error((data as any).message || "Failed to send invitations");
        return;
      }

      const successCount = perEmailResults.filter((r) => r?.ok).length;

      perEmailResults.forEach((r) => {
        if (r.ok) {
          if (r.code === "INVITE_RESENT") toast.success(`${r.email}: Invitation resent, expiry extended`);
          else if (r.code === "MEMBER_ADDED") toast.success(`${r.email}: Added directly — they already have an account`);
          else toast.success(`${r.email}: Invitation sent`);
        } else {
          if (r.code === "ALREADY_MEMBER") toast.info(`${r.email}: Already a member`);
          else toast.error(`${r.email}: ${r.message || "Failed to invite"}`);
        }
      });

      // Only close dialog if at least one succeeded
      if (successCount > 0) {
        setEmails([]);
        setEmailInput("");
        setRole("editor");
        onOpenChange(false);
        onInviteSent();
      }
    } catch (err: any) {
      console.error("Error inviting members:", err);
      toast.error(err?.message || "Failed to send invitations");
    } finally {
      setIsInviting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Invite Team Members
          </DialogTitle>
          <DialogDescription>
            Add team members to your workspace. They'll receive an email invitation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email Addresses</Label>
            <div className="flex flex-wrap gap-2 p-2 border rounded-md bg-background min-h-[42px]">
              {emails.map((email) => (
                <Badge key={email} variant="secondary" className="gap-1 pr-1">
                  {email}
                  <button
                    type="button"
                    onClick={() => removeEmail(email)}
                    className="ml-1 hover:bg-muted rounded-full p-0.5"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <Input
                id="email"
                type="email"
                placeholder={emails.length === 0 ? "colleague@company.com" : "Add another..."}
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                className="flex-1 min-w-[150px] border-0 p-0 h-6 focus-visible:ring-0"
              />
            </div>
            <p className="text-xs text-muted-foreground">Press Enter or comma to add multiple emails</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
              <SelectTrigger id="role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">
                  <span className="font-medium">Admin</span>
                </SelectItem>
                <SelectItem value="editor">
                  <span className="font-medium">Editor</span>
                </SelectItem>
                <SelectItem value="viewer">
                  <span className="font-medium">Viewer</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{roleDescriptions[role]}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="accent" onClick={handleInvite} disabled={isInviting || emails.length === 0}>
            {isInviting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4 mr-2" />
                Send {emails.length > 0 ? `${emails.length} ` : ""}Invitation{emails.length !== 1 ? "s" : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
