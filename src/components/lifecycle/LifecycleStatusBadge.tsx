import type { LifecycleStatus } from '@/types/lifecycle';
import { LeaseStatusBadge } from '@/components/leases/LeaseStatusBadge';

interface LifecycleStatusBadgeProps {
  status: LifecycleStatus;
  className?: string;
  size?: 'sm' | 'default';
}

// Thin, type-narrowed wrapper over the canonical LeaseStatusBadge (soft
// appearance). Retained as the lifecycle-specific entry point so call sites
// stay self-documenting and get LifecycleStatus type-checking; the rendering,
// styling, and labels all live in LeaseStatusBadge now (single source of truth).
export function LifecycleStatusBadge({
  status,
  className,
  size = 'default',
}: LifecycleStatusBadgeProps) {
  return (
    <LeaseStatusBadge
      status={status}
      appearance="soft"
      size={size}
      className={className}
    />
  );
}
