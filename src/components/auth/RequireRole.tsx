import { ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '@/contexts/AppContext';
import { AppRole } from '@/lib/authorization';

interface RequireRoleProps {
  allow: (role: AppRole) => boolean;
  children: ReactNode;
  redirectTo?: string;
}

export function RequireRole({ allow, children, redirectTo = '/app/dashboard' }: RequireRoleProps) {
  const navigate = useNavigate();
  const { userRole, isLoading } = useApp();

  useEffect(() => {
    if (isLoading) return;
    if (!allow(userRole)) {
      navigate(redirectTo, { replace: true });
    }
  }, [allow, userRole, isLoading, navigate, redirectTo]);

  if (isLoading || !allow(userRole)) {
    return null;
  }

  return <>{children}</>;
}
