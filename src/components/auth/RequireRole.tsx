import { ReactNode, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '@/contexts/AppContext';
import { AppRole } from '@/lib/authorization';

interface RequireRoleProps {
  allow: (role: AppRole) => boolean;
  children: ReactNode;
  redirectTo?: string;
}

export function RequireRole({ allow, children, redirectTo = '/app/dashboard' }: RequireRoleProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { userRole, isLoading } = useApp();

  useEffect(() => {
    if (isLoading) return;
    if (!allow(userRole)) {
      // Wave 5: carry the denied path so the destination can EXPLAIN the
      // bounce — a silent redirect made shared admin links ("check the audit
      // log") look broken to non-admins. Dashboard renders the notice.
      navigate(redirectTo, { replace: true, state: { deniedPath: location.pathname } });
    }
  }, [allow, userRole, isLoading, navigate, redirectTo, location.pathname]);

  if (isLoading || !allow(userRole)) {
    return null;
  }

  return <>{children}</>;
}
