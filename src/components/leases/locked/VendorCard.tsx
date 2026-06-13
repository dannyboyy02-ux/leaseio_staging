import { useEffect, useState } from 'react';
import { Pencil, Save, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAppTranslation } from '@/hooks/useAppTranslation';

import { SectionCard } from './SectionCard';
import { LabelValueGrid } from './LabelValueGrid';

interface VendorFields {
  vendor_name: string | null;
  vendor_phone: string | null;
  vendor_address_line1: string | null;
  vendor_address_line2: string | null;
  vendor_city: string | null;
  vendor_state: string | null;
  vendor_zip: string | null;
}

interface Props {
  leaseId: string;
  initial: VendorFields;
  /** Called after a successful save so the parent can re-sync. */
  onSaved?: (next: VendorFields) => void;
  /** Vault read-only: suppress the edit-enable affordance. Default false. */
  readOnly?: boolean;
}

const EMPTY: VendorFields = {
  vendor_name: null,
  vendor_phone: null,
  vendor_address_line1: null,
  vendor_address_line2: null,
  vendor_city: null,
  vendor_state: null,
  vendor_zip: null,
};

export function VendorCard({ leaseId, initial, onSaved, readOnly = false }: Props) {
  const { t } = useAppTranslation();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<VendorFields>({ ...EMPTY, ...initial });

  useEffect(() => {
    setDraft({ ...EMPTY, ...initial });
  }, [initial]);

  const cancel = () => {
    setDraft({ ...EMPTY, ...initial });
    setEditing(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await (supabase as any)
        .from('leases')
        .update({
          vendor_name: draft.vendor_name?.trim() || null,
          vendor_phone: draft.vendor_phone?.trim() || null,
          vendor_address_line1: draft.vendor_address_line1?.trim() || null,
          vendor_address_line2: draft.vendor_address_line2?.trim() || null,
          vendor_city: draft.vendor_city?.trim() || null,
          vendor_state: draft.vendor_state?.trim() || null,
          vendor_zip: draft.vendor_zip?.trim() || null,
        })
        .eq('id', leaseId);
      if (error) throw error;
      toast.success(t('locked_lease.vendor.saved'));
      onSaved?.(draft);
      setEditing(false);
    } catch (err: any) {
      console.error('Vendor update error:', err);
      toast.error(err?.message ?? t('locked_lease.vendor.save_failed'));
    } finally {
      setSaving(false);
    }
  };

  const headerAction = editing ? (
    <div className="flex gap-1">
      <Button variant="outline" size="sm" onClick={cancel} disabled={saving}>
        <X className="h-3.5 w-3.5 mr-1" />
        {t('common.cancel')}
      </Button>
      <Button variant="accent" size="sm" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
        {t('common.save')}
      </Button>
    </div>
  ) : readOnly ? null : (
    <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
      <Pencil className="h-3.5 w-3.5 mr-1" />
      {t('common.edit')}
    </Button>
  );

  if (!editing) {
    const street = [initial.vendor_address_line1, initial.vendor_address_line2].filter(Boolean).join(', ');
    const cityLine = [initial.vendor_city, initial.vendor_state, initial.vendor_zip].filter(Boolean).join(' ');
    return (
      <SectionCard title={t('locked_lease.vendor.title')} action={headerAction}>
        <LabelValueGrid
          rows={[
            { label: t('locked_lease.vendor.name'), value: initial.vendor_name },
            { label: t('locked_lease.vendor.phone'), value: initial.vendor_phone },
            { label: t('locked_lease.vendor.street'), value: street, fullWidth: true },
            { label: t('locked_lease.vendor.city_state_zip'), value: cityLine, fullWidth: true },
          ]}
          emptyHint={t('locked_lease.vendor.empty_hint')}
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard title={t('locked_lease.vendor.title')} action={headerAction}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label={t('locked_lease.vendor.name')} value={draft.vendor_name} onChange={(v) => setDraft((d) => ({ ...d, vendor_name: v }))} />
        <Field label={t('locked_lease.vendor.phone')} value={draft.vendor_phone} onChange={(v) => setDraft((d) => ({ ...d, vendor_phone: v }))} />
        <Field label={t('locked_lease.vendor.address_line1')} value={draft.vendor_address_line1} onChange={(v) => setDraft((d) => ({ ...d, vendor_address_line1: v }))} fullWidth />
        <Field label={t('locked_lease.vendor.address_line2')} value={draft.vendor_address_line2} onChange={(v) => setDraft((d) => ({ ...d, vendor_address_line2: v }))} fullWidth />
        <Field label={t('locked_lease.vendor.city')} value={draft.vendor_city} onChange={(v) => setDraft((d) => ({ ...d, vendor_city: v }))} />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('locked_lease.vendor.state')} value={draft.vendor_state} onChange={(v) => setDraft((d) => ({ ...d, vendor_state: v }))} />
          <Field label={t('locked_lease.vendor.zip')} value={draft.vendor_zip} onChange={(v) => setDraft((d) => ({ ...d, vendor_zip: v }))} />
        </div>
      </div>
    </SectionCard>
  );
}

function Field({
  label,
  value,
  onChange,
  fullWidth,
}: {
  label: string;
  value: string | null;
  onChange: (next: string) => void;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? 'md:col-span-2' : undefined}>
      <Label className="text-xs uppercase tracking-wide text-foreground">{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1"
      />
    </div>
  );
}
