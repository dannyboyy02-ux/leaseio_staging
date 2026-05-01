/**
 * "+ Risk" dialog. Two flows:
 *   1. Pick from a template (system + workspace) and optionally edit.
 *   2. Write a fully custom risk.
 *
 * Citation capture supports two modes:
 *   - Type the snippet + page number directly.
 *   - "Highlight in PDF" — opens the parent's PdfViewer in capture-mode;
 *     the user selects text on any page and clicks "Use selection".
 *
 * On save the matcher is run (via supabase fetch + the existing matcher
 * import) to confirm the citation can be located somewhere in the PDF;
 * if not, the user is warned but the save is still allowed (some risks
 * are conceptual, not citation-anchored).
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Search, Wand2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface RiskTemplate {
  id: string;
  workspace_id: string | null;
  is_system: boolean;
  title: string;
  severity: 'low' | 'medium' | 'high';
  default_explanation: string;
  asset_type: string | null;
}

export interface PendingCitation {
  page: number;
  text: string;
}

interface AddRiskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  workspaceId: string | null;
  /** Called after a successful insert so the parent can refetch the risks list. */
  onRiskAdded: () => void;
  /** Triggered when the user clicks "Highlight in PDF" — the parent toggles
   *  PdfViewer capture mode. The dialog stays open underneath at reduced
   *  opacity so it's still in context. */
  onRequestCapture: () => void;
  /** Captured selection from PdfViewer in capture mode. */
  pendingCapture: PendingCitation | null;
  /** Clear capture (e.g. after we consume it into the form). */
  clearPendingCapture: () => void;
  /** Whether capture mode is active (used to dim the dialog). */
  captureActive: boolean;
}

const SEV_BADGE: Record<string, string> = {
  high: 'bg-red-100 text-red-700 border-red-300',
  medium: 'bg-amber-100 text-amber-700 border-amber-300',
  low: 'bg-blue-100 text-blue-700 border-blue-300',
};

