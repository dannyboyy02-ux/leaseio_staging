import { format } from 'date-fns';
import { Calendar, DollarSign, TrendingUp } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface RentScheduleEntry {
  id: string;
  period_start: string;
  period_end: string | null;
  monthly_amount: number | null;
  annual_amount: number | null;
  notes: string | null;
}

interface RentScheduleTableProps {
  rentSchedule: RentScheduleEntry[];
  currentMonthlyRent: number | null;
  rentEscalationType: string | null;
  className?: string;
}

export function RentScheduleTable({
  rentSchedule,
  currentMonthlyRent,
  rentEscalationType,
  className,
}: RentScheduleTableProps) {
  const formatCurrency = (amount: number | null) => {
    if (amount === null || amount === undefined) return '—';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    try {
      return format(new Date(dateStr), 'MMM d, yyyy');
    } catch {
      return dateStr;
    }
  };

  // Determine which period is current
  const today = new Date();
  const getCurrentPeriodId = () => {
    for (const period of rentSchedule) {
      const start = new Date(period.period_start);
      const end = period.period_end ? new Date(period.period_end) : null;
      if (start <= today && (!end || end >= today)) {
        return period.id;
      }
    }
    return null;
  };
  const currentPeriodId = getCurrentPeriodId();

  // Calculate next increase
  const getNextIncrease = () => {
    const sortedSchedule = [...rentSchedule].sort(
      (a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime()
    );
    for (const period of sortedSchedule) {
      const start = new Date(period.period_start);
      if (start > today) {
        return { date: period.period_start, amount: period.monthly_amount };
      }
    }
    return null;
  };
  const nextIncrease = getNextIncrease();

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          Rent Schedule
        </CardTitle>
        <CardDescription>
          Complete rent history extracted from the lease document
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="bg-primary/5 rounded-lg p-4 border border-primary/10">
            <p className="text-sm text-muted-foreground">Current Monthly Rent</p>
            <p className="text-2xl font-semibold text-primary">
              {formatCurrency(currentMonthlyRent)}
            </p>
          </div>
          <div className="bg-muted/50 rounded-lg p-4 border">
            <p className="text-sm text-muted-foreground">Escalation Type</p>
            <p className="text-lg font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              {rentEscalationType || 'Not specified'}
            </p>
          </div>
          {nextIncrease && (
            <div className="bg-yellow-500/5 rounded-lg p-4 border border-yellow-500/20">
              <p className="text-sm text-muted-foreground">Next Increase</p>
              <p className="text-lg font-medium">
                {formatDate(nextIncrease.date)}
              </p>
              <p className="text-sm text-yellow-600">
                → {formatCurrency(nextIncrease.amount)}/mo
              </p>
            </div>
          )}
        </div>

        {/* Rent Schedule Table */}
        {rentSchedule.length > 0 ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Monthly</TableHead>
                  <TableHead className="text-right">Annual</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rentSchedule
                  .sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime())
                  .map((period) => (
                    <TableRow
                      key={period.id}
                      className={cn(
                        period.id === currentPeriodId && 'bg-primary/5'
                      )}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <span>
                            {formatDate(period.period_start)}
                            {' – '}
                            {period.period_end ? formatDate(period.period_end) : 'Ongoing'}
                          </span>
                          {period.id === currentPeriodId && (
                            <Badge variant="secondary" className="ml-2">
                              Current
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCurrency(period.monthly_amount)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatCurrency(period.annual_amount)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {period.notes || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No rent schedule extracted</p>
            <p className="text-sm">Rent information may be in the base rent fields</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
