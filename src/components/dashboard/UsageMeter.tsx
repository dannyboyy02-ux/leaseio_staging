import { Link } from 'react-router-dom';
import { FileText, ArrowRight, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import { PLANS, PLAN_ORDER, getPlanIndex } from '@/config/pricing';
import type { SubscriptionPlan } from '@/types';

export function UsageMeter() {
  const { workspace } = useApp();

  if (!workspace) return null;

  const usagePercent = (workspace.documentsUsed / workspace.documentLimit) * 100;
  const isNearLimit = usagePercent >= 75;
  const isAtLimit = usagePercent >= 100;

  const getVariant = () => {
    if (isAtLimit) return 'destructive';
    if (isNearLimit) return 'warning';
    return 'accent';
  };

  const renewalDate = new Date(workspace.renewalDate).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Get the next tier for upgrade messaging
  const currentPlanIndex = getPlanIndex(workspace.plan);
  const nextTier = currentPlanIndex < PLAN_ORDER.length - 1 
    ? PLANS[PLAN_ORDER[currentPlanIndex + 1] as SubscriptionPlan]
    : null;

  const getPlanBadgeVariant = (plan: SubscriptionPlan) => {
    switch (plan) {
      case 'business': return 'business';
      case 'pro': return 'pro';
      case 'starter': return 'secondary';
      default: return 'outline';
    }
  };

  return (
    <Card className={cn(isAtLimit && 'border-destructive/50')}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Document Usage
          </CardTitle>
          <Badge variant={getPlanBadgeVariant(workspace.plan)}>
            {PLANS[workspace.plan]?.name || workspace.plan}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-3xl font-bold font-display">
                {workspace.documentsUsed}
              </span>
              <span className="text-sm text-muted-foreground">
                of {workspace.documentLimit} documents
              </span>
            </div>
            <Progress value={Math.min(usagePercent, 100)} variant={getVariant()} className="h-2" />
          </div>

          {isNearLimit && !isAtLimit && nextTier && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">Approaching limit</p>
                <p className="text-warning/80">
                  Upgrade to {nextTier.name} for {nextTier.documentLimit} documents
                </p>
              </div>
            </div>
          )}

          {isAtLimit && nextTier && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">Document limit reached</p>
                <p className="text-destructive/80">
                  Upgrade to {nextTier.name} to continue uploading
                </p>
              </div>
            </div>
          )}

          {isAtLimit && !nextTier && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">Document limit reached</p>
                <p className="text-destructive/80">
                  Contact us for enterprise pricing
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="text-sm text-muted-foreground">
              <span>Resets: </span>
              <span className="font-medium text-foreground">{renewalDate}</span>
            </div>
            {(isNearLimit || isAtLimit) && nextTier && (
              <Button variant="accent" size="sm" asChild>
                <Link to="/app/upgrade">
                  Upgrade <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