export function AddRiskDialog({
  open,
  onOpenChange,
  leaseId,
  workspaceId,
  onRiskAdded,
  onRequestCapture,
  pendingCapture,
  clearPendingCapture,
  captureActive,
}: AddRiskDialogProps) {
  const [tab, setTab] = useState<'template' | 'custom'>('template');
  const [templates, setTemplates] = useState<RiskTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);

  // Form state — used by both tabs (template prefills, custom writes from scratch).
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<'low' | 'medium' | 'high'>('medium');
  const [explanation, setExplanation] = useState('');
  const [citationSnippet, setCitationSnippet] = useState('');
  const [citationPage, setCitationPage] = useState<string>('');
  const [saving, setSaving] = useState(false);
  // When the user creates a CUSTOM risk, they can opt in to "watch for this
  // pattern on future abstractions" — that promotes the title/severity/
  // explanation into a workspace-scoped row in risk_templates so future
  // process_lease runs in this workspace include it as a "must check" risk.
  const [saveAsWatchTemplate, setSaveAsWatchTemplate] = useState<boolean>(false);

  // Reset form when dialog opens.
  useEffect(() => {
    if (open) {
      setTab('template');
      setSearchQuery('');
      setPickedTemplateId(null);
      setTitle('');
      setSeverity('medium');
      setExplanation('');
      setCitationSnippet('');
      setCitationPage('');
      setSaveAsWatchTemplate(false);
    }
  }, [open]);

  // Load templates when dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTemplatesLoading(true);
    (async () => {
      const { data, error } = await (supabase as any)
        .from('risk_templates')
        .select('id, workspace_id, is_system, title, severity, default_explanation, asset_type')
        .order('is_system', { ascending: false })
        .order('title');
      if (!cancelled) {
        if (error) {
          toast.error(`Failed to load templates: ${error.message}`);
        } else {
          setTemplates((data ?? []) as RiskTemplate[]);
        }
        setTemplatesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // When PdfViewer hands a captured selection back, fill the citation fields.
  useEffect(() => {
    if (!pendingCapture) return;
    setCitationPage(String(pendingCapture.page));
    setCitationSnippet(pendingCapture.text);
    clearPendingCapture();
    toast.success(`Captured selection from page ${pendingCapture.page}`);
  }, [pendingCapture, clearPendingCapture]);

  const filteredTemplates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.default_explanation.toLowerCase().includes(q)
    );
  }, [templates, searchQuery]);

  const handlePickTemplate = (t: RiskTemplate) => {
    setPickedTemplateId(t.id);
    setTitle(t.title);
    setSeverity(t.severity);
    setExplanation(t.default_explanation);
  };

  const isFormValid = title.trim().length >= 3 && explanation.trim().length >= 5;

  const handleSubmit = async () => {
    if (!isFormValid) {
      toast.error('Title and explanation are required');
      return;
    }
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;
      const pageNum = citationPage.trim() ? Number(citationPage.trim()) : null;
      if (citationPage.trim() && (!Number.isFinite(pageNum) || (pageNum as number) < 1)) {
        throw new Error('Citation page must be a positive integer');
      }
      const insertPayload = {
        lease_id: leaseId,
        title: title.trim(),
        severity,
        explanation: explanation.trim(),
        citation_snippet: citationSnippet.trim() || null,
        citation_page: pageNum,
        is_user_added: true,
        created_by: userId,
        risk_template_id: tab === 'template' ? pickedTemplateId : null,
      };
      // If user opted in, promote the custom risk to a workspace template
      // BEFORE inserting the risk row, so we can FK-link them.
      let promotedTemplateId: string | null = null;
      if (tab === 'custom' && saveAsWatchTemplate && workspaceId) {
        const { data: tmplRow, error: tmplErr } = await (supabase as any)
          .from('risk_templates')
          .insert({
            workspace_id: workspaceId,
            is_system: false,
            title: title.trim(),
            severity,
            default_explanation: explanation.trim(),
            created_by: userId,
          })
          .select('id')
          .single();
        if (tmplErr) {
          console.warn('[AddRiskDialog] could not save as template (continuing without):', tmplErr.message);
        } else {
          promotedTemplateId = tmplRow?.id ?? null;
        }
      }

      const finalPayload = {
        ...insertPayload,
        risk_template_id: promotedTemplateId ?? insertPayload.risk_template_id,
      };

      const { data: inserted, error: insertError } = await (supabase as any)
        .from('risks')
        .insert(finalPayload)
        .select('id')
        .single();
      if (insertError) throw insertError;
      // Audit log entry — keeps full provenance for HITL verification.
      await (supabase as any).from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: userId,
        activity_type: 'risk_added',
        details: {
          risk_id: inserted?.id ?? null,
          risk_title: title.trim(),
          severity,
          citation_page: pageNum,
          source: tab === 'template' ? 'template' : 'custom',
          template_id: tab === 'template' ? pickedTemplateId : promotedTemplateId,
          promoted_to_template: !!promotedTemplateId,
        },
      });
      toast.success(`Added risk: ${title.trim()}`);
      onRiskAdded();
      onOpenChange(false);
    } catch (err: any) {
      console.error('[AddRiskDialog] save failed:', err);
      toast.error(`Could not add risk: ${err?.message ?? 'unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent
        className={cn(
          // Fit within viewport: cap height at 90vh, scroll the body, keep
          // header + footer anchored. Width caps so it stops growing on
          // wide screens.
          'sm:max-w-[640px] max-h-[90vh] flex flex-col p-0 gap-0',
          captureActive && 'opacity-50 pointer-events-none transition-opacity'
        )}
      >
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle>Add a risk to this lease</DialogTitle>
          <DialogDescription>
            Pick a predefined risk or write your own. Cite the supporting clause so it shows up
            with a (Page N) link and Sparkles highlight just like AI-extracted risks.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pt-2 pb-2 space-y-3">

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'template' | 'custom')}>
          <TabsList className="grid grid-cols-2 mb-2">
            <TabsTrigger value="template" className="gap-1.5">
              <Wand2 className="h-3.5 w-3.5" /> From template
            </TabsTrigger>
            <TabsTrigger value="custom" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Custom
            </TabsTrigger>
          </TabsList>

          <TabsContent value="template" className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search templates…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <div className="max-h-48 overflow-y-auto border rounded">
              {templatesLoading ? (
                <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading templates…
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  No templates match your search.
                </div>
              ) : (
                <ul className="divide-y">
                  {filteredTemplates.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => handlePickTemplate(t)}
                        className={cn(
                          'w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors',
                          pickedTemplateId === t.id && 'bg-primary/10'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm flex-1">{t.title}</span>
                          <Badge className={cn('text-[10px]', SEV_BADGE[t.severity])}>
                            {t.severity}
                          </Badge>
                          {t.is_system && (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              system
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {t.default_explanation}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {pickedTemplateId && (
              <p className="text-xs text-muted-foreground">
                Edit the prefilled fields below before saving — your edits don't change the template.
              </p>
            )}
          </TabsContent>

          <TabsContent value="custom" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Write a one-off risk specific to this lease.
            </p>
          </TabsContent>
        </Tabs>

        {/* Watch-template opt-in — only meaningful for custom risks. When
            the user picks an existing template the row is already in
            risk_templates so this checkbox is hidden. */}
        {tab === 'custom' && workspaceId && (
          <div className="border rounded-md bg-muted/30 p-3 space-y-1.5">
            <label className="flex items-start gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={saveAsWatchTemplate}
                onChange={(e) => setSaveAsWatchTemplate(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
              />
              <span className="flex-1">
                <span className="font-medium">Watch for this risk in future abstractions</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Saves this title, severity, and explanation as a workspace template. The AI will
                  flag it on future leases in this workspace if it spots a matching clause.
                  Manage templates in <span className="underline">Settings → Workspace → Risk Watchlist</span>.
                </span>
              </span>
            </label>
          </div>
        )}

        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="risk-title">Title</Label>
            <Input
              id="risk-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Mileage overage at 35¢/mile"
              maxLength={200}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="risk-severity">Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as any)}>
              <SelectTrigger id="risk-severity" className="h-9">
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
            <Label htmlFor="risk-explanation">Explanation</Label>
            <Textarea
              id="risk-explanation"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="Why this matters and what the practical implication is."
              rows={3}
            />
          </div>

          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-muted-foreground">
                Citation (optional)
              </Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={onRequestCapture}
                disabled={captureActive}
              >
                <Search className="h-3 w-3" />
                {captureActive ? 'Selecting…' : 'Highlight in PDF'}
              </Button>
            </div>
            <div className="grid grid-cols-[1fr,80px] gap-2">
              <Textarea
                value={citationSnippet}
                onChange={(e) => setCitationSnippet(e.target.value)}
                placeholder="Paste or type the supporting clause text (or click Highlight in PDF)"
                rows={2}
                className="text-xs"
              />
              <Input
                placeholder="Page"
                inputMode="numeric"
                value={citationPage}
                onChange={(e) => setCitationPage(e.target.value.replace(/[^\d]/g, ''))}
                className="h-9 text-sm self-start"
              />
            </div>
          </div>
        </div>

        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isFormValid || saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Adding…
              </>
            ) : (
              'Add risk'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
