import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { WorkspaceRole } from '@/types';

interface MemberRoleSelectProps {
  memberId: string;
  currentRole: WorkspaceRole;
  onRoleChanged: () => void;
  disabled?: boolean;
  workspaceId?: string;
  targetUserId?: string;
}

export function MemberRoleSelect({
  memberId,
  currentRole,
  onRoleChanged,
  disabled,
  workspaceId,
  targetUserId,
}: MemberRoleSelectProps) {
  const [isUpdating, setIsUpdating] = useState(false);

  const handleRoleChange = async (newRole: WorkspaceRole) => {
    if (newRole === currentRole) return;

    setIsUpdating(true);
    try {
      // #52: scope the UPDATE to this workspace as well as the member PK when
      // workspaceId is known. RLS (is_workspace_owner) already blocks
      // cross-workspace writes; this makes the query express its own scope
      // intent (defense-in-depth). workspaceId is optional on this component,
      // so only add the predicate when present — no behavior change otherwise.
      let updateQuery = supabase
        .from('workspace_members')
        .update({ role: newRole })
        .eq('id', memberId);
      if (workspaceId) {
        updateQuery = updateQuery.eq('workspace_id', workspaceId);
      }
      const { error } = await updateQuery;

      if (error) throw error;

      toast.success('Role updated successfully');
      onRoleChanged();

      // Fire-and-forget: an audit-write failure must not surface as a
      // role-change failure — the role update above already committed.
      if (workspaceId && targetUserId) {
        const { data: sessionData } = await supabase.auth.getSession();
        (supabase as any)
          .from('workspace_activity_log')
          .insert({
            workspace_id: workspaceId,
            user_id: sessionData.session?.user?.id ?? null,
            event_type: 'member_role_changed',
            details: { target_user_id: targetUserId, role: newRole, previous_role: currentRole },
          })
          .then(({ error: auditError }: { error: unknown }) => {
            if (auditError) console.error('Failed to log member_role_changed:', auditError);
          });
      }
    } catch (error) {
      console.error('Error updating role:', error);
      toast.error('Failed to update role');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="relative">
      {isUpdating && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
      <Select
        value={currentRole}
        onValueChange={(v) => handleRoleChange(v as WorkspaceRole)}
        disabled={disabled || isUpdating}
      >
        <SelectTrigger className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="admin">Admin</SelectItem>
          <SelectItem value="editor">Editor</SelectItem>
          <SelectItem value="viewer">Viewer</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
