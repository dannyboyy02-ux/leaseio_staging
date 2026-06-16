import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./AuthContext";
import { resolveActiveFirm, type FirmMembership } from "@/lib/firmContext";

// Phase 10 firm-context provider. Mirrors AppContext but for FIRM context: the
// user's firm memberships, the active firm (persisted in profiles.current_firm_id),
// the active firm's child workspaces, and the cross-workspace pending-action
// count. Undefined/empty for non-firm (Plus/Pro) users — the firm UI hides for
// them, so Plus/Pro behavior is unchanged.

export type FirmChildWorkspace = {
  id: string;
  name: string;
  firm_child_label: string | null;
  restrict_firm_access: boolean;
};

type FirmContextValue = {
  firmMemberships: FirmMembership[];
  currentFirm: FirmMembership | null;
  currentFirmRole: FirmMembership["role"] | null;
  childWorkspaces: FirmChildWorkspace[];
  pendingActionsCount: number;
  isFirmUser: boolean;
  isLoading: boolean;
  switchFirm: (firmId: string | null) => Promise<void>;
  refreshFirm: () => Promise<void>;
};

const FirmContext = createContext<FirmContextValue | undefined>(undefined);

export function FirmProvider({ children }: { children: ReactNode }) {
  const { user: authUser, isLoading: authLoading } = useAuth();
  const [firmMemberships, setFirmMemberships] = useState<FirmMembership[]>([]);
  const [currentFirm, setCurrentFirm] = useState<FirmMembership | null>(null);
  const [childWorkspaces, setChildWorkspaces] = useState<FirmChildWorkspace[]>([]);
  const [pendingActionsCount, setPendingActionsCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const loadChildrenAndActions = useCallback(async (firmId: string | null) => {
    if (!firmId) {
      setChildWorkspaces([]);
      setPendingActionsCount(0);
      return;
    }
    const [{ data: kids }, { count }] = await Promise.all([
      (supabase as any)
        .from("workspaces")
        .select("id, name, firm_child_label, restrict_firm_access")
        .eq("firm_id", firmId)
        .order("name", { ascending: true }),
      (supabase as any)
        .from("v_firm_user_pending_actions")
        .select("action_id", { count: "exact", head: true })
        .eq("firm_id", firmId),
    ]);
    setChildWorkspaces((kids ?? []) as FirmChildWorkspace[]);
    setPendingActionsCount(count ?? 0);
  }, []);

  const fetchFirms = useCallback(async () => {
    if (!authUser?.id) {
      setFirmMemberships([]);
      setCurrentFirm(null);
      setChildWorkspaces([]);
      setPendingActionsCount(0);
      setIsLoading(false);
      return;
    }
    try {
      // Owned firms (role 'owner') + firms the user is a member of.
      const [{ data: owned }, { data: memberRows }, { data: profile }] = await Promise.all([
        (supabase as any).from("firms").select("id, name").eq("owner_id", authUser.id),
        (supabase as any)
          .from("firm_members")
          .select("firm_id, role, firms(id, name)")
          .eq("user_id", authUser.id),
        (supabase as any).from("profiles").select("current_firm_id").eq("id", authUser.id).maybeSingle(),
      ]);

      const ownedIds = new Set((owned ?? []).map((f: any) => f.id));
      const memberships: FirmMembership[] = [
        ...(owned ?? []).map((f: any) => ({ firm_id: f.id, firm_name: f.name || "Firm", role: "owner" as const })),
        ...(memberRows ?? [])
          .filter((m: any) => !ownedIds.has(m.firm_id))
          .map((m: any) => ({
            firm_id: m.firm_id,
            firm_name: m.firms?.name || "Firm",
            role: m.role as FirmMembership["role"],
          })),
      ].sort((a, b) => a.firm_name.localeCompare(b.firm_name));

      setFirmMemberships(memberships);
      const active = resolveActiveFirm(memberships, (profile as { current_firm_id?: string | null } | null)?.current_firm_id ?? null);
      setCurrentFirm(active);

      // Persist the resolved firm if it diverged from the stored one.
      if (active && (profile as { current_firm_id?: string | null } | null)?.current_firm_id !== active.firm_id) {
        await (supabase as any).from("profiles").update({ current_firm_id: active.firm_id }).eq("id", authUser.id);
      }

      await loadChildrenAndActions(active?.firm_id ?? null);
    } catch (err) {
      console.error("[FirmContext] fetchFirms error:", err);
      setFirmMemberships([]);
      setCurrentFirm(null);
    } finally {
      setIsLoading(false);
    }
  }, [authUser?.id, loadChildrenAndActions]);

  useEffect(() => {
    if (authLoading) return;
    void fetchFirms();
  }, [authLoading, fetchFirms]);

  const switchFirm = useCallback(
    async (firmId: string | null) => {
      const next = firmId ? firmMemberships.find((m) => m.firm_id === firmId) ?? null : null;
      setCurrentFirm(next);
      if (authUser?.id) {
        await (supabase as any).from("profiles").update({ current_firm_id: next?.firm_id ?? null }).eq("id", authUser.id);
      }
      await loadChildrenAndActions(next?.firm_id ?? null);
    },
    [firmMemberships, authUser?.id, loadChildrenAndActions],
  );

  const value: FirmContextValue = {
    firmMemberships,
    currentFirm,
    currentFirmRole: currentFirm?.role ?? null,
    childWorkspaces,
    pendingActionsCount,
    isFirmUser: firmMemberships.length > 0,
    isLoading,
    switchFirm,
    refreshFirm: fetchFirms,
  };

  return <FirmContext.Provider value={value}>{children}</FirmContext.Provider>;
}

export function useFirm() {
  const ctx = useContext(FirmContext);
  if (!ctx) throw new Error("useFirm must be used within a FirmProvider");
  return ctx;
}
