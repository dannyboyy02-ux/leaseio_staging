import { Download, CheckCircle, AlertTriangle, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface VarianceReportProps {
  leaseFilename: string;
  pipelineMonthly: number | null;
  executedMonthly: number | null;
  variance_monthly_payment: number | null;
  variance_commencement_days: number | null;
  variance_expiry_days: number | null;
  variance_tenant_name_match: boolean | null;
  variance_landlord_name_match: boolean | null;
}

type VS = 'ok' | 'warn' | 'na';

function fmtCurrency(n: number | null, signed = false): string {
  if (n === null) return '\u2014';
  const abs = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(n));
  if (signed && n > 0) return `+${abs}`;
  if (n < 0) return `-${abs}`;
  return abs;
}

function fmtDays(n: number | null): string {
  if (n === null) return '\u2014';
  return `${n > 0 ? '+' : ''}${n} day${Math.abs(n) !== 1 ? 's' : ''}`;
}

function StatusBadge({ s }: { s: VS }) {
  if (s === 'ok') return <Badge variant="outline" className="text-xs text-green-600 border-green-300 gap-1"><CheckCircle className="h-3 w-3" />Match</Badge>;
  if (s === 'warn') return <Badge variant="outline" className="text-xs text-warning border-warning/30 gap-1"><AlertTriangle className="h-3 w-3" />Variance</Badge>;
  return <Badge variant="outline" className="text-xs text-muted-foreground gap-1"><Minus className="h-3 w-3" />N/A</Badge>;
}

const moneyStatus = (v: number | null): VS => v === null ? 'na' : Math.abs(v) < 1 ? 'ok' : 'warn';
const dayStatus = (d: number | null): VS => d === null ? 'na' : Math.abs(d) <= 3 ? 'ok' : 'warn';
const matchStatus = (m: boolean | null): VS => m === null ? 'na' : m ? 'ok' : 'warn';

export function VarianceReport({
  leaseFilename, pipelineMonthly, executedMonthly,
  variance_monthly_payment, variance_commencement_days, variance_expiry_days,
  variance_tenant_name_match, variance_landlord_name_match,
}: VarianceReportProps) {
  const rows = [
    { field: 'Monthly Payment', pipeline: fmtCurrency(pipelineMonthly), executed: fmtCurrency(executedMonthly), variance: fmtCurrency(variance_monthly_payment, true), s: moneyStatus(variance_monthly_payment) },
    { field: 'Commencement Date', pipeline: '\u2014', executed: '\u2014', variance: fmtDays(variance_commencement_days), s: dayStatus(variance_commencement_days) },
    { field: 'Expiry Date', pipeline: '\u2014', executed: '\u2014', variance: fmtDays(variance_expiry_days), s: dayStatus(variance_expiry_days) },
    { field: 'Tenant Name', pipeline: '\u2014', executed: '\u2014', variance: variance_tenant_name_match !== null ? (variance_tenant_name_match ? 'Exact match' : 'Mismatch') : '\u2014', s: matchStatus(variance_tenant_name_match) },
    { field: 'Landlord Name', pipeline: '\u2014', executed: '\u2014', variance: variance_landlord_name_match !== null ? (variance_landlord_name_match ? 'Exact match' : 'Mismatch') : '\u2014', s: matchStatus(variance_landlord_name_match) },
  ];
  const hasVariances = rows.some((r) => r.s === 'warn');

  const downloadCSV = () => {
    const headers = ['Field', 'Pipeline Value', 'Executed Value', 'Variance', 'Status'];
    const csv = [headers, ...rows.map((r) => [r.field, r.pipeline, r.executed, r.variance, r.s === 'ok' ? 'Match' : r.s === 'warn' ? 'Variance' : 'N/A'])]
      .map((row) => row.map((c) => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `variance-report-${leaseFilename.replace(/\.pdf$/i, '')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            {hasVariances ? <AlertTriangle className="h-4 w-4 text-warning" /> : <CheckCircle className="h-4 w-4 text-success" />}
            Variance Report
          </CardTitle>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" onClick={downloadCSV}>
            <Download className="h-3.5 w-3.5" />CSV
          </Button>
        </div>
        {hasVariances && <p className="text-xs text-warning mt-1">Variances detected — review before locking the model.</p>}
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left py-2 px-4 font-medium text-muted-foreground">Field</th>
                <th className="text-left py-2 px-4 font-medium text-muted-foreground">Pipeline</th>
                <th className="text-left py-2 px-4 font-medium text-muted-foreground">Executed</th>
                <th className="text-left py-2 px-4 font-medium text-muted-foreground">Variance</th>
                <th className="text-left py-2 px-4 font-medium text-muted-foreground w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.field} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="py-3 px-4 font-medium">{row.field}</td>
                  <td className="py-3 px-4 text-muted-foreground">{row.pipeline}</td>
                  <td className="py-3 px-4 text-muted-foreground">{row.executed}</td>
                  <td className={cn('py-3 px-4', row.s === 'warn' && 'text-warning font-medium')}>{row.variance}</td>
                  <td className="py-3 px-4"><StatusBadge s={row.s} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
