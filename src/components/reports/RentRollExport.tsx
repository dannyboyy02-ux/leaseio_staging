import { useState } from 'react';
import { Download, Loader2, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { canExportReports } from '@/lib/authorization';
import { getExtractedFieldValue } from '@/lib/extractedFieldHelpers';
import { escapeCsvCell } from '@/lib/csv';

interface LeaseData {
  id: string;
  filename: string;
  landlord_name: string | null;
  tenant_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  current_monthly_rent: number | null;
  base_rent_amount: string | null;
  base_rent_frequency: string | null;
  rent_escalation_type: string | null;
  extracted_json: Record<string, unknown> | null;
}

export function RentRollExport() {
  const [isExporting, setIsExporting] = useState(false);
  const { t } = useLanguage();
  const { userRole, workspace } = useApp();
  const canExport = canExportReports(userRole);

  const formatCurrency = (amount: number | string | null): string => {
    if (!amount) return '';
    const num = typeof amount === 'string' ? parseFloat(amount.replace(/[^0-9.-]/g, '')) : amount;
    if (isNaN(num)) return '';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(num);
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return '';
    try {
      return format(new Date(dateStr), 'MM/dd/yyyy');
    } catch {
      return dateStr;
    }
  };

  const calculateDaysRemaining = (endDate: string | null): number | null => {
    if (!endDate) return null;
    const end = new Date(endDate);
    const today = new Date();
    const diffTime = end.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  const exportToCSV = async () => {
    if (!canExport) {
      toast.error(t('reports.export_restricted'));
      return;
    }
    setIsExporting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      if (!workspace?.id) {
        toast.error('No workspace selected');
        return;
      }

      // Workspace scoping mandatory — exports for the active workspace only.
      // Replaces the previous user_id filter, which would have mixed data
      // for users with leases in multiple workspaces.
      const { data: leases, error } = await supabase
        .from('leases')
        .select('*')
        .eq('workspace_id', workspace.id)
        // #118 (R2): a rent roll lists leases actually ON THE BOOKS — executed
        // or active — keyed on lifecycle_status (the legacy `status` column is
        // the doc-pipeline state and diverges: a draft can be status='Ready', an
        // active lease status='Uploaded'). Pre-signature pipeline
        // (approved/in_negotiation/final_review), terminal states, and archived
        // leases are excluded so the run-rate totals reflect committed rent only.
        .in('lifecycle_status', [
          'executed', 'fully_executed', 'pending_counter_signature', 'active',
        ])
        .eq('archived', false)
        .order('lease_end', { ascending: true });

      if (error) throw error;

      if (!leases || leases.length === 0) {
        toast.error('No leases to export');
        return;
      }

      const totalMonthly = leases.reduce((sum, l) => sum + (l.current_monthly_rent || 0), 0);
      const totalAnnual = totalMonthly * 12;

      const headers = [
        'Property Address',
        'Tenant',
        'Landlord',
        'Lease Start',
        'Lease End',
        'Days Remaining',
        'Monthly Rent',
        'Annual Rent',
        'Rent Frequency',
        'Escalation Type',
      ];

      const rows = leases.map((lease) => {
        const monthly = lease.current_monthly_rent || 0;
        const extractedJson = lease.extracted_json as Record<string, unknown> | null;
        const propertyAddress =
          getExtractedFieldValue(extractedJson?.property_address) ||
          lease.filename ||
          'Unknown';
        return [
          propertyAddress,
          lease.tenant_name || '',
          lease.landlord_name || '',
          formatDate(lease.lease_start),
          formatDate(lease.lease_end),
          calculateDaysRemaining(lease.lease_end) ?? '',
          formatCurrency(monthly),
          formatCurrency(monthly * 12),
          lease.base_rent_frequency || 'Monthly',
          lease.rent_escalation_type || '',
        ];
      });

      rows.push([]);
      rows.push(['PORTFOLIO SUMMARY', '', '', '', '', '', '', '', '', '']);
      rows.push(['Total Active Leases', String(leases.length), '', '', '', '', '', '', '', '']);
      rows.push(['Total Monthly Rent', formatCurrency(totalMonthly), '', '', '', '', '', '', '', '']);
      rows.push(['Total Annual Rent (run-rate)', formatCurrency(totalAnnual), '', '', '', '', '', '', '', '']);

      const csvContent = [
        headers.map(escapeCsvCell).join(','),
        ...rows.map(row => row.map(escapeCsvCell).join(',')),
      ].join('\n');

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `rent-roll-${format(new Date(), 'yyyy-MM-dd')}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${leases.length} leases to CSV`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export rent roll');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5" />
          {t('reports.rent_roll')}
        </CardTitle>
        <CardDescription>
          {t('reports.rent_roll_desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          {t('reports.rent_roll_details')}
        </p>
        <Button onClick={exportToCSV} disabled={isExporting || !canExport}>
          {isExporting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          {isExporting ? t('reports.generating') : t('reports.download_rent_roll')}
        </Button>
      </CardContent>
    </Card>
  );
}
