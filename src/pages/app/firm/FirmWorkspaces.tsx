import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Layers, ShieldOff, ShieldCheck, LogOut } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { FirmPageHeader } from "@/components/firm/FirmPageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useFirm } from "@/contexts/FirmContext";
import { useAuth } from "@/contexts/AuthContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";

type ChildRow = { id: string; name: string; firm_child_label: string | null; restrict_firm_access: boolean; owner_id: string };

export default function FirmWorkspaces() {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { currentFirm, currentFirmRole, isFirmUser, isLoading, refreshFirm } = useFirm();
  const { user: authUser } = useAuth();
  const firmId = currentFirm?.firm_id;
  const isFirmOwner = currentFirmRole === "owner";

  const { data: children = [] } = useQuery({
    queryKey: ["firm-workspaces", firmId],
    enabled: Boolean(firmId),
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("workspaces").select("id, name, firm_child_label, restrict_firm_access, owner_id").eq("firm_id", firmId).order("name");
      return (data ?? []) as ChildRow[];
    },
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: ["firm-workspaces", firmId] }); void refreshFirm(); };

  const toggleRestrict = async (ws: ChildRow, restrict: boolean) => {
    const { data, error } = await supabase.functions.invoke("set-firm-access", { body: { workspaceId: ws.id, restrict } });
    if (error || (data && (data as any).ok === false)) { toast.error(t("firm.workspaces.restrict_failed", { defaultValue: "Could not update visibility" })); return; }
    toast.success(restrict ? t("firm.workspaces.restricted", { defaultValue: "Workspace restricted" }) : t("firm.workspaces.unrestricted", { defaultValue: "Workspace visible to firm" }));
    refresh();
  };

  const release = async (ws: ChildRow) => {
    const { data, error } = await supabase.functions.invoke("release-workspace-from-firm", { body: { workspaceId: ws.id, firmId } });
    if (error || (data && (data as any).ok === false)) { toast.error(t("firm.workspaces.release_failed", { defaultValue: "Could not release workspace" })); return; }
    toast.success(t("firm.workspaces.released", { defaultValue: "Workspace released from firm" }));
    refresh();
  };

  if (!isLoading && !isFirmUser) {
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto py-16 text-center">
          <Layers className="h-10 w-10 mx-auto text-muted-foreground/50 mb-4" />
          <h1 className="text-xl font-semibold">{t("firm.none_title")}</h1>
          <Button className="mt-6" onClick={() => navigate("/app/dashboard")}>{t("firm.back_to_workspace")}</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto space-y-5">
        <FirmPageHeader icon={Layers} title={t("firm.workspaces.title")} subtitle={t("firm.workspaces.subtitle")} />

        {children.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">{t("firm.workspaces.none")}</Card>
        ) : (
          <div className="space-y-2">
            {children.map((ws) => {
              const ownsThis = authUser?.id === ws.owner_id;
              return (
                <Card key={ws.id} className="p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium truncate">{ws.firm_child_label || ws.name}</span>
                    {ws.restrict_firm_access ? <Badge variant="outline" className="text-[10px]">{t("firm.restricted_badge")}</Badge> : null}
                  </div>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    {/* restrict_firm_access toggle — WORKSPACE OWNER only (server-enforced). */}
                    <div className="flex items-center gap-2">
                      {ws.restrict_firm_access ? <ShieldOff className="h-4 w-4 text-muted-foreground" /> : <ShieldCheck className="h-4 w-4 text-muted-foreground" />}
                      <div className="flex flex-col">
                        <span className="text-xs font-medium">{t("firm.workspaces.restrict_label")}</span>
                        <span className="text-[11px] text-muted-foreground">{ownsThis ? t("firm.workspaces.restrict_hint") : t("firm.workspaces.restrict_owner_only")}</span>
                      </div>
                      <Switch checked={ws.restrict_firm_access} disabled={!ownsThis} onCheckedChange={(v) => toggleRestrict(ws, v)} />
                    </div>
                    {/* Release — firm owner or the workspace owner (server-enforced). */}
                    {(isFirmOwner || ownsThis) ? (
                      <Button size="sm" variant="ghost" onClick={() => release(ws)}>
                        <LogOut className="h-3.5 w-3.5 mr-1" />{t("firm.workspaces.release")}
                      </Button>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
