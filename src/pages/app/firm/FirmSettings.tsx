import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Settings, Building2 } from "lucide-react";

import { AppLayout } from "@/components/layout/AppLayout";
import { FirmPageHeader } from "@/components/firm/FirmPageHeader";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useFirm } from "@/contexts/FirmContext";
import { useAppTranslation } from "@/hooks/useAppTranslation";

type FirmRow = { id: string; name: string; firm_type: string; billing_email: string };

export default function FirmSettings() {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  const { currentFirm, currentFirmRole, isFirmUser, isLoading, refreshFirm } = useFirm();
  const firmId = currentFirm?.firm_id;
  const isOwner = currentFirmRole === "owner"; // firms UPDATE RLS is owner-only

  const { data: firm } = useQuery({
    queryKey: ["firm-settings", firmId],
    enabled: Boolean(firmId),
    queryFn: async () => {
      const { data } = await (supabase as any).from("firms").select("id, name, firm_type, billing_email").eq("id", firmId).maybeSingle();
      return data as FirmRow | null;
    },
  });

  const [name, setName] = useState("");
  const [firmType, setFirmType] = useState("cpa_firm");
  const [billingEmail, setBillingEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (firm) { setName(firm.name ?? ""); setFirmType(firm.firm_type ?? "cpa_firm"); setBillingEmail(firm.billing_email ?? ""); }
  }, [firm]);

  const save = async () => {
    if (!firmId) return;
    setBusy(true);
    const { error } = await (supabase as any).from("firms").update({ name: name.trim(), firm_type: firmType, billing_email: billingEmail.trim() }).eq("id", firmId);
    setBusy(false);
    if (error) { toast.error(t("firm.settings.save_failed", { defaultValue: "Could not save" })); return; }
    toast.success(t("firm.settings.saved", { defaultValue: "Saved" }));
    void refreshFirm();
  };

  if (!isLoading && !isFirmUser) {
    return (
      <AppLayout>
        <div className="max-w-2xl mx-auto py-16 text-center">
          <Settings className="h-10 w-10 mx-auto text-muted-foreground/50 mb-4" />
          <h1 className="text-xl font-semibold">{t("firm.none_title")}</h1>
          <Button className="mt-6" onClick={() => navigate("/app/dashboard")}>{t("firm.back_to_workspace")}</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="max-w-2xl mx-auto space-y-6">
        <FirmPageHeader icon={Settings} title={t("firm.settings.title")} />

        <Card className="p-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="firm-name">{t("firm.settings.name")}</Label>
            <Input id="firm-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("firm.settings.type")}</Label>
            <Select value={firmType} onValueChange={setFirmType} disabled={!isOwner}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cpa_firm">{t("firm.settings.type_cpa")}</SelectItem>
                <SelectItem value="parent_company">{t("firm.settings.type_parent")}</SelectItem>
                <SelectItem value="other">{t("firm.settings.type_other")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("firm.settings.type_hint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="firm-billing">{t("firm.settings.billing_email")}</Label>
            <Input id="firm-billing" type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} disabled={!isOwner} />
          </div>
          {isOwner ? (
            <div className="flex justify-end">
              <Button onClick={save} disabled={busy || !name.trim()}>{t("firm.settings.save")}</Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Building2 className="h-3.5 w-3.5" />{t("firm.settings.owner_only")}
            </p>
          )}
        </Card>
      </div>
    </AppLayout>
  );
}
