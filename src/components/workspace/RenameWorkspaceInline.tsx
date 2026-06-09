// RenameWorkspaceInline — Owner Workspace Management Checkpoint 3.
//
// Click-to-edit name field for a workspace. Owner-only writes are
// enforced at the DB level (RLS: workspaces UPDATE requires
// owner_id = auth.uid()). The save button optimistically swaps the
// rendered text and reverts on RLS error or empty input.

import { useState, useRef, useEffect } from 'react';
import { Pencil, Check, X, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface RenameWorkspaceInlineProps {
  workspaceId: string;
  currentName: string;
  /** Called with the new name once the DB UPDATE succeeds. */
  onRenamed?: (newName: string) => void;
  className?: string;
  /** When false, only renders text — no edit affordance. */
  canEdit?: boolean;
}

export function RenameWorkspaceInline({
  workspaceId,
  currentName,
  onRenamed,
  className,
  canEdit = true,
}: RenameWorkspaceInlineProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // If parent updates currentName (e.g. external refetch), reset the
  // draft so the editor doesn't show stale input.
  useEffect(() => {
    if (!editing) setDraft(currentName);
  }, [currentName, editing]);

  const handleSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      toast.error('Workspace name cannot be empty');
      return;
    }
    if (trimmed === currentName) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('workspaces')
        .update({ name: trimmed })
        .eq('id', workspaceId);
      if (error) throw error;
      toast.success('Workspace renamed');
      setEditing(false);
      onRenamed?.(trimmed);
      // Fire-and-forget: an audit-write failure must not surface as a
      // rename failure — the rename above already committed.
      (supabase as any)
        .from('workspace_activity_log')
        .insert({
          workspace_id: workspaceId,
          event_type: 'renamed',
          details: { from_name: currentName, to_name: trimmed },
        })
        .then(({ error: auditError }: { error: unknown }) => {
          if (auditError) console.error('Failed to log workspace rename:', auditError);
        });
    } catch (err) {
      console.error('Error renaming workspace:', err);
      toast.error('Failed to rename — only the workspace owner can rename');
      setDraft(currentName);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(currentName);
    setEditing(false);
  };

  if (!canEdit) {
    return <span className={className}>{currentName}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          'group inline-flex items-center gap-2 text-left hover:text-foreground transition-colors',
          className,
        )}
        title="Click to rename"
      >
        <span>{currentName}</span>
        <Pencil className="h-3.5 w-3.5 opacity-0 group-hover:opacity-60 transition-opacity" />
      </button>
    );
  }

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSave();
          if (e.key === 'Escape') handleCancel();
        }}
        disabled={saving}
        className="rounded-md border border-input bg-background px-2 py-1 text-sm font-medium min-w-[12rem]"
        maxLength={100}
      />
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="p-1 rounded hover:bg-muted text-success disabled:opacity-50"
        title="Save"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={handleCancel}
        disabled={saving}
        className="p-1 rounded hover:bg-muted text-muted-foreground disabled:opacity-50"
        title="Cancel"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
