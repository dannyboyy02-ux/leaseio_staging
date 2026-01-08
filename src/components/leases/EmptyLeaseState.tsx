import { FileText, Upload, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';

interface EmptyLeaseStateProps {
  onUpload: () => void;
}

export function EmptyLeaseState({ onUpload }: EmptyLeaseStateProps) {
  const { t } = useLanguage();
  
  return (
    <Card variant="ghost" className="border-2 border-dashed border-border">
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold mb-2">{t('empty.no_leases')}</h3>
        <p className="text-sm text-muted-foreground max-w-md mb-6">
          {t('empty.upload_first')}
        </p>
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
