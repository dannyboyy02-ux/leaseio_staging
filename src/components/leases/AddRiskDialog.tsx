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
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { mapSupabaseError } from '@/lib/userFacingError';

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
  const { t } = useAppTranslation();
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
          toast.error(t('leases.risk.load_templates_failed', { message: error.message }));
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
    toast.success(t('leases.risk.captured_from_page', { page: pendingCapture.page }));
  }, [pendingCapture, clearPendingCapture, t]);

  const filteredTemplates = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (tpl) =>
        tpl.title.toLowerCase().includes(q) ||
        tpl.default_explanation.toLowerCase().includes(q)
    );
  }, [templates, searchQuery]);

  const handlePickTemplate = (tpl: RiskTemplate) => {
    setPickedTemplateId(tpl.id);
    setTitle(tpl.title);
    setSeverity(tpl.severity);
    setExplanation(tpl.default_explanation);
  };

  const isFormValid = title.trim().length >= 3 && explanation.trim().length >= 5;

  const handleSubmit = async () => {
    if (!isFormValid) {
      toast.error(t('leases.risk.validation_required'));
      return;
    }
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;
      const pageNum = citationPage.trim() ? Number(citationPage.trim()) : null;
      if (citationPage.trim() && (!Number.isFinite(pageNum) || (pageNum as number) < 1)) {
        throw new Error(t('leases.risk.citation_page_invalid'));
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
      toast.success(t('leases.risk.added', { title: title.trim() }));
      onRiskAdded();
      onOpenChange(false);
    } catch (err) {
      // #173: raw driver/trigger text never reaches the UI (helper logs it).
      toast.error(mapSupabaseError(err, t, 'leases.risk.add_failed', '[AddRiskDialog] save failed:'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)} modal={!captureActive}>
      <DialogContent
        // When capture is active we go non-modal AND shrink to a docked
        // corner card. This frees the PDF text layer for native text
        // selection (Radix's modal overlay otherwise blocks all pointer
        // events behind the dialog, which is why the previous version
        // looked clickable but actually wasn't).
        className={cn(
          'flex flex-col p-0 gap-0',
          !captureActive && 'sm:max-w-[640px] max-h-[90vh]',
          captureActive && [
            // Detach from center, dock to bottom-right, smaller footprint.
            'fixed top-auto bottom-4 right-4 left-auto translate-x-0 translate-y-0',
            'w-[360px] max-w-[calc(100vw-2rem)] max-h-[60vh]',
            'shadow-xl border-amber-300 ring-2 ring-amber-200',
          ],
        )}
      >
        {captureActive && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-[12px] text-amber-900 flex items-center gap-2 shrink-0">
            <span className="font-medium">{t('leases.risk.selecting_banner')}</span>
            <span className="text-amber-800">{t('leases.risk.selecting_hint_before')} <strong>{t('leases.risk.use_selection')}</strong> {t('leases.risk.selecting_hint_after')}</span>
          </div>
        )}
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle>{t('leases.risk.title')}</DialogTitle>
          {!captureActive && (
            <DialogDescription>
              {t('leases.risk.description')}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 pt-2 pb-2 space-y-3">

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'template' | 'custom')}>
          <TabsList className="grid grid-cols-2 mb-2">
            <TabsTrigger value="template" className="gap-1.5">
              <Wand2 className="h-3.5 w-3.5" /> {t('leases.risk.tab_template')}
            </TabsTrigger>
            <TabsTrigger value="custom" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" /> {t('leases.risk.tab_custom')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="template" className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('leases.risk.search_placeholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 h-8 text-sm"
              />
            </div>
            <div className="max-h-48 overflow-y-auto border rounded">
              {templatesLoading ? (
                <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('leases.risk.loading_templates')}
                </div>
              ) : filteredTemplates.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {t('leases.risk.no_templates_match')}
                </div>
              ) : (
                <ul className="divide-y">
                  {filteredTemplates.map((tpl) => (
                    <li key={tpl.id}>
                      <button
                        type="button"
                        onClick={() => handlePickTemplate(tpl)}
                        className={cn(
                          'w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors',
                          pickedTemplateId === tpl.id && 'bg-primary/10'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm flex-1">{tpl.title}</span>
                          <Badge className={cn('text-[10px]', SEV_BADGE[tpl.severity])}>
                            {t(`leases.risk.severity_${tpl.severity}`)}
                          </Badge>
                          {tpl.is_system && (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              {t('leases.risk.system_badge')}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {tpl.default_explanation}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {pickedTemplateId && (
              <p className="text-xs text-muted-foreground">
                {t('leases.risk.template_edit_hint')}
              </p>
            )}
          </TabsContent>

          <TabsContent value="custom" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {t('leases.risk.custom_hint')}
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
                <span className="font-medium">{t('leases.risk.watch_label')}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  {t('leases.risk.watch_desc')} <span className="underline">{t('leases.risk.watch_path')}</span>.
                </span>
              </span>
            </label>
          </div>
        )}

        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="risk-title">{t('workspace.watchlist.form_title')}</Label>
            <Input
              id="risk-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('workspace.watchlist.title_placeholder')}
              maxLength={200}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="risk-severity">{t('workspace.watchlist.form_severity')}</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as any)}>
              <SelectTrigger id="risk-severity" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{t('workspace.watchlist.sev_low')}</SelectItem>
                <SelectItem value="medium">{t('workspace.watchlist.sev_medium')}</SelectItem>
                <SelectItem value="high">{t('workspace.watchlist.sev_high')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="risk-explanation">{t('workspace.watchlist.form_explanation')}</Label>
            <Textarea
              id="risk-explanation"
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder={t('leases.risk.explanation_placeholder')}
              rows={3}
            />
          </div>

          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-muted-foreground">
                {t('leases.risk.citation_label')}
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
                {captureActive ? t('leases.risk.selecting_button') : t('leases.risk.highlight_in_pdf')}
              </Button>
            </div>
            <div className="grid grid-cols-[1fr,80px] gap-2">
              <Textarea
                value={citationSnippet}
                onChange={(e) => setCitationSnippet(e.target.value)}
                placeholder={t('leases.risk.citation_placeholder')}
                rows={2}
                className="text-xs"
              />
              <Input
                placeholder={t('common.page')}
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
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!isFormValid || saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                {t('leases.risk.adding')}
              </>
            ) : (
              t('leases.risk.add_cta')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
