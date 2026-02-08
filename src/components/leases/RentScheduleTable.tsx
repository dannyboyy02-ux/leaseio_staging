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
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate, formatLocalizedCurrency } from '@/lib/dateFormatters';

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
  const { t, language } = useLanguage();

  const formatCurrency = (amount: number | null) => {
    return formatLocalizedCurrency(amount, language);
  };

  const formatDate = (dateStr: string | null) => {
    return formatLocalizedDate(dateStr, language);
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
          {t('rent_schedule.title')}
        </CardTitle>
        <CardDescription>
          {t('rent_schedule.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="bg-primary/5 rounded-lg p-4 border border-primary/10">
            <p className="text-sm text-muted-foreground">{t('rent_schedule.current_monthly')}</p>
            <p className="text-2xl font-semibold text-primary">
              {formatCurrency(currentMonthlyRent)}
            </p>
          </div>
          <div className="bg-muted/50 rounded-lg p-4 border">
            <p className="text-sm text-muted-foreground">{t('rent_schedule.escalation_type')}</p>
            <p className="text-lg font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              {rentEscalationType || t('rent_schedule.not_specified')}
            </p>
          </div>
          {nextIncrease && (
            <div className="bg-yellow-500/5 rounded-lg p-4 border border-yellow-500/20">
              <p className="text-sm text-muted-foreground">{t('rent_schedule.next_increase')}</p>
              <p className="text-lg font-medium">
                {formatDate(nextIncrease.date)}
              </p>
              <p className="text-sm text-yellow-600">
                → {formatCurrency(nextIncrease.amount)}/{t('common.per_month_short')}
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
                  <TableHead>{t('rent_schedule.period')}</TableHead>
                  <TableHead className="text-right">{t('rent_schedule.monthly')}</TableHead>
                  <TableHead className="text-right">{t('rent_schedule.annual')}</TableHead>
                  <TableHead>{t('rent_schedule.notes')}</TableHead>
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
                            {period.period_end ? formatDate(period.period_end) : t('rent_schedule.ongoing')}
                          </span>
                          {period.id === currentPeriodId && (
                            <Badge variant="secondary" className="ml-2">
                              {t('rent_schedule.current')}
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
            <p>{t('rent_schedule.no_schedule')}</p>
            <p className="text-sm">{t('rent_schedule.check_base_rent')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
