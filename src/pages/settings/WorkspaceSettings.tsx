import { useState, useEffect } from 'react';
import { Building2, Users, Bell, Save, Loader2, UserPlus, Trash2, Crown, Link2, CreditCard } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useApp } from '@/contexts/AppContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { InviteMemberDialog } from '@/components/workspace/InviteMemberDialog';
import { MemberRoleSelect } from '@/components/workspace/MemberRoleSelect';
import { WorkspaceRole } from '@/types';
import { Link } from 'react-router-dom';
import {
  canAccessWorkspaceBilling,
  canAccessWorkspaceDefaults,
  canAccessWorkspaceIntegrations,
  canAccessWorkspaceProfile,
  canEditWorkspaceSettings,
  canManageWorkspaceMembers,
} from '@/lib/authorization';

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
];

export default function WorkspaceSettings() {
  const { workspace, refreshProfile, userRole } = useApp();
  const { t } = useLanguage();
  const [workspaceName, setWorkspaceName] = useState(workspace?.name || '');
  const [timezone, setTimezone] = useState(workspace?.timezone || 'America/New_York');
  const [notificationDays, setNotificationDays] = useState(
    String(workspace?.defaultNotificationDays || 90)
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  const canEdit = canEditWorkspaceSettings(userRole);
  const canManageMembers = canManageWorkspaceMembers(userRole);
  const canAccessDefaults = canAccessWorkspaceDefaults(userRole);
  const canAccessIntegrations = canAccessWorkspaceIntegrations(userRole);
  const canAccessBilling = canAccessWorkspaceBilling(userRole);
  const canAccessProfile = canAccessWorkspaceProfile(userRole);

  const tabs = [
    { id: 'profile', label: t('workspace.profile'), icon: Building2, visible: canAccessProfile },
    { id: 'members', label: t('workspace.users_access'), icon: Users, visible: canManageMembers },
    { id: 'defaults', label: t('workspace.defaults'), icon: Bell, visible: canAccessDefaults },
    { id: 'integrations', label: t('workspace.integrations_tab'), icon: Link2, visible: canAccessIntegrations },
    { id: 'billing', label: t('workspace.billing_plan'), icon: CreditCard, visible: canAccessBilling },
  ].filter((tab) => tab.visible);

  const defaultTab = tabs[0]?.id ?? 'profile';

  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.name || '');
      setTimezone(workspace.timezone || 'America/New_York');
      setNotificationDays(String(workspace.defaultNotificationDays || 90));
    }
  }, [workspace]);

  const { data: members, isLoading: membersLoading, refetch: refetchMembers } = useQuery({
    queryKey: ['workspace-members', workspace?.id],
    queryFn: async () => {
      if (!workspace?.id) return [];
      
      const { data, error } = await supabase
        .from('workspace_members')
        .select(`
          id,
          role,
          user_id,
          created_at
        `)
        .eq('workspace_id', workspace.id);

      if (error) throw error;

      const memberIds = data?.map(m => m.user_id) || [];
      if (memberIds.length === 0) return [];

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', memberIds);

      if (profilesError) throw profilesError;

      return data?.map(member => {
        const profile = profiles?.find(p => p.id === member.user_id);
        return {
          ...member,
          email: profile?.email || 'Unknown',
          name: profile?.first_name && profile?.last_name 
            ? `${profile.first_name} ${profile.last_name}` 
            : profile?.email || 'Unknown User',
        };
      }) || [];
    },
    enabled: !!workspace?.id,
  });

  const handleSaveGeneral = async () => {
    if (!canEdit) {
      toast.error(t('workspace.read_only'));
      return;
    }
    if (!workspace?.id) {
      toast.error('No workspace found');
      return;
    }

    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({
          name: workspaceName.trim(),
          timezone: timezone,
        })
        .eq('id', workspace.id);

      if (error) throw error;

      if (refreshProfile) await refreshProfile();
      toast.success('Workspace settings saved!');
    } catch (error) {
      console.error('Error saving workspace:', error);
      toast.error('Failed to save workspace settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNotifications = async () => {
    if (!canEdit) {
      toast.error(t('workspace.read_only'));
      return;
    }
    if (!workspace?.id) {
      toast.error('No workspace found');
      return;
    }

    setIsSavingNotifications(true);
    try {
      const days = parseInt(notificationDays) || 90;
      const { error } = await supabase
        .from('workspaces')
        .update({
          default_notification_days: days,
        })
        .eq('id', workspace.id);

      if (error) throw error;

      if (refreshProfile) await refreshProfile();
      toast.success('Notification settings saved!');
    } catch (error) {
      console.error('Error saving notifications:', error);
      toast.error('Failed to save notification settings');
    } finally {
      setIsSavingNotifications(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    try {
      const { error } = await supabase
        .from('workspace_members')
        .delete()
        .eq('id', memberId);

      if (error) throw error;
      toast.success('Member removed');
      refetchMembers();
    } catch (error) {
      console.error('Error removing member:', error);
      toast.error('Failed to remove member');
    }
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'admin': return t('workspace.admin');
      case 'editor': return t('workspace.editor');
      case 'viewer': return t('workspace.viewer');
      default: return role;
    }
  };

  return (
    <AppLayout>
      <AppHeader title={t('workspace.title')} subtitle={t('workspace.subtitle')} />

      <div className="p-6">
        <Tabs defaultValue={defaultTab}>
          <TabsList className="mb-6">
            {tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id} className="gap-2">
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* General Settings */}
          <TabsContent value="profile" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('workspace.details')}</CardTitle>
                <CardDescription>{t('workspace.basic_info')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="workspace-name">{t('workspace.name')}</Label>
                  <Input
                    id="workspace-name"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    disabled={!canEdit}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">{t('workspace.default_timezone')}</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger id="timezone" disabled={!canEdit}>
                      <SelectValue placeholder="Select timezone" />
                    </SelectTrigger>
                    <SelectContent>
                      {timezones.map((tz) => (
                        <SelectItem key={tz.value} value={tz.value}>
                          {tz.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('workspace.timezone_desc')}
                  </p>
                </div>
                <Button variant="accent" onClick={handleSaveGeneral} disabled={!canEdit || isSaving}>
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {isSaving ? t('workspace.saving') : t('workspace.save_changes')}
                </Button>
                {!canEdit && (
                  <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Members */}
          {canManageMembers && (
            <TabsContent value="members" className="space-y-6">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>{t('workspace.team_members')}</CardTitle>
                      <CardDescription>{t('workspace.manage_access')}</CardDescription>
                    </div>
                    <Button variant="accent" onClick={() => setInviteDialogOpen(true)}>
                      <UserPlus className="h-4 w-4 mr-2" />
                      {t('workspace.invite_member')}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {membersLoading ? (
                    <div className="space-y-4">
                      {[...Array(3)].map((_, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <Skeleton className="h-10 w-10 rounded-full" />
                          <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-3 w-48" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : !members || members.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Users className="h-12 w-12 mx-auto mb-3 opacity-50" />
                      <p>{t('workspace.no_members')}</p>
                      <p className="text-sm">{t('workspace.only_one')}</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {members.map((member, index) => (
                        <div
                          key={member.id}
                          className={cn(
                            'flex items-center justify-between py-4 animate-fade-up',
                            index === 0 && 'pt-0'
                          )}
                          style={{ animationDelay: `${index * 50}ms` }}
                        >
                          <div className="flex items-center gap-3">
                            <Avatar>
                              <AvatarFallback>
                                {member.name
                                  .split(' ')
                                  .map((n: string) => n[0])
                                  .join('')
                                  .slice(0, 2)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium">{member.name}</p>
                              <p className="text-sm text-muted-foreground">{member.email}</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {member.user_id === workspace?.ownerId ? (
                              <Badge variant="default" className="flex items-center gap-1">
                                <Crown className="h-3 w-3" />
                                {t('workspace.owner')}
                              </Badge>
                            ) : (
                              <>
                                <MemberRoleSelect
                                  memberId={member.id}
                                  currentRole={member.role as WorkspaceRole}
                                  onRoleChanged={() => refetchMembers()}
                                />
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleRemoveMember(member.id)}
                                  className="text-destructive hover:text-destructive"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* Defaults */}
          {canAccessDefaults && (
            <TabsContent value="defaults" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('workspace.notification_settings')}</CardTitle>
                <CardDescription>
                  {t('workspace.notification_timing')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="notification-days">{t('workspace.reminder_days')}</Label>
                  <Input
                    id="notification-days"
                    type="number"
                    value={notificationDays}
                    onChange={(e) => setNotificationDays(e.target.value)}
                    min="1"
                    max="365"
                    disabled={!canEdit}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('workspace.reminder_desc')}
                  </p>
                </div>
                <Button variant="accent" onClick={handleSaveNotifications} disabled={!canEdit || isSavingNotifications}>
                  {isSavingNotifications ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {isSavingNotifications ? t('workspace.saving') : t('workspace.save_changes')}
                </Button>
                {!canEdit && (
                  <p className="text-xs text-muted-foreground">{t('workspace.read_only')}</p>
                )}
              </CardContent>
            </Card>
            </TabsContent>
          )}

          {/* Integrations */}
          {canAccessIntegrations && (
            <TabsContent value="integrations" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('workspace.integrations_tab')}</CardTitle>
                <CardDescription>{t('workspace.integrations_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="accent" asChild>
                  <Link to="/app/integrations">
                    <Link2 className="h-4 w-4 mr-2" />
                    {t('workspace.manage_integrations')}
                  </Link>
                </Button>
                {!canEdit && (
                  <p className="text-xs text-muted-foreground mt-2">{t('workspace.read_only')}</p>
                )}
              </CardContent>
            </Card>
            </TabsContent>
          )}

          {/* Billing & Plan */}
          {canAccessBilling && (
            <TabsContent value="billing" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('workspace.billing_plan')}</CardTitle>
                <CardDescription>{t('workspace.billing_desc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="accent" asChild>
                  <Link to="/app/settings/account">{t('workspace.manage_billing')}</Link>
                </Button>
              </CardContent>
            </Card>
            </TabsContent>
          )}
        </Tabs>
      </div>

      {workspace && canManageMembers && (
        <InviteMemberDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          workspaceId={workspace.id}
          onInviteSent={() => refetchMembers()}
        />
      )}
    </AppLayout>
  );
}
