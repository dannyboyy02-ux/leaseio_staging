import { useState, useEffect } from 'react';
import { Building2, Users, Bell, Shield, Save, Loader2, UserPlus } from 'lucide-react';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';

const timezones = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
];

const roleLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  owner: { label: 'Owner', variant: 'default' },
  admin: { label: 'Admin', variant: 'secondary' },
  manager: { label: 'Manager', variant: 'secondary' },
  reviewer: { label: 'Reviewer', variant: 'outline' },
  readonly: { label: 'Read-only', variant: 'outline' },
};

export default function WorkspaceSettings() {
  const { workspace, refreshProfile } = useApp();
  const [workspaceName, setWorkspaceName] = useState(workspace?.name || '');
  const [timezone, setTimezone] = useState(workspace?.timezone || 'America/New_York');
  const [notificationDays, setNotificationDays] = useState(
    String(workspace?.defaultNotificationDays || 90)
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);

  // Sync form with workspace data when it loads
  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.name || '');
      setTimezone(workspace.timezone || 'America/New_York');
      setNotificationDays(String(workspace.defaultNotificationDays || 90));
    }
  }, [workspace]);

  // Fetch workspace members
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

      // Fetch profiles for each member
      const memberIds = data?.map(m => m.user_id) || [];
      if (memberIds.length === 0) return [];

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', memberIds);

      if (profilesError) throw profilesError;

      // Combine members with profiles
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

  const handleInviteMember = () => {
    toast.info('Member invitations coming soon!');
  };

  return (
    <AppLayout>
      <AppHeader title="Workspace Settings" subtitle="Manage your workspace configuration" />

      <div className="p-6">
        <Tabs defaultValue="general">
          <TabsList className="mb-6">
            <TabsTrigger value="general" className="gap-2">
              <Building2 className="h-4 w-4" />
              General
            </TabsTrigger>
            <TabsTrigger value="members" className="gap-2">
              <Users className="h-4 w-4" />
              Members
            </TabsTrigger>
            <TabsTrigger value="notifications" className="gap-2">
              <Bell className="h-4 w-4" />
              Notifications
            </TabsTrigger>
            <TabsTrigger value="security" className="gap-2">
              <Shield className="h-4 w-4" />
              Security
            </TabsTrigger>
          </TabsList>

          {/* General Settings */}
          <TabsContent value="general" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Workspace Details</CardTitle>
                <CardDescription>Basic information about your workspace</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="workspace-name">Workspace Name</Label>
                  <Input
                    id="workspace-name"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">Default Timezone</Label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger id="timezone">
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
                    Used for scheduling notifications and displaying dates
                  </p>
                </div>
                <Button variant="accent" onClick={handleSaveGeneral} disabled={isSaving}>
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Members */}
          <TabsContent value="members" className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Team Members</CardTitle>
                    <CardDescription>Manage who has access to this workspace</CardDescription>
                  </div>
                  <Button variant="accent" onClick={handleInviteMember}>
                    <UserPlus className="h-4 w-4 mr-2" />
                    Invite Member
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
                    <p>No team members yet</p>
                    <p className="text-sm">You're the only one with access to this workspace</p>
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
                          <Badge variant={roleLabels[member.role]?.variant || 'outline'}>
                            {roleLabels[member.role]?.label || member.role}
                          </Badge>
                          {member.role !== 'owner' && (
                            <Button variant="ghost" size="sm">
                              Edit
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Notifications */}
          <TabsContent value="notifications" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Default Notification Settings</CardTitle>
                <CardDescription>
                  Configure default timing for lease notifications
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="notification-days">Default Reminder (days before)</Label>
                  <Input
                    id="notification-days"
                    type="number"
                    value={notificationDays}
                    onChange={(e) => setNotificationDays(e.target.value)}
                    min="1"
                    max="365"
                  />
                  <p className="text-xs text-muted-foreground">
                    How many days before an event to send the first notification
                  </p>
                </div>
                <Button variant="accent" onClick={handleSaveNotifications} disabled={isSavingNotifications}>
                  {isSavingNotifications ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  {isSavingNotifications ? 'Saving...' : 'Save Changes'}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Security */}
          <TabsContent value="security" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Audit Log</CardTitle>
                <CardDescription>
                  View recent activity in your workspace
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-center py-8 text-muted-foreground">
                  <Shield className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">Audit logs will appear here</p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}