import * as React from 'react';
import { type LucideIcon } from 'lucide-react';

interface AppHeaderProps {
  title: React.ReactNode;
  subtitle?: string | React.ReactNode;
  actions?: React.ReactNode;
  /**
   * Optional leading icon (rendered at h-5 w-5 text-primary), absorbed from the
   * retired FirmPageHeader so the firm pages share this one sticky header.
   */
  icon?: LucideIcon;
  /** Optional inline element after the title (e.g. a role/status badge). */
  badge?: React.ReactNode;
}

function safeRender(node: unknown): React.ReactNode {
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node === 'boolean') return node ? 'true' : 'false';
  if (Array.isArray(node)) return node.map(safeRender);
  if (typeof node === 'object' && '$$typeof' in node) return node as unknown as React.ReactNode;
  try { return JSON.stringify(node); } catch { return String(node); }
}

/**
 * Top ribbon — title + optional subtitle + caller-supplied actions slot.
 * Search bar, notifications bell, and language toggle were removed: search
 * is unused, the bell duplicated /app/notifications, and language now lives
 * in the bottom-left user menu (Claude pattern).
 */
export function AppHeader({ title, subtitle, actions, icon: Icon, badge }: AppHeaderProps) {
  // FS-1: sticky only at md+. On mobile the sticky slot belongs to the
  // off-canvas nav's top bar (AppLayout) — two stacked sticky bars would
  // collide and the later-in-DOM header would cover the hamburger. Here the
  // header scrolls with the content; the nav bar stays pinned.
  return (
    <header className="md:sticky md:top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 sm:px-6">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-primary" />}
          <h1 className="font-display text-xl font-semibold text-foreground truncate">{title}</h1>
          {badge && <span className="shrink-0">{badge}</span>}
        </div>
        {subtitle && (
          <p className="text-sm text-muted-foreground truncate">{safeRender(subtitle)}</p>
        )}
      </div>

      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
