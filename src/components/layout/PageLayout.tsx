import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared page-body container (Cluster C — layout system).
 *
 * Standardizes the content column that an app page renders BELOW the full-width
 * sticky {@link AppHeader}. Historically each page hand-rolled its own wrapper —
 * Dashboard/Leases/Portfolio/Reports went edge-to-edge `p-6`, ApprovalQueue
 * centered at `max-w-3xl`, and the seven firm pages each picked a different
 * `max-w-*` with no horizontal padding — so the content column jumped width as
 * you walked the nav. This collapses that into one container with a small set of
 * intentional width variants.
 *
 * Adoption is incremental: the `/app/firm/*` pages are the first adopters; the
 * remaining content pages migrate onto this primitive page-by-page.
 *
 * Render it as a SIBLING after AppHeader, not around it — AppHeader is a
 * full-width sticky ribbon aligned to the sidebar edge and must stay outside
 * the max-width container:
 *
 *   <>
 *     <AppHeader title="…" actions={…} />
 *     <PageLayout>…body…</PageLayout>
 *   </>
 */
type PageWidth = 'narrow' | 'default' | 'wide' | 'full';

const WIDTH_CLASS: Record<PageWidth, string> = {
  // Focused single-column flows — approval queue, onboarding, small forms.
  narrow: 'max-w-3xl',
  // Standard content / list pages (most firm pages, settings).
  default: 'max-w-5xl',
  // Dashboards, multi-column card grids, and table-heavy pages (Leases,
  // Portfolio, Reports). Bounded so content doesn't stretch to ~2000px on a
  // 27" monitor, the one thing every page was missing before this.
  wide: 'max-w-7xl',
  // Opt out of the max-width entirely (e.g. a full-bleed split-pane workbench).
  full: 'max-w-none',
};

interface PageLayoutProps {
  children: ReactNode;
  /** Content-column width cap. Defaults to `'default'` (max-w-5xl). */
  width?: PageWidth;
  /**
   * Override the default vertical rhythm (`space-y-6`). Pass an empty string to
   * remove it when a page manages its own internal spacing.
   */
  spacing?: string;
  /** Extra classes merged onto the container. */
  className?: string;
}

export function PageLayout({
  children,
  width = 'default',
  spacing = 'space-y-6',
  className,
}: PageLayoutProps) {
  return (
    <div className={cn('mx-auto px-4 py-6 sm:px-6', WIDTH_CLASS[width], spacing, className)}>
      {children}
    </div>
  );
}
