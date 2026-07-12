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
import { useAppTranslation } from "@/hooks/useAppTranslation";

interface InviteMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onInviteSent: () => void;
}

const roleDescriptionKeys: Record<WorkspaceRole, string> = {
  admin: "workspace.invite.role_desc_admin",
  editor: "workspace.invite.role_desc_editor",
  viewer: "workspace.invite.role_desc_viewer",
};

export function InviteMemberDialog({ open, onOpenChange, workspaceId, onInviteSent }: InviteMemberDialogProps) {
  const { workspace } = useApp();
  const { t } = useAppTranslation();
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
      toast.error(t("workspace.invite.err_no_workspace"));
      return;
    }

    const trimmedFirst = firstName.trim();
    const trimmedLast  = lastName.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedFirst) { toast.error(t("workspace.invite.err_first_required")); return; }
    if (!trimmedLast)  { toast.error(t("workspace.invite.err_last_required"));  return; }
    if (!trimmedEmail || !emailRegex.test(trimmedEmail)) {
      toast.error(t("workspace.invite.err_email_invalid"));
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
        toast.error(error.message || t("workspace.invite.err_send_failed"));
        return;
      }

      if (!data?.ok) {
        toast.error((data as any)?.message || t("workspace.invite.err_send_failed"));
        return;
      }

      const result = (data as any)?.data?.results?.[0];
      if (result) {
        if (result.code === "INVITE_RESENT")   toast.success(t("workspace.invite.resent", { email: trimmedEmail }));
        else if (result.code === "MEMBER_ADDED") toast.success(t("workspace.invite.member_added", { name: trimmedFirst }));
        else if (result.code === "ALREADY_MEMBER") { toast.info(t("workspace.invite.already_member", { email: trimmedEmail })); return; }
        else toast.success(t("workspace.invite.sent", { name: `${trimmedFirst} ${trimmedLast}` }));
      } else {
        toast.success(t("workspace.invite.sent", { name: `${trimmedFirst} ${trimmedLast}` }));
      }

      reset();
      onOpenChange(false);
      onInviteSent();
    } catch (err: any) {
      toast.error(err?.message || t("workspace.invite.err_send_failed"));
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
            {t("workspace.invite.title")}
          </DialogTitle>
          <DialogDescription>
            {t("workspace.invite.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="first-name">
                {t("account.first_name")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="first-name"
                placeholder={t("workspace.invite.first_placeholder")}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="last-name">
                {t("account.last_name")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="last-name"
                placeholder={t("workspace.invite.last_placeholder")}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-email">
              {t("workspace.invite.email_label")} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder={t("workspace.invite.email_placeholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canSubmit && handleInvite()}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="role">{t("workspace.invite.role_label")}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as WorkspaceRole)}>
              <SelectTrigger id="role">
                <SelectValue placeholder={t("workspace.invite.role_placeholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin"><span className="font-medium">{t("workspace.admin")}</span></SelectItem>
                <SelectItem value="editor"><span className="font-medium">{t("workspace.editor")}</span></SelectItem>
                <SelectItem value="viewer"><span className="font-medium">{t("workspace.viewer")}</span></SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(roleDescriptionKeys[role])}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="accent" onClick={handleInvite} disabled={!canSubmit}>
            {isInviting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{t("workspace.invite.sending")}</>
            ) : (
              <><UserPlus className="h-4 w-4 mr-2" />{t("workspace.invite.send")}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
