import { FileText, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatCard {
  title: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  variant: 'default' | 'accent' | 'warning' | 'success';
}

const stats: StatCard[] = [
  {
    title: 'Active Leases',
    value: 12,
    icon: FileText,
    variant: 'default',
  },
  {
    title: 'Pending Review',
    value: 3,
    icon: Clock,
    variant: 'accent',
  },
  {
    title: 'Expiring Soon',
    value: 2,
    icon: AlertTriangle,
    variant: 'warning',
  },
  {
    title: 'Finalized This Month',
    value: 5,
    icon: CheckCircle2,
    variant: 'success',
  },
];

const variantStyles = {
  default: 'bg-primary/10 text-primary',
  accent: 'bg-accent/10 text-accent',
  warning: 'bg-warning/10 text-warning',
  success: 'bg-success/10 text-success',
};

export function QuickStats() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat, index) => (
        <Card
          key={stat.title}
          variant="interactive"
          className={cn('animate-fade-up')}
          style={{ animationDelay: `${index * 50}ms` }}
        >
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg',
                  variantStyles[stat.variant]
                )}
              >
                <stat.icon className="h-5 w-5" />
              </div>
              {stat.trend && (
                <span
                  className={cn(
                    'text-xs font-medium',
                    stat.trend.isPositive ? 'text-success' : 'text-destructive'
                  )}
                >
                  {stat.trend.isPositive ? '+' : ''}{stat.trend.value}%
                </span>
              )}
            </div>
            <div className="mt-4">
              <p className="text-2xl font-bold font-display">{stat.value}</p>
              <p className="text-sm text-muted-foreground">{stat.title}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
