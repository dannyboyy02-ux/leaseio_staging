import { useState, ReactNode } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';

interface ReviewCardProps {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  sectionKey: string;
  confirmedSections: Set<string>;
  onConfirm: (sectionKey: string) => void;
  isNeedsReview?: boolean;
  renderEditMode?: (isEditing: boolean) => ReactNode;
}

export function ReviewCard({
  title,
  icon,
  children,
  sectionKey,
  confirmedSections,
  onConfirm,
  isNeedsReview = false,
  renderEditMode,
}: ReviewCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const { hasPermission } = useApp();
  const { t } = useLanguage();
  
  const canEdit = hasPermission('leases');
  const isConfirmed = confirmedSections.has(sectionKey);
  const showConfirmButton = isNeedsReview && !isConfirmed;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        <div className="flex items-center gap-2">
          {showConfirmButton && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onConfirm(sectionKey)}
              className="text-green-600 border-green-600/30 hover:bg-green-600/10"
            >
              <Check className="h-4 w-4 mr-1" />
              {t('lease.confirm')}
            </Button>
          )}
          {canEdit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsEditing(!isEditing)}
            >
              {isEditing ? (
                <>
                  <X className="h-4 w-4 mr-1" />
                  {t('common.cancel')}
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4 mr-1" />
                  {t('lease.edit')}
                </>
              )}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {renderEditMode ? renderEditMode(isEditing) : children}
      </CardContent>
    </Card>
  );
}
