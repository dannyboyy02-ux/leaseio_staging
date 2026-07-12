import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface AmendmentChange {
  field: string;
  old_value: string | null;
  new_value: string | null;
  change_type?: 'modified' | 'added' | 'removed';
}

interface AmendmentChangesProps {
  changes: AmendmentChange[];
}

// Field display name mapping (values are i18n keys, resolved at render)
const FIELD_LABELS: Record<string, string> = {
  landlord_name: 'lease.landlord',
  tenant_name: 'lease.tenant',
  property_address: 'lease.property_address',
  lease_start: 'amendments.fields.lease_start',
  lease_end: 'amendments.fields.lease_end',
  rent_commencement_date: 'amendments.fields.rent_commencement',
  current_monthly_rent: 'leases.monthly_rent',
  base_rent_amount: 'amendments.fields.base_rent',
  base_rent_frequency: 'lease.rent_frequency',
  security_deposit: 'lease.security_deposit',
  rent_escalation_type: 'rent_schedule.escalation_type',
  square_footage: 'amendments.fields.square_footage',
  renewal_options: 'lease.renewal_options',
  termination_clauses: 'lease.termination_clauses',
  escalation_clauses: 'amendments.fields.escalation_clauses',
};

export function AmendmentChanges({ changes }: AmendmentChangesProps) {
  const { t } = useAppTranslation();
  if (!changes || changes.length === 0) {
    return null;
  }

  const getChangeTypeBadge = (change: AmendmentChange) => {
    const type = change.change_type || (
      !change.old_value ? 'added' : 
      !change.new_value ? 'removed' : 
      'modified'
    );

    switch (type) {
      case 'added':
        return <Badge variant="outline" className="text-[9px] text-green-600 border-green-400 bg-green-50">{t('amendments.changes.added')}</Badge>;
      case 'removed':
        return <Badge variant="outline" className="text-[9px] text-red-600 border-red-400 bg-red-50">{t('amendments.changes.removed')}</Badge>;
      case 'modified':
      default:
        return <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-400 bg-amber-50">{t('amendments.changes.changed')}</Badge>;
    }
  };

  const formatValue = (value: string | null): string => {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    // Truncate long values
    if (value.length > 50) {
      return value.substring(0, 50) + '...';
    }
    return value;
  };

  return (
    <Card className="shadow-none border border-orange-200 bg-orange-50/30 overflow-hidden">
      <CardHeader className="bg-orange-100/50 border-b border-orange-200 py-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2 text-orange-700">
          <ArrowRight size={16} />
          {t('amendments.changes.title')}
          <Badge variant="outline" className="ml-1 text-orange-600 border-orange-400">
            {t('amendments.changes.field_count', { count: changes.length })}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {changes.map((change, index) => (
          <div
            key={index}
            className="p-3 rounded-lg border border-orange-200 bg-background"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium text-sm">
                {FIELD_LABELS[change.field] ? t(FIELD_LABELS[change.field]) : change.field}
              </span>
              {getChangeTypeBadge(change)}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground line-through">
                {formatValue(change.old_value)}
              </span>
              <ArrowRight size={12} className="text-orange-500 shrink-0" />
              <span className="text-foreground font-medium">
                {formatValue(change.new_value)}
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
