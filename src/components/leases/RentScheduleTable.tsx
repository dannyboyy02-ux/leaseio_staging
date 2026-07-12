import { useState } from 'react';
import { Calendar, DollarSign, TrendingUp, Sparkles, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedDate, formatLocalizedCurrency, parseToLocalDate } from '@/lib/dateFormatters';

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
  isLocked?: boolean;
  onScheduleChange?: (updated: RentScheduleEntry[]) => void;
  onGenerateSchedule?: (mode: 'single' | 'annual') => void;
  canGenerate?: boolean; // true when base_rent + lease_start exist
  className?: string;
}

export function RentScheduleTable({
  rentSchedule,
  currentMonthlyRent,
  rentEscalationType,
  isLocked = true,
  onScheduleChange,
  onGenerateSchedule,
  canGenerate = false,
  className,
}: RentScheduleTableProps) {
  const { t, language } = useLanguage();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<RentScheduleEntry>>({});

  const formatCurrency = (amount: number | null) => formatLocalizedCurrency(amount, language);
  const formatDate = (dateStr: string | null) => formatLocalizedDate(dateStr, language);

  const today = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  const getCurrentPeriodId = () => {
    for (const period of rentSchedule) {
      const start = parseToLocalDate(period.period_start);
      const end = period.period_end ? parseToLocalDate(period.period_end) : null;
      if (start <= today && (!end || end >= today)) return period.id;
    }
    return null;
  };
  const currentPeriodId = getCurrentPeriodId();

  const getNextIncrease = () => {
    const sorted = [...rentSchedule].sort(
      (a, b) => parseToLocalDate(a.period_start).getTime() - parseToLocalDate(b.period_start).getTime()
    );
    for (const p of sorted) {
      if (parseToLocalDate(p.period_start) > today) return { date: p.period_start, amount: p.monthly_amount };
    }
    return null;
  };
  const nextIncrease = getNextIncrease();

  const startEdit = (period: RentScheduleEntry) => {
    setEditingId(period.id);
    setEditValues({
      period_start: period.period_start,
      period_end: period.period_end ?? '',
      monthly_amount: period.monthly_amount,
      notes: period.notes ?? '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({});
  };

  const saveEdit = (id: string) => {
    if (!onScheduleChange) return;
    const monthly = editValues.monthly_amount ? Number(editValues.monthly_amount) : null;
    const updated = rentSchedule.map(p =>
      p.id === id
        ? {
            ...p,
            period_start: (editValues.period_start as string) || p.period_start,
            period_end: (editValues.period_end as string) || null,
            monthly_amount: monthly,
            annual_amount: monthly ? monthly * 12 : null,
            notes: (editValues.notes as string) || null,
          }
        : p
    );
    onScheduleChange(updated);
    setEditingId(null);
    setEditValues({});
  };

  const deleteRow = (id: string) => {
    if (!onScheduleChange) return;
    onScheduleChange(rentSchedule.filter(p => p.id !== id));
  };

  const addRow = () => {
    if (!onScheduleChange) return;
    const lastPeriod = [...rentSchedule].sort(
      (a, b) => parseToLocalDate(a.period_start).getTime() - parseToLocalDate(b.period_start).getTime()
    ).at(-1);
    const formatLocalYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const newStart = lastPeriod?.period_end
      ? (() => {
          const d = parseToLocalDate(lastPeriod.period_end);
          d.setDate(d.getDate() + 1);
          return formatLocalYmd(d);
        })()
      : formatLocalYmd(new Date());

    const newRow: RentScheduleEntry = {
      id: `new-${Date.now()}`,
      period_start: newStart,
      period_end: null,
      monthly_amount: lastPeriod?.monthly_amount ?? null,
      annual_amount: lastPeriod?.annual_amount ?? null,
      notes: null,
    };
    onScheduleChange([...rentSchedule, newRow]);
    setEditingId(newRow.id);
    setEditValues({
      period_start: newRow.period_start,
      period_end: '',
      monthly_amount: newRow.monthly_amount,
      notes: '',
    });
  };

  const sorted = [...rentSchedule].sort(
    (a, b) => parseToLocalDate(a.period_start).getTime() - parseToLocalDate(b.period_start).getTime()
  );

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <DollarSign className="h-5 w-5" />
          {t('rent_schedule.title')}
        </CardTitle>
        <CardDescription>{t('rent_schedule.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="bg-primary/5 rounded-lg p-4 border border-primary/10">
            <p className="text-sm text-muted-foreground">{t('rent_schedule.current_monthly')}</p>
            <p className="text-2xl font-semibold text-primary">{formatCurrency(currentMonthlyRent)}</p>
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
              <p className="text-lg font-medium">{formatDate(nextIncrease.date)}</p>
              <p className="text-sm text-yellow-600">
                → {formatCurrency(nextIncrease.amount)}/{t('common.per_month_short')}
              </p>
            </div>
          )}
        </div>

        {/* Rent Schedule Table */}
        {sorted.length > 0 ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('rent_schedule.period')}</TableHead>
                  <TableHead className="text-right">{t('rent_schedule.monthly')}</TableHead>
                  <TableHead className="text-right">{t('rent_schedule.annual')}</TableHead>
                  <TableHead>{t('rent_schedule.notes')}</TableHead>
                  {!isLocked && <TableHead className="w-16" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((period) => {
                  const isEditing = editingId === period.id;
                  return (
                    <TableRow
                      key={period.id}
                      className={cn(period.id === currentPeriodId && 'bg-primary/5')}
                    >
                      {isEditing ? (
                        <>
                          <TableCell>
                            <div className="flex gap-1">
                              <Input
                                type="date"
                                value={editValues.period_start as string || ''}
                                onChange={e => setEditValues(v => ({ ...v, period_start: e.target.value }))}
                                className="h-7 text-xs w-32"
                              />
                              <span className="self-center text-muted-foreground">–</span>
                              <Input
                                type="date"
                                value={editValues.period_end as string || ''}
                                onChange={e => setEditValues(v => ({ ...v, period_end: e.target.value }))}
                                className="h-7 text-xs w-32"
                                placeholder={t('rent_schedule.ongoing')}
                              />
                            </div>
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              value={editValues.monthly_amount ?? ''}
                              onChange={e => setEditValues(v => ({ ...v, monthly_amount: parseFloat(e.target.value) }))}
                              className="h-7 text-xs w-28 text-right ml-auto"
                            />
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground text-xs">
                            {editValues.monthly_amount
                              ? formatCurrency((editValues.monthly_amount as number) * 12)
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <Input
                              value={editValues.notes as string || ''}
                              onChange={e => setEditValues(v => ({ ...v, notes: e.target.value }))}
                              className="h-7 text-xs"
                              placeholder={t('rent_schedule.notes')}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-green-600" onClick={() => saveEdit(period.id)}>
                                <Check size={12} />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={cancelEdit}>
                                <X size={12} />
                              </Button>
                            </div>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4 text-muted-foreground" />
                              <span>
                                {formatDate(period.period_start)}
                                {' – '}
                                {period.period_end ? formatDate(period.period_end) : t('rent_schedule.ongoing')}
                              </span>
                              {period.id === currentPeriodId && (
                                <Badge variant="secondary" className="ml-2">{t('rent_schedule.current')}</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(period.monthly_amount)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {formatCurrency(
                              period.annual_amount ??
                                (period.monthly_amount != null ? period.monthly_amount * 12 : null)
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">{period.notes || '—'}</TableCell>
                          {!isLocked && (
                            <TableCell>
                              <div className="flex gap-1 justify-end">
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-primary" onClick={() => startEdit(period)}>
                                  <Pencil size={11} />
                                </Button>
                                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => deleteRow(period.id)}>
                                  <Trash2 size={11} />
                                </Button>
                              </div>
                            </TableCell>
                          )}
                        </>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {!isLocked && (
              <div className="px-3 py-2 border-t">
                <Button variant="ghost" size="sm" className="text-xs h-7" onClick={addRow}>
                  <Plus size={12} className="mr-1" />
                  {t('rent_schedule.add_period')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>{t('rent_schedule.no_schedule')}</p>
            <p className="text-sm">{t('rent_schedule.check_base_rent')}</p>
            {!isLocked && canGenerate && onGenerateSchedule && (
              <div className="flex gap-2 justify-center mt-3">
                <Button size="sm" variant="outline" onClick={() => onGenerateSchedule('single')}>
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  {t('rent_schedule.single_period')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onGenerateSchedule('annual')}>
                  <TrendingUp className="h-3.5 w-3.5 mr-1.5" />
                  {t('rent_schedule.generate_annual')}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
