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
import { useAppTranslation } from '@/hooks/useAppTranslation';

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
}: MemberRoleSelectProps) {
  const { t } = useAppTranslation();
  const [isUpdating, setIsUpdating] = useState(false);

  const handleRoleChange = async (newRole: WorkspaceRole) => {
    if (newRole === currentRole) return;
    if (!workspaceId) { toast.error(t('workspace.members_panel.role_update_failed')); return; }

    setIsUpdating(true);
    try {
      // Route through the service-role fn: workspace_members UPDATE is owner-only
      // at RLS, so a direct client write fails for admins. The fn authorizes
      // owner-OR-admin and writes the audit row server-side.
      const { data, error } = await supabase.functions.invoke('manage-workspace-member', {
        body: { action: 'set_role', workspaceId, memberId, role: newRole },
      });
      if (error || !(data as any)?.ok) {
        let reason: string | null = (data as any)?.reason ?? null;
        try { const b = await (error as any)?.context?.json?.(); reason = reason ?? (b?.reason ?? null); } catch { /* not JSON */ }
        toast.error(
          reason === 'not_authorized' ? t('workspace.members_panel.manage_forbidden')
          : reason === 'subscription_inactive' ? t('workspace.members_panel.role_readonly')
          : t('workspace.members_panel.role_update_failed'),
        );
        return;
      }
      toast.success(t('workspace.members_panel.role_updated'));
      onRoleChanged();
    } catch (err) {
      console.error('Error updating role:', err);
      toast.error(t('workspace.members_panel.role_update_failed'));
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
          <SelectItem value="admin">{t('workspace.admin')}</SelectItem>
          <SelectItem value="editor">{t('workspace.editor')}</SelectItem>
          <SelectItem value="viewer">{t('workspace.viewer')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
