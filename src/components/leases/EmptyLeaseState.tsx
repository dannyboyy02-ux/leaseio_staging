import { FileText, Upload, ArrowRight, Sparkles, CheckCircle, Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface EmptyLeaseStateProps {
  onUpload: () => void;
}

export function EmptyLeaseState({ onUpload }: EmptyLeaseStateProps) {
  const { t } = useAppTranslation();
  
  return (
    <Card className="border-2 border-dashed border-border">
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted mb-6">
          <FileText className="h-10 w-10 text-muted-foreground" />
        </div>
        <h3 className="text-xl font-semibold mb-2">{t('empty.no_leases')}</h3>
        <p className="text-muted-foreground max-w-md mb-6">
          {t('empty.upload_description')}
        </p>
        
        {/* What You'll Get */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8 max-w-2xl">
          <div className="text-left p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h4 className="font-medium text-sm">{t('empty.benefit1_title')}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{t('empty.benefit1_desc')}</p>
          </div>
          
          <div className="text-left p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-5 w-5 text-primary" />
              <h4 className="font-medium text-sm">{t('empty.benefit2_title')}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{t('empty.benefit2_desc')}</p>
          </div>
          
          <div className="text-left p-4 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-2">
              <Bell className="h-5 w-5 text-primary" />
              <h4 className="font-medium text-sm">{t('empty.benefit3_title')}</h4>
            </div>
            <p className="text-xs text-muted-foreground">{t('empty.benefit3_desc')}</p>
          </div>
        </div>
        
        <Button variant="accent" size="lg" onClick={onUpload}>
          <Upload className="h-5 w-5 mr-2" />
          {t('empty.upload_first_lease')}
          <ArrowRight className="h-5 w-5 ml-2" />
        </Button>
        <p className="text-xs text-muted-foreground mt-4">
          {t('empty.supports_pdf')}
        </p>
      </CardContent>
    </Card>
  );
}
