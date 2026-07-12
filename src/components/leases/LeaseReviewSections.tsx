import { useState, useRef, useEffect } from 'react';
// Icons previously used by SECTION_CONFIG (Building2, Calendar, DollarSign,
// FileText, Users, MapPin, RefreshCw, ScrollText) moved to
// src/lib/leaseReviewSectionConfig.ts along with the data.
import {
  AlertTriangle,
  Check,
  Pencil,
  X,
  Target,
  ShieldCheck,
  ChevronRight,
  Sparkles,
  CheckCircle2,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedCurrency, formatLocalizedNumber } from '@/lib/dateFormatters';
import { getFieldConfidence, confidenceTier } from '@/lib/extractedFieldHelpers';
import type { ConfidenceScores } from '@/types/workflow';

// P2-04: SECTION_CONFIG, SectionKey, findFieldLabel moved to
// src/lib/leaseReviewSectionConfig.ts (pure module, no supabase
// import, testable in vitest's node environment). Imported here for
// the component definitions below and re-exported for backwards
// compatibility with existing call sites.
import { SECTION_CONFIG, findFieldLabel, type SectionKey } from '@/lib/leaseReviewSectionConfig';
export { SECTION_CONFIG, findFieldLabel, type SectionKey };

// Confidence badge component
export const ConfidenceBadge = ({ confidence }: { confidence: number | null }) => {
  const { t } = useLanguage();
  if (confidence === null) {
    return (
      <Badge variant="outline" className="text-[9px] h-4 font-medium text-muted-foreground bg-muted">
        <HelpCircle size={8} className="mr-0.5" />
        {t('leases.review_sections.na')}
      </Badge>
    );
  }

  const percentage = Math.round(confidence * 100);
  const tier = confidenceTier(confidence);

  if (tier === 'high') {
    return (
      <Badge variant="outline" className="text-[9px] h-4 font-medium text-green-600 border-green-400 bg-green-50">
        <CheckCircle2 size={8} className="mr-0.5" />
        {percentage}%
      </Badge>
    );
  }

  if (tier === 'medium') {
    return (
      <Badge variant="outline" className="text-[9px] h-4 font-medium text-amber-600 border-amber-400 bg-amber-50">
        <AlertTriangle size={8} className="mr-0.5" />
        {percentage}%
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-[9px] h-4 font-medium text-red-600 border-red-400 bg-red-50">
      <XCircle size={8} className="mr-0.5" />
      {percentage}%
    </Badge>
  );
};

interface ExtractedField {
  value: any;
  page?: number;
  confidence: 'low' | 'medium' | 'high' | number;
  source_text?: string;
}

// getFieldConfidence now lives in the pure helper lib (so presentational
// components can read per-field confidence without this module's supabase
// import). Imported above; re-exported here for existing call sites.
export { getFieldConfidence };

// Get page from extracted_json field
export const getFieldPage = (extractedJson: Record<string, any> | null, fieldId: string): number | undefined => {
  if (!extractedJson) return undefined;
  const field = extractedJson[fieldId] as ExtractedField | undefined;
  return field?.page;
};

// Get the AI extraction's quoted source text for the field. Used to highlight
// the supporting clause in the PDF when the user clicks the field or the AI
// icon next to it.
export const getFieldSourceText = (extractedJson: Record<string, any> | null, fieldId: string): string | undefined => {
  if (!extractedJson) return undefined;
  const field = extractedJson[fieldId] as ExtractedField | undefined;
  return field?.source_text;
};

interface SectionCardProps {
  sectionKey: SectionKey;
  form: Record<string, string>;
  extractedJson: Record<string, any> | null;
  confidenceScores: ConfidenceScores;
  isLocked: boolean;
  isModelLocked: boolean;
  assetTypes?: string[];
  onFieldChange: (fieldId: string, value: string) => void;
  onFieldFocus: (fieldId: string) => void;
  onFieldBlur: (fieldId: string) => void;
  /**
   * Direct-staging escape hatch for inputs (like Radix Select) that don't
   * fire a separate blur after value commit. Receives the new value
   * explicitly to avoid a closure-staleness race against form state.
   */
  onFieldStaged?: (fieldId: string, newValue: string) => void;
  onJumpToPage: (page?: number, sourceText?: string, value?: string) => void;
  /** When false, hide the per-field "View in document" affordance — the
   *  source jump dead-ends when no PDF panel is shown (locked/Vault leases),
   *  so don't offer a verify gesture that can't deliver. Defaults to true. */
  sourceViewable?: boolean;
  /** When true, suppress the per-field confidence badge. Set after a lease
   *  has been initially activated — confidence is a review-time signal, not
   *  relevant once the lease is in production use. */
  hideConfidence?: boolean;
}

export function SectionCard({
  sectionKey,
  form,
  extractedJson,
  confidenceScores,
  isLocked,
  isModelLocked,
  assetTypes,
  onFieldChange,
  onFieldFocus,
  onFieldBlur,
  onFieldStaged,
  onJumpToPage,
  sourceViewable = true,
  hideConfidence = false,
}: SectionCardProps) {
  const { language, t } = useLanguage();
  const [isEditing, setIsEditing] = useState(!isLocked);
  // When the lease unlocks (isLocked transitions true → false), reflect that
  // in the section's editing state so the user doesn't have to also click the
  // per-section "Edit" button. Conversely, re-locking forces edit mode off.
  useEffect(() => {
    setIsEditing(!isLocked);
  }, [isLocked]);
  const [termUnit, setTermUnit] = useState<'months' | 'years'>('months');
  const section = SECTION_CONFIG[sectionKey];
  const Icon = section.icon;

  const getFieldBorderClass = (fieldId: string) => {
    const fieldConf = getFieldConfidence(extractedJson, fieldId);
    if (fieldConf !== null && fieldConf < 0.70) {
      return 'border-red-400 border-2';
    }
    if (fieldConf !== null && fieldConf < 0.80) {
      return 'border-amber-400 border-2';
    }
    return '';
  };

  // Auto-resize textarea: plain function, called as a callback ref
  const autoResizeRef = (el: HTMLTextAreaElement | null) => {
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  };

  const isCurrencyField = (fieldId: string) =>
    fieldId.includes('rent') || fieldId.includes('deposit');

  return (
    <Card
      data-section-key={sectionKey}
      className={cn("shadow-none border overflow-hidden")}
    >
      <CardHeader className="bg-muted/30 border-b py-3">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <Icon size={16} className="text-primary" />
          {t(`lease_review.section_config.${sectionKey}.title`, { defaultValue: section.title })}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {section.fields.map((field) => {
          const fieldConfidence = getFieldConfidence(extractedJson, field.id);
          const fieldLabel = t(`lease_review.field_labels.${field.id}`, { defaultValue: field.label });
          const fieldPage = getFieldPage(extractedJson, field.id);
          const fieldSourceText = getFieldSourceText(extractedJson, field.id);
          const isAIExtracted = fieldConfidence !== null;
          const value = form[field.id] || '';
          const FieldIcon = field.icon;
          const isReadOnly = isLocked || !isEditing;
          // Always use the AI's ORIGINAL extracted value as the primary
          // match target — never the form value, which the user may have
          // edited. Coerce numbers to strings so numeric fields (square
          // footage, rent amounts, etc.) participate in matching.
          const fieldExtractedValueRaw = extractedJson?.[field.id]?.value;
          let fieldExtractedValue: string | undefined;
          if (typeof fieldExtractedValueRaw === 'string' && fieldExtractedValueRaw.trim().length > 0) {
            fieldExtractedValue = fieldExtractedValueRaw;
          } else if (typeof fieldExtractedValueRaw === 'number' && Number.isFinite(fieldExtractedValueRaw)) {
            fieldExtractedValue = String(fieldExtractedValueRaw);
          }
          const locateInPdf = () => onJumpToPage(fieldPage, fieldSourceText, fieldExtractedValue);
          // Clicking/focusing the field also locates the source text in the PDF.
          const handleFieldFocus = () => {
            onFieldFocus(field.id);
            if (fieldPage) locateInPdf();
          };

          // Term field display value
          const termMonths = parseInt(value) || 0;
          const termDisplayValue = field.type === 'term'
            ? (termUnit === 'years' ? (termMonths > 0 ? (termMonths / 12).toFixed(1) : '') : value)
            : value;

          // Auto-resize ref for textareas (plain function, no hook needed)

          return (
            <div key={field.id}>
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-[10px] uppercase font-bold text-muted-foreground flex items-center gap-2">
                  <FieldIcon size={12} />
                  {fieldLabel}
                  {!isModelLocked && !hideConfidence && <ConfidenceBadge confidence={fieldConfidence} />}
                </Label>
                {/* The single "verify against the source document" affordance —
                    the trust gesture of an AI-extraction product. Muted text so
                    it doesn't compete with the green/amber/red confidence
                    palette; the orange sparkle icon alone carries the AI cue.
                    Always shown (so it's touch-reachable too) but only when a
                    source PDF is actually viewable — otherwise the jump
                    dead-ends on locked/Vault leases that show no PDF panel. */}
                {sourceViewable && isAIExtracted && fieldPage && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); locateInPdf(); }}
                    title={t('leases.review_sections.view_source_title', { page: fieldPage })}
                    className="inline-flex items-center gap-1 shrink-0 text-[10px] font-medium text-muted-foreground rounded px-1 py-0.5 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#CC785C]"
                  >
                    <Sparkles size={11} className="fill-[#CC785C] text-[#CC785C]" />
                    {t('leases.review_sections.view_in_document')}
                  </button>
                )}
              </div>

              {/* Textarea (auto-resize) */}
              {field.type === 'textarea' && (
                <div className="relative">
                  <Textarea
                    ref={autoResizeRef}
                    value={value}
                    onChange={(e) => {
                      onFieldChange(field.id, e.target.value);
                      e.currentTarget.style.height = 'auto';
                      e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                    }}
                    onFocus={handleFieldFocus}
                    onBlur={() => onFieldBlur(field.id)}
                    disabled={isReadOnly}
                    placeholder={t('leases.review_sections.no_field_extracted', { field: fieldLabel.toLowerCase() })}
                    className={cn(
                      "text-sm resize-none overflow-hidden min-h-[60px]",
                      getFieldBorderClass(field.id),
                      isReadOnly && "bg-muted/30"
                    )}
                  />
                </div>
              )}

              {/* Asset type Select dropdown.
                  Radix Select doesn't fire onBlur after a value commit, so
                  selection IS the commit point. Call onFieldChange (updates
                  form state) AND onFieldStaged (direct-stage with the new
                  value, bypassing form-state read to avoid a closure
                  staleness race). Without this, asset_type edits never
                  reached lease_change_set_items, so the Lock dialog kept
                  showing the empty-draft branch with no admin choice. */}
              {field.id === 'asset_type' && assetTypes && assetTypes.length > 0 && !isReadOnly && (
                <div className="relative">
                  <Select
                    value={value}
                    onValueChange={(v) => {
                      onFieldChange(field.id, v);
                      onFieldStaged?.(field.id, v);
                    }}
                  >
                    <SelectTrigger className={cn("text-sm", getFieldBorderClass(field.id))}>
                      <SelectValue placeholder={t('leases.review_sections.select_asset_type')} />
                    </SelectTrigger>
                    <SelectContent>
                      {assetTypes.map((at) => (
                        <SelectItem key={at} value={at}>{at}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Asset type read-only */}
              {field.id === 'asset_type' && (assetTypes === undefined || assetTypes.length === 0 || isReadOnly) && (
                <div className="relative">
                  <Input
                    type="text"
                    value={value}
                    onChange={(e) => onFieldChange(field.id, e.target.value)}
                    onFocus={handleFieldFocus}
                    onBlur={() => onFieldBlur(field.id)}
                    disabled={isReadOnly}
                    placeholder={t('leases.review_sections.no_asset_type')}
                    className={cn(
                      "text-sm",
                      getFieldBorderClass(field.id),
                      isReadOnly && "bg-muted/30",
                      !value && "text-muted-foreground italic"
                    )}
                  />
                </div>
              )}

              {/* Term field with Months/Years toggle */}
              {field.type === 'term' && (
                <div className="flex gap-2 items-center">
                  <div className="relative flex-1">
                    <Input
                      type="number"
                      value={termDisplayValue}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value) || 0;
                        onFieldChange(field.id, String(termUnit === 'years' ? Math.round(n * 12) : Math.round(n)));
                      }}
                      onFocus={handleFieldFocus}
                      onBlur={() => onFieldBlur(field.id)}
                      disabled={isReadOnly}
                      placeholder="—"
                      className={cn(
                        "text-sm",
                        getFieldBorderClass(field.id),
                        isReadOnly && "bg-muted/30"
                      )}
                    />
                  </div>
                  <div className="flex rounded-md border overflow-hidden text-xs shrink-0">
                    <button
                      type="button"
                      className={cn(
                        "px-2.5 py-1.5 transition-colors",
                        termUnit === 'months' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                      )}
                      onClick={() => setTermUnit('months')}
                    >{t('leases.review_sections.months_abbr')}</button>
                    <button
                      type="button"
                      className={cn(
                        "px-2.5 py-1.5 transition-colors",
                        termUnit === 'years' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                      )}
                      onClick={() => setTermUnit('years')}
                    >{t('leases.review_sections.years_abbr')}</button>
                  </div>
                </div>
              )}

              {/* Number fields — formatted display when read-only, plain input when editing */}
              {field.type === 'number' && (
                isReadOnly ? (
                  <div className={cn(
                    "relative text-sm px-3 py-2 rounded-md border bg-muted/30",
                    getFieldBorderClass(field.id)
                  )}>
                    {value
                      ? isCurrencyField(field.id)
                        ? formatLocalizedCurrency(parseFloat(value) || null, language)
                        : formatLocalizedNumber(Number(value), language)
                      : <span className="text-muted-foreground italic">—</span>
                    }
                  </div>
                ) : (
                  <div className="relative">
                    <Input
                      type="text"
                      value={value}
                      onChange={(e) => onFieldChange(field.id, e.target.value)}
                      onFocus={handleFieldFocus}
                      onBlur={() => onFieldBlur(field.id)}
                      disabled={false}
                      placeholder={t('leases.review_sections.no_field_extracted', { field: fieldLabel.toLowerCase() })}
                      className={cn(
                        "text-sm",
                        getFieldBorderClass(field.id),
                        !value && "text-muted-foreground italic"
                      )}
                    />
                  </div>
                )
              )}

              {/* Standard text / date fields */}
              {field.type !== 'textarea' && field.type !== 'term' && field.type !== 'number' && field.id !== 'asset_type' && (
                <div className="relative">
                  <Input
                    type={field.type === 'date' ? 'date' : 'text'}
                    value={value}
                    onChange={(e) => onFieldChange(field.id, e.target.value)}
                    onFocus={handleFieldFocus}
                    onBlur={() => onFieldBlur(field.id)}
                    disabled={isReadOnly}
                    placeholder={t('leases.review_sections.no_field_extracted', { field: fieldLabel.toLowerCase() })}
                    className={cn(
                      "text-sm",
                      getFieldBorderClass(field.id),
                      isReadOnly && "bg-muted/30",
                      !value && "text-muted-foreground italic"
                    )}
                  />
                </div>
              )}

              {!value && field.type !== 'term' && (
                <p className="text-[10px] text-muted-foreground mt-1 italic">
                  {t('leases.review_sections.field_empty')}
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// Risks section component
interface Risk {
  id: string;
  title: string;
  severity: string;
  explanation: string | null;
  citation_snippet: string | null;
  citation_page: number | null;
}

interface RisksSectionProps {
  risks: Risk[];
  onJumpToPage: (page?: number, sourceText?: string, value?: string) => void;
  /** When false, hide the "(Page N)" citation jump — it dead-ends when no PDF
   *  panel is shown (locked/Vault leases, or narrow viewports). Defaults true. */
  sourceViewable?: boolean;
  /** Lease the risks belong to. Required to dismiss; if omitted, dismiss UI is hidden. */
  leaseId?: string;
  /** Called after a successful dismiss so the parent can re-fetch risks. */
  onRisksChanged?: () => void;
}

export function RisksSection({ risks, onJumpToPage, sourceViewable = true, leaseId, onRisksChanged }: RisksSectionProps) {
  const { t } = useLanguage();
  const [dismissTarget, setDismissTarget] = useState<Risk | null>(null);
  const [dismissReason, setDismissReason] = useState<string>('');
  const [dismissing, setDismissing] = useState<boolean>(false);

  const getSeverityColor = (severity: string) => {
    switch (severity.toLowerCase()) {
      case 'high':
        return 'bg-red-100 text-red-700 border-red-300';
      case 'medium':
        return 'bg-amber-100 text-amber-700 border-amber-300';
      case 'low':
        return 'bg-blue-100 text-blue-700 border-blue-300';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  const handleConfirmDismiss = async () => {
    if (!dismissTarget || !leaseId) return;
    setDismissing(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;
      const reasonTrimmed = dismissReason.trim() || null;

      const { data: updatedRows, error: updateError } = await (supabase as any)
        .from('risks')
        .update({
          dismissed_at: new Date().toISOString(),
          dismissed_by: userId,
          dismissed_reason: reasonTrimmed,
        })
        .eq('id', dismissTarget.id)
        .select('id');
      if (updateError) throw updateError;
      // Defend against silent 0-row updates from a future RLS gap — without
      // this check, RLS could swallow the write and the toast would lie.
      if (!updatedRows || updatedRows.length === 0) {
        throw new Error(t('leases.risk.no_rows_updated'));
      }

      // Audit log entry — keeps reporting and compliance trail intact.
      await (supabase as any).from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: userId,
        activity_type: 'risk_dismissed',
        details: {
          risk_id: dismissTarget.id,
          risk_title: dismissTarget.title,
          severity: dismissTarget.severity,
          citation_page: dismissTarget.citation_page,
          reason: reasonTrimmed,
        },
      });

      toast.success(t('leases.risk.dismissed', { title: dismissTarget.title }));
      setDismissTarget(null);
      setDismissReason('');
      onRisksChanged?.();
    } catch (err: any) {
      console.error('[RisksSection] dismiss failed:', err);
      toast.error(t('leases.risk.dismiss_failed', { message: err?.message ?? t('leases.risk.unknown_error') }));
    } finally {
      setDismissing(false);
    }
  };

  if (!risks || risks.length === 0) {
    return (
      <Card className="shadow-none border overflow-hidden">
        <CardHeader className="bg-muted/30 border-b py-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" />
            {t('leases.risk.risks_title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          <p className="text-sm text-muted-foreground text-center py-4">
            {t('leases.risk.none_identified')}
          </p>
        </CardContent>
      </Card>
    );
  }

  const canDismiss = !!leaseId;

  return (
    <>
      <Card className="shadow-none border overflow-hidden">
        <CardHeader className="bg-muted/30 border-b py-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-600" />
            {t('leases.risk.risks_title')}
            <Badge variant="outline" className="ml-1">
              {risks.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          {risks.map((risk) => (
            <div key={risk.id} className="rounded-lg border p-3 space-y-2 group">
              <div className="flex items-start justify-between gap-2">
                <h4 className="font-medium text-sm">{risk.title}</h4>
                <div className="flex items-center gap-1 shrink-0">
                  <Badge className={cn('text-[10px]', getSeverityColor(risk.severity))}>
                    {['low', 'medium', 'high'].includes(risk.severity.toLowerCase())
                      ? t(`leases.risk.severity_${risk.severity.toLowerCase()}`)
                      : risk.severity}
                  </Badge>
                  {canDismiss && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 text-[11px] gap-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 hover:border-destructive/40"
                      title={t('leases.risk.dismiss_hint')}
                      onClick={() => {
                        setDismissTarget(risk);
                        setDismissReason('');
                      }}
                    >
                      <X size={11} />
                      {t('leases.risk.dismiss')}
                    </Button>
                  )}
                </div>
              </div>
              {risk.explanation && (
                <p className="text-sm text-muted-foreground">{risk.explanation}</p>
              )}
              {risk.citation_snippet && (
                <div className="text-xs bg-muted/50 p-2 rounded italic">
                  "{risk.citation_snippet}"
                  {sourceViewable && risk.citation_page && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 ml-2 text-xs"
                      onClick={() => onJumpToPage(risk.citation_page || undefined, risk.citation_snippet || undefined)}
                    >
                      {t('leases.risk.citation_page', { page: risk.citation_page })}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <AlertDialog
        open={!!dismissTarget}
        onOpenChange={(open) => {
          if (!open && !dismissing) {
            setDismissTarget(null);
            setDismissReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('leases.risk.dismiss_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong className="block mb-1">{dismissTarget?.title}</strong>
              {t('leases.risk.dismiss_confirm_desc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">{t('leases.risk.reason_optional')}</Label>
            <Textarea
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              placeholder={t('leases.risk.dismiss_reason_placeholder')}
              rows={3}
              disabled={dismissing}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dismissing}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDismiss}
              disabled={dismissing}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              {dismissing ? t('leases.risk.dismissing') : t('leases.risk.dismiss_cta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
