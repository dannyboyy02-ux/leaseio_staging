import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Upload, Users, Bell, ShieldCheck, X, Rocket } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { InviteMemberDialog } from '@/components/workspace/InviteMemberDialog';
import { canManageWorkspaceMembers } from '@/lib/authorization';

const DISMISSED_KEY = 'leaseio.onboarding_dismissed';

interface OnboardingStep {
  id: string;
  titleKey: string;
  descriptionKey: string;
  title?: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
}

const stepDefinitions: OnboardingStep[] = [
  {
    id: 'upload',
    titleKey: 'onboarding.step1_title',
    descriptionKey: 'onboarding.step1_desc',
    icon: Upload,
    href: '/app/imports',
  },
  {
    id: 'team',
    titleKey: 'onboarding.step2_title',
    descriptionKey: 'onboarding.step2_desc',
    icon: Users,
    href: '/app/settings/workspace',
  },
  {
    id: 'approvers',
    titleKey: 'onboarding.step3_approvers_title',
    title: 'Set up approval roles',
    descriptionKey: 'onboarding.step3_approvers_desc',
    description: 'Assign manager and financial approvers in Team & Roles',
    icon: ShieldCheck,
    href: '/app/settings/workspace',
  },
  {
    id: 'notifications',
    titleKey: 'onboarding.step3_title',
    descriptionKey: 'onboarding.step3_desc',
    icon: Bell,
    href: '/app/notifications',
  },
];

export function OnboardingChecklist() {
  const [dismissed, setDismissed] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const { user, workspace, userRole } = useApp();
  const { t } = useLanguage();
  const canManageMembers = canManageWorkspaceMembers(userRole);
  
  useEffect(() => {
    const wasDismissed = localStorage.getItem(DISMISSED_KEY);
    if (wasDismissed === 'true') {
      setDismissed(true);
    }
  }, []);

  useEffect(() => {
    if (dismissed || !user?.id) return;

    const checkProgress = async () => {
      const completed: string[] = [];

      // Check if user has uploaded any leases
      const { count: leaseCount } = await supabase
        .from('leases')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);
      
      if (leaseCount && leaseCount > 0) {
        completed.push('upload');
      }

      // Check if workspace has team members
      if (workspace?.id) {
        const { count: memberCount } = await supabase
          .from('workspace_members')
          .select('*', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id);
        
        if (memberCount && memberCount > 1) {
          completed.push('team');
        }
      }

      // Check if workspace has approval roles configured
      if (workspace?.id) {
        const { count: rolesCount } = await (supabase as any)
          .from('workspace_roles')
          .select('*', { count: 'exact', head: true })
          .eq('workspace_id', workspace.id);
        
        if (rolesCount && rolesCount > 0) {
          completed.push('approvers');
        }
      }

      // Check if user has any notifications configured
      const { count: notificationCount } = await supabase
        .from('lease_notifications')
        .select('*', { count: 'exact', head: true })
        .eq('is_confirmed', true);
      
      if (notificationCount && notificationCount > 0) {
        completed.push('notifications');
      }

      setCompletedSteps(completed);
    };

    checkProgress();
  }, [user?.id, workspace?.id, dismissed]);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(DISMISSED_KEY, 'true');
  };
  
  if (dismissed) return null;

  const visibleSteps = canManageMembers
    ? stepDefinitions
    : stepDefinitions.filter((step) => step.id !== 'team' && step.id !== 'approvers');
  const visibleCompletedSteps = completedSteps.filter((stepId) =>
    visibleSteps.some((step) => step.id === stepId)
  );
  const completedCount = visibleCompletedSteps.length;
  const progress = visibleSteps.length
    ? (visibleCompletedSteps.length / visibleSteps.length) * 100
    : 0;

  if (visibleCompletedSteps.length >= visibleSteps.length) return null;

  return (
    <Card className="border-primary/30 bg-primary/5 animate-fade-up">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Rocket className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">{t('onboarding.getting_started')}</CardTitle>
              <CardDescription>
                {completedCount}/{visibleSteps.length} {t('onboarding.completed')}
              </CardDescription>
            </div>
          </div>
          <Button 
            variant="ghost" 
            size="icon"
            onClick={handleDismiss}
            className="text-muted-foreground hover:text-foreground h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Progress value={progress} className="flex-1 h-2" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {visibleSteps.map((step, index) => {
            const isCompleted = completedSteps.includes(step.id);
            const translatedTitle = step.title || t(step.titleKey);
            const translatedDesc = step.description || t(step.descriptionKey);
            const content = (
              <>
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors',
                    isCompleted
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-5 w-5" />
                  ) : (
                    <step.icon className="h-5 w-5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={cn(
                      'text-sm font-medium',
                      isCompleted && 'line-through'
                    )}
                  >
                    {translatedTitle}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {translatedDesc}
                  </p>
                </div>
                {!isCompleted && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </>
            );

            const sharedClassName = cn(
              'flex w-full items-center gap-4 rounded-lg p-3 text-left transition-all hover:bg-muted/50',
              'animate-fade-up',
              isCompleted && 'opacity-60'
            );

            return step.id === 'team' ? (
              <button
                key={step.id}
                type="button"
                onClick={() => setInviteDialogOpen(true)}
                className={sharedClassName}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {content}
              </button>
            ) : (
              <Link
                key={step.id}
                to={step.href}
                className={sharedClassName}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {content}
              </Link>
            );
          })}
        </div>
        {canManageMembers && (
          <InviteMemberDialog
            open={inviteDialogOpen}
            onOpenChange={setInviteDialogOpen}
            workspaceId={workspace?.id ?? ''}
            onInviteSent={() => {}}
          />
        )}
      </CardContent>
    </Card>
  );
}
