import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Users, UserPlus, Mail, Trash2, RefreshCw } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useFirm } from "@/contexts/FirmContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";
import { isFirmAdminOrOwner } from "@/lib/firmAccess";

type Member = { user_id: string; role: string; email: string | null; first_name: string | null; last_name: string | null };
type Invite = { id: string; email: string; role: string; invited_at: string };

export default function FirmMembers() {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { currentFirm, currentFirmRole, isFirmUser, isLoading } = useFirm();
  const firmId = currentFirm?.firm_id;
  const canManage = isFirmAdminOrOwner({ isOwner: currentFirmRole === "owner", firmRole: currentFirmRole === "owner" ? null : (currentFirmRole as any) });
  const isOwner = currentFirmRole === "owner";

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"firm_member" | "firm_admin">("firm_member");
  const [busy, setBusy] = useState(false);

  const { data: members = [] } = useQuery({
    queryKey: ["firm-members", firmId],
    enabled: Boolean(firmId),
    queryFn: async () => {
      // The owner has no firm_members row (implicit firm_admin) — fetch it from
      // firms.owner_id and prepend, so the roster is complete.
      const [{ data: firm }, { data: rows }] = await Promise.all([
        (supabase as any).from("firms").select("owner_id").eq("id", firmId).maybeSingle(),
        (supabase as any).from("firm_members").select("user_id, role").eq("firm_id", firmId),
      ]);
      const ownerId = (firm as { owner_id?: string } | null)?.owner_id ?? null;
      const memberRows = (rows ?? []).filter((r: any) => r.user_id !== ownerId);
      const roster = [
        ...(ownerId ? [{ user_id: ownerId, role: "owner" }] : []),
        ...memberRows.map((r: any) => ({ user_id: r.user_id, role: r.role })),
      ];
      const ids = roster.map((r) => r.user_id);
      const { data: profiles } = ids.length
        ? await (supabase as any).from("profiles").select("id, email, first_name, last_name").in("id", ids)
        : { data: [] };
      const byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      return roster.map((r) => ({ user_id: r.user_id, role: r.role, ...(byId.get(r.user_id) ?? {}) })) as Member[];
    },
  });

  const { data: invites = [] } = useQuery({
    queryKey: ["firm-invites", firmId],
    enabled: Boolean(firmId),
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("firm_invitations").select("id, email, role, invited_at")
        .eq("firm_id", firmId).is("accepted_at", null).is("revoked_at", null)
        .order("invited_at", { ascending: false });
      return (data ?? []) as Invite[];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["firm-members", firmId] });
    qc.invalidateQueries({ queryKey: ["firm-invites", firmId] });
  };

  const invite = async () => {
    if (!firmId || !email.trim()) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("send-firm-invitation", { body: { firmId, email: email.trim(), role } });
    setBusy(false);
    if (error || (data && (data as any).ok === false)) {
      toast.error(t("firm.members.invite_failed", { defaultValue: "Could not send the invitation" }));
      return;
    }
    toast.success(t("firm.members.invite_sent", { defaultValue: "Invitation sent" }));
    setInviteOpen(false); setEmail(""); setRole("firm_member"); refresh();
  };

  const act = async (fn: string, body: Record<string, unknown>, okMsg: string) => {
    const { data, error } = await supabase.functions.invoke(fn, { body });
    if (error || (data && (data as any).ok === false)) { toast.error(t("firm.members.action_failed", { defaultValue: "Action failed" })); return; }
    toast.success(okMsg); refresh();
  };

  const removeMember = async (userId: string) => {
    const { error } = await (supabase as any).from("firm_members").delete().eq("firm_id", firmId).eq("user_id", userId);
    if (error) { toast.error(t("firm.members.action_failed", { defaultValue: "Action failed" })); return; }
    toast.success(t("firm.members.removed", { defaultValue: "Member removed" })); refresh();
  };

  if (!isLoading && !isFirmUser) {
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto py-16 text-center">
          <Users className="h-10 w-10 mx-auto text-muted-foreground/50 mb-4" />
          <h1 className="text-xl font-semibold">{t("firm.none_title")}</h1>
          <Button className="mt-6" onClick={() => navigate("/app/dashboard")}>{t("firm.back_to_workspace")}</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2"><Users className="h-5 w-5 text-primary" /><h1 className="text-2xl font-semibold">{t("firm.members.title")}</h1></div>
            <p className="text-sm text-muted-foreground mt-1">{t("firm.members.subtitle")}</p>
          </div>
          {canManage ? (
            <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
              <DialogTrigger asChild>
                <Button><UserPlus className="h-4 w-4 mr-2" />{t("firm.members.invite")}</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>{t("firm.members.invite_title")}</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <Input type="email" placeholder={t("firm.members.email_placeholder")} value={email} onChange={(e) => setEmail(e.target.value)} />
                  <Select value={role} onValueChange={(v) => setRole(v as any)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="firm_member">{t("firm.role.firm_member")}</SelectItem>
                      {/* Only the owner can mint firm_admin (server-enforced; hidden otherwise). */}
                      {isOwner ? <SelectItem value="firm_admin">{t("firm.role.firm_admin")}</SelectItem> : null}
                    </SelectContent>
                  </Select>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setInviteOpen(false)}>{t("common.cancel", { defaultValue: "Cancel" })}</Button>
                  <Button onClick={invite} disabled={busy || !email.trim()}>{t("firm.members.send_invite")}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </div>

        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{t("firm.members.roster")}</h2>
          {members.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">{t("firm.members.none")}</Card>
          ) : members.map((m) => (
            <Card key={m.user_id} className="p-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{[m.first_name, m.last_name].filter(Boolean).join(" ") || m.email || m.user_id}</p>
                {m.email ? <p className="text-xs text-muted-foreground truncate">{m.email}</p> : null}
              </div>
              <Badge variant="secondary" className="text-[10px]">{t(`firm.role.${m.role}`)}</Badge>
              {/* Owner can remove admins; admins can remove members; never remove the owner. */}
              {canManage && m.role !== "owner" && (isOwner || m.role === "firm_member") ? (
                <Button size="icon" variant="ghost" onClick={() => removeMember(m.user_id)} aria-label={t("firm.members.remove")}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              ) : null}
            </Card>
          ))}
        </section>

        {invites.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-muted-foreground">{t("firm.members.pending")}</h2>
            {invites.map((inv) => (
              <Card key={inv.id} className="p-3 flex items-center gap-3">
                <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">{t(`firm.role.${inv.role}`)}</p>
                </div>
                {canManage ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => act("resend-firm-invitation", { invitationId: inv.id }, t("firm.members.resent", { defaultValue: "Resent" }))}>
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />{t("firm.members.resend")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => act("revoke-firm-invitation", { invitationId: inv.id }, t("firm.members.revoked", { defaultValue: "Revoked" }))}>
                      {t("firm.members.revoke")}
                    </Button>
                  </>
                ) : null}
              </Card>
            ))}
          </section>
        ) : null}
      </div>
    </AppLayout>
  );
}
