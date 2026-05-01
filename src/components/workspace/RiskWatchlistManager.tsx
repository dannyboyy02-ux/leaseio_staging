/**
 * Workspace Risk Watchlist manager.
 *
 * Surfaces the workspace-scoped rows in `risk_templates` (is_system = false,
 * workspace_id = current). These are the patterns added either via the
 * "+ Risk → Custom → Watch for this in future abstractions" checkbox in
 * the lease workbench, or directly here.
 *
 * On every subsequent process_lease run for this workspace, the extraction
 * prompt receives this list and Opus is told to flag matching clauses.
 *
 * Workspace members can add/edit/delete their own templates. System
 * templates are read-only (we surface them as informational context).
 */

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

interface RiskTemplate {
  id: string;
  workspace_id: string | null;
  is_system: boolean;
  title: string;
  severity: 'low' | 'medium' | 'high';
  default_explanation: string;
  asset_type: string | null;
  created_at: string;
  created_by: string | null;
}

interface Props {
  workspaceId: string;
}

const SEV_BADGE: Record<string, string> = {
  high: 'bg-red-100 text-red-700 border-red-300',
  medium: 'bg-amber-100 text-amber-700 border-amber-300',
  low: 'bg-blue-100 text-blue-700 border-blue-300',
};

export function RiskWatchlistManager({ workspaceId }: Props) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<RiskTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RiskTemplate | null>(null);

  // Form state for create/edit
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high'>('medium');
  const [explanation, setExplanation] = useState('');
  const [saving, setSaving] = useState(false);

  const refetch = async () => {
    setLoading(true);
    const { data, error } = await (supabase as any)
      .from('risk_templates')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('is_system', false)
      .order('created_at', { ascending: false });
    if (error) toast.error(`Failed to load watchlist: ${error.message}`);
    else setItems((data ?? []) as RiskTemplate[]);
    setLoading(false);
  };

  useEffect(() => {
    if (workspaceId) refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const startCreate = () => {
    setEditingId(null);
    setCreating(true);
    setTitle('');
    setSeverity('medium');
    setExplanation('');
  };

  const startEdit = (t: RiskTemplate) => {
    setCreating(false);
    setEditingId(t.id);
    setTitle(t.title);
    setSeverity(t.severity);
    setExplanation(t.default_explanation);
  };

  const cancelForm = () => {
    setCreating(false);
    setEditingId(null);
    setTitle('');
    setSeverity('medium');
    setExplanation('');
  };

  const saveForm = async () => {
    if (title.trim().length < 3 || explanation.trim().length < 5) {
      toast.error('Title (≥3 chars) and explanation (≥5 chars) are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        severity,
        default_explanation: explanation.trim(),
      };
      if (editingId) {
        const { data, error } = await (supabase as any)
          .from('risk_templates')
          .update(payload)
          .eq('id', editingId)
          .select('id');
        if (error) throw error;
        if (!data || data.length === 0) throw new Error('No rows updated — likely a permissions issue.');
        toast.success('Watchlist entry updated');
      } else {
        const { data: userData } = await supabase.auth.getUser();
        const { error } = await (supabase as any)
          .from('risk_templates')
          .insert({
            ...payload,
            workspace_id: workspaceId,
            is_system: false,
            created_by: userData?.user?.id ?? null,
          });
        if (error) throw error;
        toast.success('Added to watchlist — future abstractions will check for this');
      }
      cancelForm();
      await refetch();
    } catch (err: any) {
      toast.error(`Save failed: ${err?.message ?? 'unknown'}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setSaving(true);
    try {
      const { data, error } = await (supabase as any)
        .from('risk_templates')
        .delete()
        .eq('id', deleting.id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('No rows deleted — likely a permissions issue.');
      toast.success('Removed from watchlist');
      setDeleting(null);
      await refetch();
    } catch (err: any) {
      toast.error(`Delete failed: ${err?.message ?? 'unknown'}`);
    } finally {
      setSaving(false);
    }
  };

  const formMode = creating ? 'create' : editingId ? 'edit' : null;

  return (
    <Card className="shadow-none border">
      <CardHeader className="border-b py-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm font-bold">Risk Watchlist</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Patterns the AI explicitly checks against on every subsequent lease abstraction in
              this workspace. Add common clauses your team flags so they show up consistently.
            </p>
          </div>
          {!formMode && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={startCreate}>
              <Plus className="h-3.5 w-3.5" /> Add to watchlist
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {formMode && (
          <div className="border rounded-md p-3 bg-muted/20 space-y-2">
            <div className="grid gap-1.5">
              <Label htmlFor="watch-title" className="text-xs">Title</Label>
              <Input
                id="watch-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Mileage overage at 35¢/mile"
                maxLength={200}
                disabled={saving}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="watch-sev" className="text-xs">Severity</Label>
              <Select value={severity} onValueChange={(v) => setSeverity(v as any)} disabled={saving}>
                <SelectTrigger id="watch-sev" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="watch-exp" className="text-xs">Explanation</Label>
              <Textarea
                id="watch-exp"
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
                placeholder="What clause to look for and why it matters."
                rows={3}
                disabled={saving}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" onClick={cancelForm} disabled={saving}>
                <X className="h-3.5 w-3.5 mr-1" /> Cancel
              </Button>
              <Button size="sm" onClick={saveForm} disabled={saving}>
                {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                {formMode === 'create' ? 'Add' : 'Save'}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
          </div>
        ) : items.length === 0 && !formMode ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No watchlist entries yet. Click <strong>Add to watchlist</strong>, or use the
            "+ Risk → Custom → Watch for this" checkbox on a lease.
          </p>
        ) : (
          <ul className="divide-y border rounded-md">
            {items.map((t) => (
              <li
                key={t.id}
                className={cn('p-3 flex items-start gap-2', editingId === t.id && 'opacity-50')}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{t.title}</span>
                    <Badge className={cn('text-[10px]', SEV_BADGE[t.severity])}>{t.severity}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{t.default_explanation}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => startEdit(t)}
                    title="Edit"
                    disabled={!!formMode}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 hover:text-destructive"
                    onClick={() => setDeleting(t)}
                    title="Remove"
                    disabled={!!formMode}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !saving && !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from watchlist?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong className="block mb-1">{deleting?.title}</strong>
              Future lease abstractions in this workspace will no longer be checked for this
              pattern. Existing risks already added to leases are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={saving}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {saving ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
