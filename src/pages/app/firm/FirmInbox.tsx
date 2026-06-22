import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Inbox, ArrowRight, Clock } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { FirmPageHeader } from "@/components/firm/FirmPageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useFirm } from "@/contexts/FirmContext";
import { useApp } from "@/contexts/AppContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";
import { computeActionUrgency, type ActionUrgency } from "@/lib/firmContext";

type PendingAction = {
  workspace_id: string;
  display_label: string;
  action_type: string;
  action_id: string;
  lease_id: string;
  lease_title: string;
  pending_since: string | null;
};

const URGENCY_VARIANT: Record<ActionUrgency, { variant: "secondary" | "default" | "destructive"; key: string }> = {
  fresh: { variant: "secondary", key: "firm.inbox.urgency_fresh" },
  aging: { variant: "default", key: "firm.inbox.urgency_aging" },
  overdue: { variant: "destructive", key: "firm.inbox.urgency_overdue" },
};

export default function FirmInbox() {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const { currentFirm, isFirmUser, isLoading } = useFirm();
  const { switchWorkspace } = useApp();
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");

  // The inbox aggregates actions across child workspaces; switch the active
  // workspace into the action's workspace before opening the lease, so the lease
  // route resolves in the right scope.
  const openAction = async (workspaceId: string, leaseId: string) => {
    await switchWorkspace(workspaceId);
    navigate(`/app/leases/${leaseId}`);
  };

  const { data: actions = [], isLoading: actionsLoading } = useQuery({
    queryKey: ["firm-inbox", currentFirm?.firm_id],
    enabled: Boolean(currentFirm?.firm_id),
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("v_firm_user_pending_actions")
        .select("workspace_id, display_label, action_type, action_id, lease_id, lease_title, pending_since")
        .eq("firm_id", currentFirm!.firm_id)
        .order("pending_since", { ascending: true });
      return (data ?? []) as PendingAction[];
    },
  });

  const now = Date.now();
  const workspaces = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of actions) m.set(a.workspace_id, a.display_label);
    return [...m.entries()];
  }, [actions]);
  const filtered = workspaceFilter === "all" ? actions : actions.filter((a) => a.workspace_id === workspaceFilter);

  if (!isLoading && !isFirmUser) {
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto py-16 text-center">
          <Inbox className="h-10 w-10 mx-auto text-muted-foreground/50 mb-4" />
          <h1 className="text-xl font-semibold">{t("firm.none_title")}</h1>
          <Button className="mt-6" onClick={() => navigate("/app/dashboard")}>{t("firm.back_to_workspace")}</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-4xl mx-auto space-y-5">
        <FirmPageHeader icon={Inbox} title={t("firm.inbox.title")} subtitle={t("firm.inbox.subtitle")} />

        {workspaces.length > 1 ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={workspaceFilter === "all" ? "default" : "outline"} onClick={() => setWorkspaceFilter("all")}>
              {t("firm.inbox.all_workspaces")}
            </Button>
            {workspaces.map(([id, label]) => (
              <Button key={id} size="sm" variant={workspaceFilter === id ? "default" : "outline"} onClick={() => setWorkspaceFilter(id)}>
                {label}
              </Button>
            ))}
          </div>
        ) : null}

        {actionsLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading", { defaultValue: "Loading…" })}</p>
        ) : filtered.length === 0 ? (
          <Card className="p-10 text-center">
            <Inbox className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">{t("firm.inbox.empty")}</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {filtered.map((a) => {
              const urg = computeActionUrgency(a.pending_since, now);
              const meta = URGENCY_VARIANT[urg];
              return (
                <Card key={a.action_id} className="p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{a.lease_title}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{a.display_label}</Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                      <span>{t(`firm.inbox.action.${a.action_type}`, { defaultValue: a.action_type })}</span>
                      <Clock className="h-3 w-3" />
                      <Badge variant={meta.variant} className="text-[10px]">{t(meta.key)}</Badge>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => openAction(a.workspace_id, a.lease_id)} className="shrink-0">
                    {t("firm.inbox.open")}<ArrowRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
