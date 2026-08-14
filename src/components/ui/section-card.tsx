import { type ComponentType, type ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// SectionCard — the one dashboard section-card header (FS-8).
//
// The six Dashboard cards each hand-rolled the same shadcn Card + CardHeader +
// CardTitle header with small drifts: header padding (pb-3 vs the default pb-6),
// title size (five were text-sm font-medium, UpcomingEvents was text-base), and
// the icon+title / justify-between action layout copied five ways. This wraps
// that boilerplate once, canonically: pb-3 header, text-sm font-medium title,
// h-4/w-4 icon (size fixed so it can't drift; color inherits unless overridden),
// and an optional right-aligned `action` slot (the "All activity" / "Full
// pipeline" links, the department toggle).
//
// It builds ON shadcn Card — it is not a competing card primitive. Denser
// bespoke cards (Portfolio's equal-height grid) and standard shadcn CardHeader
// pages (Reports, WorkspaceSettings) intentionally stay as they are.

export interface SectionCardProps {
  title: ReactNode;
  /** Leading icon; rendered at a fixed h-4/w-4 so the size can't drift. */
  icon?: ComponentType<{ className?: string }>;
  /** Icon color override (size stays fixed) — e.g. a themed `text-amber-500`. */
  iconClassName?: string;
  /** Right-aligned header slot: a "view all" link, a toggle, a badge. */
  action?: ReactNode;
  children: ReactNode;
  /** Merged onto the Card (e.g. `border-amber-200`, `h-full`). */
  className?: string;
  /** Merged onto the CardContent. */
  contentClassName?: string;
}

export function SectionCard({
  title,
  icon: Icon,
  iconClassName,
  action,
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} />}
          <span className="flex-1 truncate">{title}</span>
          {action}
        </CardTitle>
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
