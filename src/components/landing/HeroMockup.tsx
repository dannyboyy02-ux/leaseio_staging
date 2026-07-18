import { Sparkles, FileText, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * Decorative illustration of the lease review workbench (#176).
 *
 * Purely static: aria-hidden, zero interactive/focusable elements (the approve
 * affordance is a styled span, never a button). Everything that is not the
 * extraction story is a wordless skeleton bar — no fake charts, no fake data
 * density. The confidence chips mirror the real ConfidenceBadge classes in
 * LeaseReviewSections.tsx class-for-class (do NOT import that module here —
 * it would pull workbench-weight imports into the landing bundle).
 */
export function HeroMockup() {
  const { t } = useLanguage();

  return (
    <div
      aria-hidden="true"
      className="w-full overflow-hidden rounded-lg border border-border bg-background text-left shadow-sm select-none"
    >
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/50 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-border" />
        <span className="h-2 w-2 rounded-full bg-border" />
        <span className="h-2 w-2 rounded-full bg-border" />
      </div>

      <div className="flex">
        {/* Sidebar — wordless skeleton, hidden on mobile */}
        <div className="hidden w-36 shrink-0 flex-col gap-3 border-r border-border bg-muted/30 p-3 sm:flex">
          <div className="flex items-center gap-2">
            <span className="h-5 w-5 rounded bg-primary" />
            <span className="h-2 w-14 rounded bg-muted-foreground/20" />
          </div>
          <div className="mt-2 space-y-2.5">
            <span className="block h-2 w-20 rounded bg-muted-foreground/15" />
            <div className="rounded-md bg-primary/10 px-2 py-1.5">
              <span className="block h-2 w-16 rounded bg-primary/40" />
            </div>
            <span className="block h-2 w-24 rounded bg-muted-foreground/15" />
            <span className="block h-2 w-16 rounded bg-muted-foreground/15" />
          </div>
        </div>

        {/* Main panel — the extraction story */}
        <div className="min-w-0 flex-1 space-y-3 p-4 sm:p-5">
          {/* Header row: document name + status chip */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm font-medium text-foreground">
                {t('landing.hero.mockup.doc_name')}
              </span>
            </div>
            <span className="shrink-0 rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600">
              {t('landing.hero.mockup.status')}
            </span>
          </div>

          {/* Extracted fields card */}
          <div className="divide-y divide-border rounded-md border border-border">
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 text-xs text-muted-foreground">
                {t('landing.hero.mockup.field_rent')}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs font-medium tabular-nums text-foreground">
                  {t('landing.hero.mockup.value_rent')}
                </span>
                <span className="inline-flex h-4 items-center rounded-full border border-green-400 bg-green-50 px-1.5 text-[9px] font-medium text-green-600">
                  <CheckCircle2 className="mr-0.5 h-2 w-2" />
                  {t('landing.hero.mockup.conf_rent')}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 text-xs text-muted-foreground">
                {t('landing.hero.mockup.field_commencement')}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs font-medium tabular-nums text-foreground">
                  {t('landing.hero.mockup.value_commencement')}
                </span>
                <span className="inline-flex h-4 items-center rounded-full border border-green-400 bg-green-50 px-1.5 text-[9px] font-medium text-green-600">
                  <CheckCircle2 className="mr-0.5 h-2 w-2" />
                  {t('landing.hero.mockup.conf_commencement')}
                </span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0 text-xs text-muted-foreground">
                {t('landing.hero.mockup.field_renewal')}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs font-medium tabular-nums text-foreground">
                  {t('landing.hero.mockup.value_renewal')}
                </span>
                <span className="inline-flex h-4 items-center rounded-full border border-amber-400 bg-amber-50 px-1.5 text-[9px] font-medium text-amber-600">
                  <AlertTriangle className="mr-0.5 h-2 w-2" />
                  {t('landing.hero.mockup.conf_renewal')}
                </span>
              </span>
            </div>
          </div>

          {/* Footer: extraction note + non-interactive approve affordance */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
              {t('landing.hero.mockup.extracted_note')}
            </span>
            <span className="inline-flex shrink-0 items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm">
              {t('landing.hero.mockup.approve')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
