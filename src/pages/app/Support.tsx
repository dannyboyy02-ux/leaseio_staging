import { AppLayout } from "@/components/layout/AppLayout";
import { AppHeader } from "@/components/layout/AppHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Mail, Book, ExternalLink } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

export default function Support() {
  const { t } = useLanguage();
  
  return (
    <AppLayout>
      <AppHeader 
        title={t('support.title')} 
        subtitle={t('support.description')} 
      />
      
      <div className="p-6">
        <div className="grid gap-6 md:grid-cols-2 max-w-4xl">
          {/* Email Support */}
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
          
          {/* Documentation */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Book className="h-5 w-5 text-primary" />
                {t('support.docs_title')}
              </CardTitle>
              <CardDescription>{t('support.docs_desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" disabled>
                {t('support.coming_soon')}
              </Button>
            </CardContent>
          </Card>
          
          {/* FAQ */}
          <Card className="md:col-span-2">
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
        </div>
      </div>
    </AppLayout>
  );
}
