// MembersPanel — workspace-agnostic member management.
//
// Extracted from WorkspaceSettings.tsx during Owner Workspace Management
// Checkpoint 2. The original code only worked for the active workspace
// because it pulled `workspace.ownerId` from the AppContext. This
// component takes `workspaceId` and `ownerId` as props so it can render
// for ANY workspace the caller is allowed to see — used by:
//   - WorkspaceSettings.tsx (active workspace context)
//   - the new /app/account/workspaces page (in-context member management
//     for any workspace the current user owns, without switching active)
//
// Behavior contract: the rendered output is byte-equivalent to the
// previous inline implementation in WorkspaceSettings.tsx for the
// active-workspace case. The only behavioral expansion is that the
// panel now works for non-active workspaces too. Tested by visiting
// /app/settings/workspace and confirming the Users tab is unchanged.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Crown, Trash2, UserPlus, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { InviteMemberDialog } from '@/components/workspace/InviteMemberDialog';
import { MemberRoleSelect } from '@/components/workspace/MemberRoleSelect';
import { PendingInvitesList } from '@/components/workspace/PendingInvitesList';
import type { WorkspaceRole } from '@/types';

interface MembersPanelProps {
  workspaceId: string;
  /**
   * Owner of the workspace (auth.users.id). Used to render the Owner
   * crown badge and to suppress the role-change / remove controls for
   * the owner row. Caller is responsible for sourcing this — typically
   * from `workspaces.owner_id` for the workspace being rendered.
   */
  ownerId: string;
  /**
   * If false, the invite/remove/role-change controls render but are
   * effectively no-ops (mirrors the pre-extraction `canManageMembers`
   * gate from WorkspaceSettings.tsx). Defaults to true.
   */
  canManage?: boolean;
}

interface MemberRow {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
  email: string;
  name: string;
}

export function MembersPanel({ workspaceId, ownerId, canManage = true }: MembersPanelProps) {
  const { t } = useLanguage();
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);

  const { data: members, isLoading: membersLoading, refetch: refetchMembers } = useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: async (): Promise<MemberRow[]> => {
      const { data, error } = await supabase
        .from('workspace_members')
        .select(`id, role, user_id, created_at`)
        .eq('workspace_id', workspaceId);

      if (error) throw error;

      const memberIds = data?.map((m) => m.user_id) || [];
      if (memberIds.length === 0) return [];

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', memberIds);

      if (profilesError) throw profilesError;

      return (
        data?.map((member) => {
          const profile = profiles?.find((p) => p.id === member.user_id);
          return {
            ...member,
            email: profile?.email || 'Unknown',
            name:
              profile?.first_name && profile?.last_name
                ? `${profile.first_name} ${profile.last_name}`
                : profile?.email || 'Unknown User',
          };
        }) || []
      );
    },
    enabled: !!workspaceId,
  });

  const { data: pendingInvites = [], refetch: refetchPending } = useQuery({
    queryKey: ['pending-invites', workspaceId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('list-pending-invites', {
        body: { workspaceId },
      });
      if (error || !data?.ok) return [];
      return data.data?.invites || [];
    },
    enabled: !!workspaceId && canManage,
  });

  const handleRemoveMember = async (memberId: string) => {
    try {
      const { error } = await supabase.from('workspace_members').delete().eq('id', memberId);
      if (error) throw error;
      toast.success('Member removed');
      refetchMembers();
    } catch (error) {
      console.error('Error removing member:', error);
      toast.error('Failed to remove member');
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('workspace.team_members')}</CardTitle>
              <CardDescription>{t('workspace.manage_access')}</CardDescription>
            </div>
            {canManage && (
              <Button variant="accent" onClick={() => setInviteDialogOpen(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                {t('workspace.invite_member')}
              </Button>
            )}
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
          ) : members.length === 1 ? (
            // Single-user simplification: show Admin role only, hide role configuration
            <div>
              <div className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <Avatar>
                    <AvatarFallback>
                      {members[0].name
                        .split(' ')
                        .map((n: string) => n[0])
                        .join('')
                        .slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">{members[0].name}</p>
                    <p className="text-sm text-muted-foreground">{members[0].email}</p>
                  </div>
                </div>
                <Badge variant="default" className="flex items-center gap-1">
                  <Crown className="h-3 w-3" />
                  Admin
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Add team members to configure roles and approval workflows.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {members.map((member, index) => (
                <div
                  key={member.id}
                  className={cn(
                    'flex items-center justify-between py-4 animate-fade-up',
                    index === 0 && 'pt-0',
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
                    {member.user_id === ownerId ? (
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
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveMember(member.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {pendingInvites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending Invitations</CardTitle>
            <CardDescription>Invitations that have not yet been accepted.</CardDescription>
          </CardHeader>
          <CardContent>
            <PendingInvitesList invites={pendingInvites} onRefresh={refetchPending} />
          </CardContent>
        </Card>
      )}

      {canManage && (
        <InviteMemberDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          workspaceId={workspaceId}
          onInviteSent={() => {
            refetchMembers();
            refetchPending();
          }}
        />
      )}
    </>
  );
}

/**
 * Read hook re-exported for callers that need the members list (e.g. the
 * Approval Chain section in WorkspaceSettings.tsx that depends on the
 * roster). Same query key as inside the panel — TanStack dedupes.
 */
export function useWorkspaceMembers(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-members', workspaceId],
    queryFn: async (): Promise<MemberRow[]> => {
      if (!workspaceId) return [];
      const { data, error } = await supabase
        .from('workspace_members')
        .select(`id, role, user_id, created_at`)
        .eq('workspace_id', workspaceId);
      if (error) throw error;

      const memberIds = data?.map((m) => m.user_id) || [];
      if (memberIds.length === 0) return [];

      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, first_name, last_name')
        .in('id', memberIds);
      if (profilesError) throw profilesError;

      return (
        data?.map((member) => {
          const profile = profiles?.find((p) => p.id === member.user_id);
          return {
            ...member,
            email: profile?.email || 'Unknown',
            name:
              profile?.first_name && profile?.last_name
                ? `${profile.first_name} ${profile.last_name}`
                : profile?.email || 'Unknown User',
          };
        }) || []
      );
    },
    enabled: !!workspaceId,
  });
}
