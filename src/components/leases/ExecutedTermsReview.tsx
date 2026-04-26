import { useState, useEffect } from 'react';
import { Pencil, X, Save, CheckCircle, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';

interface PipelineTerms {
  tenant_name: string | null;
  landlord_name: string | null;
  lease_start: string | null;
  lease_end: string | null;
  current_monthly_rent: number | null;
  monthly_payment: number | null;
}

interface ExecutedTerms {
  executed_tenant_name: string | null;
  executed_landlord_name: string | null;
  executed_commencement_date: string | null;
  executed_expiry_date: string | null;
  executed_monthly_payment: number | null;
  executed_rent_review_clause: string | null;
  executed_break_clause: string | null;
  executed_extraction_confidence: Record<string, number> | null;
}

export interface ExecutedTermsReviewProps {
  leaseId: string;
  pipelineTerms: PipelineTerms;
  executedTerms: ExecutedTerms;
  canEdit: boolean;
  onTermUpdated: () => void;
  /** When provided, saves go to lease_change_set_items instead of lease columns */
  changeSetId?: string;
  /** Expose staged item count to parent for submit button visibility */
  onStagedCountChange?: (count: number) => void;
}

type FieldKey = 'tenant_name' | 'landlord_name' | 'commencement_date' | 'expiry_date' | 'monthly_payment' | 'rent_review_clause' | 'break_clause';

const FIELD_LABELS: Record<FieldKey, string> = {
  tenant_name: 'Tenant Name', landlord_name: 'Landlord Name',
  commencement_date: 'Commencement Date', expiry_date: 'Expiry Date',
  monthly_payment: 'Monthly Payment', rent_review_clause: 'Rent Review Clause', break_clause: 'Break Clause',
};

const DB_COLUMN_MAP: Record<FieldKey, string> = {
  tenant_name: 'executed_tenant_name', landlord_name: 'executed_landlord_name',
  commencement_date: 'executed_commencement_date', expiry_date: 'executed_expiry_date',
  monthly_payment: 'executed_monthly_payment', rent_review_clause: 'executed_rent_review_clause', break_clause: 'executed_break_clause',
};

const CONF_KEY_MAP: Record<FieldKey, string> = {
  tenant_name: 'tenant_name', landlord_name: 'landlord_name',
  commencement_date: 'commencement_date', expiry_date: 'expiry_date',
  monthly_payment: 'monthly_payment', rent_review_clause: 'rent_review_clause', break_clause: 'break_clause',
};

const ALL_FIELDS: FieldKey[] = ['tenant_name', 'landlord_name', 'commencement_date', 'expiry_date', 'monthly_payment', 'rent_review_clause', 'break_clause'];

function fmtField(field: FieldKey, value: string | number | null): string {
  if (value === null || value === undefined) return '\u2014';
  if (field === 'monthly_payment') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value));
  if (field === 'commencement_date' || field === 'expiry_date') {
    try { return format(new Date(value as string), 'MMM d, yyyy'); } catch { return value as string; }
  }
  return String(value);
}

function ConfBadge({ score }: { score: number | undefined }) {
  if (score === undefined) return null;
  const pct = Math.round(score * 100);
  if (pct >= 85) return <Badge variant="outline" className="text-xs text-green-600 border-green-300">{pct}%</Badge>;
  if (pct >= 65) return <Badge variant="outline" className="text-xs text-yellow-600 border-yellow-300">{pct}%</Badge>;
  return <Badge variant="outline" className="text-xs text-destructive border-destructive/30">{pct}%</Badge>;
}

