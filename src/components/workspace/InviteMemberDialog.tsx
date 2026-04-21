import { useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
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
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [email, setEmail]         = useState("");
  const [role, setRole]           = useState<WorkspaceRole>("editor");
  const [isInviting, setIsInviting] = useState(false);

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const reset = () => {
    setFirstName("");
    setLastName("");
    setEmail("");
    setRole("editor");
  };

  const handleInvite = async () => {
    if (!workspaceId) {
      toast.error("Workspace not found. Refresh and try again.");
      return;
    }

    const trimmedFirst = firstName.trim();
    const trimmedLast  = lastName.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedFirst) { toast.error("First name is required"); return; }
    if (!trimmedLast)  { toast.error("Last name is required");  return; }
    if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
      toast.error("A valid email address is required");
      return;
    }

    setIsInviting(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-invite", {
        body: {
          email: trimmedEmail,
          first_name: trimmedFirst,
          last_name: trimmedLast,
          role,
          workspaceId,
          workspaceName: workspace?.name ?? "Workspace",
        },
      });

      if (error) {
        toast.error(error.message || "Failed to send invitation");
        return;
      }

      if (!data?.ok) {
        toast.error((data as any)?.message || "Failed to send invitation");
        return;
      }

      const result = (data as any)?.data?.results?.[0];
      if (result) {
        if (result.code === "INVITE_RESENT")   toast.success(`Invitation resent to ${trimmedEmail}`);
        else if (result.code === "MEMBER_ADDED") toast.success(`${trimmedFirst} already has an account and was added directly`);
        else if (result.code === "ALREADY_MEMBER") { toast.info(`${trimmedEmail} is already a member`); return; }
        else toast.success(`Invitation sent to ${trimmedFirst} ${trimmedLast}`);
      } else {
        toast.success(`Invitation sent to ${trimmedFirst} ${trimmedLast}`);
      }

      reset();
      onOpenChange(false);
      onInviteSent();
    } catch (err: any) {
      toast.error(err?.message || "Failed to send invitation");
    } finally {
      setIsInviting(false);
    }
  };

  const canSubmit = !isInviting && firstName.trim() && lastName.trim() && emailRegex.test(email.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Invite Team Member
          </DialogTitle>
          <DialogDescription>
            Enter their details and they'll receive a personalised invitation by email.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="first-name">
                First Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="first-name"
                placeholder="Jane"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="last-name">
                Last Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="last-name"
                placeholder="Smith"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-email">
              Email Address <span className="text-destructive">*</span>
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="jane.smith@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canSubmit && handleInvite()}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
              <SelectTrigger id="role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin"><span className="font-medium">Admin</span></SelectItem>
                <SelectItem value="editor"><span className="font-medium">Editor</span></SelectItem>
                <SelectItem value="viewer"><span className="font-medium">Viewer</span></SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{roleDescriptions[role]}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" onClick={handleInvite} disabled={!canSubmit}>
            {isInviting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending...</>
            ) : (
              <><UserPlus className="h-4 w-4 mr-2" />Send Invitation</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
