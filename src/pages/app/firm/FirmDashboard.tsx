import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Building2, Inbox, Users, FileText, Layers, ArrowRight } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { PageLayout } from "@/components/layout/PageLayout";
import { FirmNotMemberState } from "@/components/firm/FirmNotMemberState";
import { Card } from "@/components/ui/card";
import { StatTile } from "@/components/ui/stat-tile";
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

  const { data: firmRow } = useQuery({
    queryKey: ["firm-billed-children", currentFirm?.firm_id],
    enabled: Boolean(currentFirm?.firm_id),
    queryFn: async () => {
      // Typed client (firms.child_workspaces_used is in the generated types) —
      // a future column rename fails at compile time instead of silently.
      const { data } = await supabase
        .from("firms")
        .select("child_workspaces_used")
        .eq("id", currentFirm!.firm_id)
        .maybeSingle();
      return data ?? null;
    },
  });

  if (!isLoading && !isFirmUser) {
    return <FirmNotMemberState icon={Building2} />;
  }

  const totals = childUsage.reduce(
    (acc, c) => ({
      leases: acc.leases + (c.active_leases ?? 0),
      docs: acc.docs + (c.total_documents ?? 0),
    }),
    { leases: 0, docs: 0 },
  );

  // Billed children (bind/release maintain the counter) vs children visible to THIS
  // user — restrict_firm_access children are RLS-hidden from firm staff but still
  // bound and billed (#177d). Show the billed truth; the note explains the gap.
  const billedChildren = firmRow?.child_workspaces_used ?? null;
  const childrenCount = billedChildren != null ? Math.max(billedChildren, childUsage.length) : childUsage.length;
  const hiddenChildren = Math.max(0, childrenCount - childUsage.length);

  const stat = (icon: React.ReactNode, label: string, value: React.ReactNode) => (
    <StatTile icon={icon} label={label} value={value} />
  );

  return (
    <AppLayout>
      <AppHeader
        icon={Building2}
        title={currentFirm?.firm_name ?? t("firm.fallback")}
        subtitle={t("firm.dashboard.subtitle")}
        badge={currentFirmRole ? <Badge variant="secondary" className="text-[10px]">{t(`firm.role.${currentFirmRole}`)}</Badge> : null}
        actions={
          <Button variant="outline" asChild>
            <Link to="/app/firm/inbox" className="flex items-center gap-2">
              <Inbox className="h-4 w-4" />
              {t("firm.nav.inbox")}
              {pendingActionsCount > 0 ? <Badge className="ml-1">{pendingActionsCount > 99 ? "99+" : pendingActionsCount}</Badge> : null}
            </Link>
          </Button>
        }
      />
      <PageLayout width="default">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {stat(<Layers className="h-4 w-4" />, t("firm.dashboard.children"), childrenCount)}
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
          <Card className="p-8 text-center text-sm text-muted-foreground">
            {hiddenChildren > 0 ? t("firm.dashboard.restricted_hidden", { count: hiddenChildren }) : t("firm.dashboard.no_children")}
          </Card>
        ) : (
          // space-y-2 keeps the note reading as the grid's caption, not an
          // orphan section floating in the page's space-y-6 rhythm.
          <div className="space-y-2">
            {hiddenChildren > 0 ? (
              <p className="text-xs text-muted-foreground">{t("firm.dashboard.restricted_hidden", { count: hiddenChildren })}</p>
            ) : null}
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
          </div>
        )}
      </PageLayout>
    </AppLayout>
  );
}
