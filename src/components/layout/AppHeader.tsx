import * as React from 'react';

interface AppHeaderProps {
  title: React.ReactNode;
  subtitle?: string | React.ReactNode;
  actions?: React.ReactNode;
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
export function AppHeader({ title, subtitle, actions }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6">
      <div className="flex-1 min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground truncate">{title}</h1>
        {subtitle && (
          <p className="text-sm text-muted-foreground truncate">{safeRender(subtitle)}</p>
        )}
      </div>

      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