export function ExecutedTermsReview({ leaseId, pipelineTerms, executedTerms, canEdit, onTermUpdated, changeSetId, onStagedCountChange }: ExecutedTermsReviewProps) {
  const [editingField, setEditingField] = useState<FieldKey | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editReason, setEditReason] = useState('');
  const [saving, setSaving] = useState(false);
  // field_name → proposed_value for staged items
  const [stagedItems, setStagedItems] = useState<Record<string, string | null>>({});

  // Load existing staged items when in staged editing mode
  useEffect(() => {
    if (!changeSetId) { setStagedItems({}); return; }
    (supabase as any)
      .from('lease_change_set_items')
      .select('field_name, proposed_value')
      .eq('change_set_id', changeSetId)
      .then(({ data }: { data: Array<{ field_name: string; proposed_value: string | null }> | null }) => {
        const map: Record<string, string | null> = {};
        (data ?? []).forEach((item) => { map[item.field_name] = item.proposed_value; });
        setStagedItems(map);
        onStagedCountChange?.(Object.keys(map).length);
      });
  }, [changeSetId]);

  const getPipeline = (field: FieldKey): string | number | null => {
    switch (field) {
      case 'tenant_name': return pipelineTerms.tenant_name;
      case 'landlord_name': return pipelineTerms.landlord_name;
      case 'commencement_date': return pipelineTerms.lease_start;
      case 'expiry_date': return pipelineTerms.lease_end;
      case 'monthly_payment': return pipelineTerms.current_monthly_rent ?? pipelineTerms.monthly_payment;
      default: return null;
    }
  };

  const getExecuted = (field: FieldKey): string | number | null => {
    switch (field) {
      case 'tenant_name': return executedTerms.executed_tenant_name;
      case 'landlord_name': return executedTerms.executed_landlord_name;
      case 'commencement_date': return executedTerms.executed_commencement_date;
      case 'expiry_date': return executedTerms.executed_expiry_date;
      case 'monthly_payment': return executedTerms.executed_monthly_payment;
      case 'rent_review_clause': return executedTerms.executed_rent_review_clause;
      case 'break_clause': return executedTerms.executed_break_clause;
    }
  };

  const getConf = (field: FieldKey) => executedTerms.executed_extraction_confidence?.[CONF_KEY_MAP[field]];

  const startEdit = (field: FieldKey) => {
    const cur = getExecuted(field);
    setEditValue(cur !== null ? String(cur) : '');
    setEditReason('');
    setEditingField(field);
  };

  const cancelEdit = () => { setEditingField(null); setEditValue(''); setEditReason(''); };

  const saveEdit = async (field: FieldKey) => {
    if (!editReason.trim()) { toast.error('Please provide a reason for the edit'); return; }
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      const original = getExecuted(field);
      let parsed: string | number | null = editValue.trim() || null;
      if (field === 'monthly_payment' && parsed !== null) {
        const n = parseFloat(parsed as string);
        if (isNaN(n)) { toast.error('Monthly payment must be a number'); return; }
        parsed = n;
      }

      if (changeSetId) {
        // Staged editing mode: write to change_set_items, NOT to lease columns
        const proposedStr = parsed !== null ? String(parsed) : null;
        const oldStr = original !== null ? String(original) : null;

        // Upsert: delete existing item for this field then insert new one
        await (supabase as any)
          .from('lease_change_set_items')
          .delete()
          .eq('change_set_id', changeSetId)
          .eq('field_name', field);

        const { error: itemErr } = await (supabase as any)
          .from('lease_change_set_items')
          .insert({
            change_set_id: changeSetId,
            field_name: field,
            field_label: FIELD_LABELS[field],
            old_value: oldStr,
            proposed_value: proposedStr,
            source_section: 'executed_terms',
          });
        if (itemErr) throw new Error(`Stage failed: ${itemErr.message}`);

        const newStaged = { ...stagedItems, [field]: proposedStr };
        setStagedItems(newStaged);
        onStagedCountChange?.(Object.keys(newStaged).length);
        toast.success(`${FIELD_LABELS[field]} staged — submit changes when ready`);
        cancelEdit();
        onTermUpdated();
      } else {
        // Direct edit mode (legacy — only available without change set)
        const { error: auditErr } = await supabase.from('executed_term_edits').insert({
          lease_id: leaseId, field_name: field,
          original_value: original !== null ? String(original) : null,
          edited_value: parsed !== null ? String(parsed) : null,
          edited_by: user.id, reason: editReason.trim(),
        });
        if (auditErr) throw new Error(`Audit insert failed: ${auditErr.message}`);
        const { error: updErr } = await supabase.from('leases').update({ [DB_COLUMN_MAP[field]]: parsed }).eq('id', leaseId);
        if (updErr) throw new Error(`Update failed: ${updErr.message}`);
        await supabase.from('lease_activity_log').insert({
          lease_id: leaseId, user_id: user.id, activity_type: 'status_change',
          details: { action: 'executed_terms_edited', field, original: original !== null ? String(original) : null, edited: parsed !== null ? String(parsed) : null, reason: editReason.trim() },
        });
        toast.success(`${FIELD_LABELS[field]} updated`);
        cancelEdit();
        onTermUpdated();
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to save edit');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-primary" />
          Executed Terms Review
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left py-2 px-4 font-medium text-muted-foreground w-36">Field</th>
                <th className="text-left py-2 px-4 font-medium text-muted-foreground">Pipeline</th>
                <th className="text-left py-2 px-4 font-medium text-muted-foreground">Executed</th>
                <th className="text-left py-2 px-4 font-medium text-muted-foreground w-16">Conf.</th>
                {canEdit && <th className="w-10 py-2 px-4" />}
              </tr>
            </thead>
            <tbody>
              {ALL_FIELDS.map((field) => {
                const isEditing = editingField === field;
                return (
                  <tr key={field} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="py-3 px-4 font-medium text-muted-foreground whitespace-nowrap">{FIELD_LABELS[field]}</td>
                    <td className="py-3 px-4 text-muted-foreground">{fmtField(field, getPipeline(field))}</td>
                    <td className="py-3 px-4">
                      {isEditing ? (
                        <div className="space-y-2 min-w-[220px]">
                          <Input value={editValue} onChange={(e) => setEditValue(e.target.value)}
                            placeholder={field === 'monthly_payment' ? '0.00' : (field === 'commencement_date' || field === 'expiry_date') ? 'YYYY-MM-DD' : ''}
                            className="h-7 text-sm" autoFocus />
                          <div>
                            <Label className="text-xs text-muted-foreground">Reason *</Label>
                            <Textarea value={editReason} onChange={(e) => setEditReason(e.target.value)}
                              placeholder="Reason for edit..." className="text-xs min-h-[52px] mt-0.5" rows={2} />
                          </div>
                          <div className="flex gap-1.5">
                            <Button size="sm" className="h-6 text-xs px-2" onClick={() => saveEdit(field)} disabled={saving}>
                              {saving ? <Clock className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}
                              {changeSetId ? 'Stage' : 'Save'}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={cancelEdit}>
                              <X className="h-3 w-3 mr-1" />Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <span className={`flex items-center gap-1.5 ${getExecuted(field) === null && !stagedItems[field] ? 'text-muted-foreground/50 italic' : ''}`}>
                          {stagedItems[field] !== undefined
                            ? fmtField(field, stagedItems[field])
                            : fmtField(field, getExecuted(field))}
                          {stagedItems[field] !== undefined && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 text-blue-600 border-blue-300">Staged</Badge>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4"><ConfBadge score={getConf(field)} /></td>
                    {canEdit && (
                      <td className="py-3 px-4">
                        {!isEditing && (
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEdit(field)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
