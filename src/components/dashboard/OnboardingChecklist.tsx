import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Upload, Users, Bell, Link2, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  completed: boolean;
  href: string;
}

const steps: OnboardingStep[] = [
  {
    id: 'upload',
    title: 'Upload your first lease',
    description: 'Get started by uploading a PDF lease document',
    icon: Upload,
    completed: false,
    href: '/app/leases?action=upload',
  },
  {
    id: 'team',
    title: 'Invite team members',
    description: 'Add colleagues to collaborate on lease management',
    icon: Users,
    completed: false,
    href: '/app/settings/workspace?tab=members',
  },
  {
    id: 'notifications',
    title: 'Configure notifications',
    description: 'Set up email and SMS alerts for key dates',
    icon: Bell,
    completed: true,
    href: '/app/settings/workspace?tab=notifications',
  },
  {
    id: 'integrations',
    title: 'Connect QuickBooks',
    description: 'Sync lease data with your accounting system',
    icon: Link2,
    completed: false,
    href: '/app/integrations',
  },
];

export function OnboardingChecklist() {
  const [dismissed, setDismissed] = useState(false);
  
  if (dismissed) return null;

  const completedCount = steps.filter(s => s.completed).length;
  const progress = (completedCount / steps.length) * 100;

  return (
    <Card variant="feature" className="animate-fade-up">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Getting Started</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Complete these steps to get the most out of LeaseIO
            </p>
          </div>
          <Button 
            variant="ghost" 
            size="icon-sm"
            onClick={() => setDismissed(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Progress value={progress} variant="accent" className="flex-1" />
          <span className="text-sm font-medium text-muted-foreground">
            {completedCount}/{steps.length}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {steps.map((step, index) => (
            <Link
              key={step.id}
              to={step.href}
              className={cn(
                'flex items-center gap-4 rounded-lg p-3 transition-all hover:bg-muted/50',
                'animate-fade-up',
                step.completed && 'opacity-60'
              )}
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
                  step.completed
                    ? 'bg-success/10 text-success'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {step.completed ? (
                  <Check className="h-5 w-5" />
                ) : (
                  <step.icon className="h-5 w-5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    'text-sm font-medium',
                    step.completed && 'line-through'
                  )}
                >
                  {step.title}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {step.description}
                </p>
              </div>
              {!step.completed && (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
