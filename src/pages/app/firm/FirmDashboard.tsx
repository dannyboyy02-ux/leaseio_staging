import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Building2, Inbox, Users, FileText, Layers, ArrowRight } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useFirm } from "@/contexts/FirmContext";
import { useApp } from "@/contexts/AppContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";

type ChildUsage = {
  workspace_id: string;
  workspace_name: string;
  firm_child_label: string | null;
  restrict_firm_access: boolean;
  active_leases: number;
  total_documents: number;
  direct_members: number;
};

export default function FirmDashboard() {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const { currentFirm, currentFirmRole, isFirmUser, isLoading, pendingActionsCount } = useFirm();
  const { switchWorkspace } = useApp();

  const openWorkspace = async (workspaceId: string) => {
    await switchWorkspace(workspaceId);
    navigate("/app/dashboard");
  };

  const { data: childUsage = [], isLoading: usageLoading } = useQuery({
    queryKey: ["firm-child-usage", currentFirm?.firm_id],
    enabled: Boolean(currentFirm?.firm_id),
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from("v_firm_child_usage")
        .select("workspace_id, workspace_name, firm_child_label, restrict_firm_access, active_leases, total_documents, direct_members")
        .eq("firm_id", currentFirm!.firm_id);
      return (data ?? []) as ChildUsage[];
    },
  });

  if (!isLoading && !isFirmUser) {
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto py-16 text-center">
          <Building2 className="h-10 w-10 mx-auto text-muted-foreground/50 mb-4" />
          <h1 className="text-xl font-semibold">{t("firm.none_title")}</h1>
          <p className="text-sm text-muted-foreground mt-2">{t("firm.none_desc")}</p>
          <Button className="mt-6" onClick={() => navigate("/app/dashboard")}>{t("firm.back_to_workspace")}</Button>
        </div>
      </AppLayout>
    );
  }

  const totals = childUsage.reduce(
    (acc, c) => ({
      leases: acc.leases + (c.active_leases ?? 0),
      docs: acc.docs + (c.total_documents ?? 0),
    }),
    { leases: 0, docs: 0 },
  );

  const stat = (icon: React.ReactNode, label: string, value: React.ReactNode) => (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-muted-foreground">{icon}<span className="text-xs">{label}</span></div>
      <p className="text-2xl font-semibold mt-1">{value}</p>
    </Card>
  );

  return (
    <AppLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" />
              <h1 className="text-2xl font-semibold">{currentFirm?.firm_name ?? t("firm.fallback")}</h1>
              {currentFirmRole ? <Badge variant="secondary" className="text-[10px]">{t(`firm.role.${currentFirmRole}`)}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground mt-1">{t("firm.dashboard.subtitle")}</p>
          </div>
          <Button variant="outline" asChild>
            <Link to="/app/firm/inbox" className="flex items-center gap-2">
              <Inbox className="h-4 w-4" />
              {t("firm.nav.inbox")}
              {pendingActionsCount > 0 ? <Badge className="ml-1">{pendingActionsCount}</Badge> : null}
            </Link>
          </Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stat(<Layers className="h-4 w-4" />, t("firm.dashboard.children"), childUsage.length)}
          {stat(<FileText className="h-4 w-4" />, t("firm.dashboard.active_leases"), totals.leases)}
          {stat(<FileText className="h-4 w-4" />, t("firm.dashboard.documents"), totals.docs)}
          {stat(<Inbox className="h-4 w-4" />, t("firm.dashboard.pending_actions"), pendingActionsCount)}
        </div>

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">{t("firm.dashboard.workspaces_heading")}</h2>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/app/firm/members" className="flex items-center gap-1 text-xs">
              <Users className="h-3.5 w-3.5" />{t("firm.nav.members")}
            </Link>
          </Button>
        </div>

        {usageLoading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading", { defaultValue: "Loading…" })}</p>
        ) : childUsage.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">{t("firm.dashboard.no_children")}</Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {childUsage.map((c) => (
              <Card
                key={c.workspace_id}
                onClick={() => openWorkspace(c.workspace_id)}
                className="p-4 space-y-2 cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-colors"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter") openWorkspace(c.workspace_id); }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{c.firm_child_label || c.workspace_name}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {c.restrict_firm_access ? <Badge variant="outline" className="text-[10px]">{t("firm.restricted_badge")}</Badge> : null}
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>{t("firm.dashboard.leases_n", { count: c.active_leases ?? 0 })}</span>
                  <span>{t("firm.dashboard.members_n", { count: c.direct_members ?? 0 })}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
