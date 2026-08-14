import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { PageLayout } from "@/components/layout/PageLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Mail, ExternalLink } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function Support() {
  const { t } = useLanguage();
  
  return (
    <AppLayout>
      <AppHeader 
        title={t('support.title')} 
        subtitle={t('support.description')} 
      />
      
      {/* narrow: an action card + an FAQ list is a focused single-column page.
          (The old hand-rolled left-aligned 2-col grid died with the FS-14
          "Documentation — Coming Soon" card removal.) */}
      <PageLayout width="narrow">
          {/* Email Support. (The old "Documentation — Coming Soon" card was a
              disabled dead-end (FS-14); removed until real docs exist.) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5 text-primary" />
                {t('support.email_title')}
              </CardTitle>
              <CardDescription>{t('support.email_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" asChild>
                <a href="mailto:support@theleaseio.com">
                  {t('support.contact_email')}
                  <ExternalLink className="ml-2 h-4 w-4" />
                </a>
              </Button>
            </CardContent>
          </Card>

          {/* FAQ */}
          <Card>
            <CardHeader>
              <CardTitle>{t('support.faq_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="border-b pb-4">
                <p className="font-medium">{t('support.faq1_q')}</p>
                <p className="text-muted-foreground text-sm mt-1">{t('support.faq1_a')}</p>
              </div>
              
              <div className="border-b pb-4">
                <p className="font-medium">{t('support.faq2_q')}</p>
                <p className="text-muted-foreground text-sm mt-1">{t('support.faq2_a')}</p>
              </div>
              
              <div>
                <p className="font-medium">{t('support.faq3_q')}</p>
                <p className="text-muted-foreground text-sm mt-1">{t('support.faq3_a')}</p>
              </div>
            </CardContent>
          </Card>
      </PageLayout>
    </AppLayout>
  );
}
