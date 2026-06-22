import { type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";

// Shared header chrome for the /app/firm/* pages (audit D6). Every firm page
// hand-rolled the same icon + title block; FirmDashboard is the superset
// (icon + title + role badge + subtitle + right-side action), so this component
// generalizes that shape. Pages without a subtitle/badge/actions simply omit
// those props and the layout collapses to the left-aligned title row.
interface FirmPageHeaderProps {
  /** The lucide icon component (rendered at the shared h-5 w-5 text-primary size). */
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  /** Optional inline element after the title (e.g. the firm-role badge). */
  badge?: ReactNode;
  /** Optional right-aligned actions (e.g. the Inbox or Invite button). */
  actions?: ReactNode;
}

export function FirmPageHeader({ icon: Icon, title, subtitle, badge, actions }: FirmPageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-semibold">{title}</h1>
          {badge}
        </div>
        {subtitle ? <p className="text-sm text-muted-foreground mt-1">{subtitle}</p> : null}
      </div>
      {actions}
    </div>
  );
}
