import { FileText, Plus, ArrowRight, Sparkles, CheckCircle, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';

interface EmptyLeaseStateProps {
  onAddLease: () => void;
  /** Vault / read-only retention: suppress the intake CTA (no new leases). */
  readOnly?: boolean;
}

export function EmptyLeaseState({ onAddLease, readOnly = false }: EmptyLeaseStateProps) {
  const { t } = useLanguage();
  return (
    <Card className="border-2 border-dashed border-border">
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted mb-6">
          <FileText className="h-10 w-10 text-muted-foreground" />
        </div>
        <h3 className="text-xl font-semibold mb-2">{t('leases.empty_title')}</h3>
        <p className="text-muted-foreground max-w-md mb-6">
          {t('leases.empty_desc')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8 max-w-2xl">
          <div className="text-left p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h4 className="font-medium text-sm">{t('leases.empty_ai_title')}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{t('leases.empty_ai_desc')}</p>
          </div>

          <div className="text-left p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-5 w-5 text-primary" />
              <h4 className="font-medium text-sm">{t('leases.empty_approval_title')}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{t('leases.empty_approval_desc')}</p>
          </div>

          <div className="text-left p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-2">
              <Bell className="h-5 w-5 text-primary" />
              <h4 className="font-medium text-sm">{t('leases.empty_renewal_title')}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{t('leases.empty_renewal_desc')}</p>
          </div>
        </div>

        {!readOnly && (
          <Button variant="accent" size="lg" onClick={onAddLease}>
            <Plus className="h-5 w-5 mr-2" />
            {t('leases.add_lease')}
            <ArrowRight className="h-5 w-5 ml-2" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
