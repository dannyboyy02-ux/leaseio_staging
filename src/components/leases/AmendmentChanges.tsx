import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface AmendmentChange {
  field: string;
  old_value: string | null;
  new_value: string | null;
  change_type?: 'modified' | 'added' | 'removed';
}

interface AmendmentChangesProps {
  changes: AmendmentChange[];
}

// Field display name mapping
const FIELD_LABELS: Record<string, string> = {
  landlord_name: 'Landlord',
  tenant_name: 'Tenant',
  property_address: 'Property Address',
  lease_start: 'Lease Start',
  lease_end: 'Lease End',
  rent_commencement_date: 'Rent Commencement',
  current_monthly_rent: 'Monthly Rent',
  base_rent_amount: 'Base Rent',
  base_rent_frequency: 'Rent Frequency',
  security_deposit: 'Security Deposit',
  rent_escalation_type: 'Escalation Type',
  square_footage: 'Square Footage',
  renewal_options: 'Renewal Options',
  termination_clauses: 'Termination Clauses',
  escalation_clauses: 'Escalation Clauses',
};

export function AmendmentChanges({ changes }: AmendmentChangesProps) {
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
        return <Badge variant="outline" className="text-[9px] text-green-600 border-green-400 bg-green-50">Added</Badge>;
      case 'removed':
        return <Badge variant="outline" className="text-[9px] text-red-600 border-red-400 bg-red-50">Removed</Badge>;
      case 'modified':
      default:
        return <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-400 bg-amber-50">Changed</Badge>;
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
          Amendment Changes
          <Badge variant="outline" className="ml-1 text-orange-600 border-orange-400">
            {changes.length} field{changes.length !== 1 ? 's' : ''}
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
                {FIELD_LABELS[change.field] || change.field}
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
