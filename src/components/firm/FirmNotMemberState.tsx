import { type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { AppLayout } from "@/components/layout/AppLayout";
import { PageLayout } from "@/components/layout/PageLayout";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/useAppTranslation";

/**
 * Shared "you're not a firm user" full-page state for the /app/firm/* pages
 * (Cluster C). Each firm page previously hand-rolled this identical centered
 * block at its own arbitrary max-width; this renders it once, at one width,
 * with consistent copy. Pass the page's own lucide icon for continuity.
 */
export function FirmNotMemberState({ icon: Icon }: { icon: LucideIcon }) {
  const { t } = useAppTranslation();
  const navigate = useNavigate();
  return (
    <AppLayout>
      <PageLayout width="narrow">
        <div className="py-16 text-center">
          <Icon className="h-10 w-10 mx-auto text-muted-foreground/50 mb-4" />
          <h1 className="text-xl font-semibold">{t("firm.none_title")}</h1>
          <p className="text-sm text-muted-foreground mt-2">{t("firm.none_desc")}</p>
          <Button className="mt-6" onClick={() => navigate("/app/dashboard")}>
            {t("firm.back_to_workspace")}
          </Button>
        </div>
      </PageLayout>
    </AppLayout>
  );
}
