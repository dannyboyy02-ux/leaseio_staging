import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useApp } from '@/contexts/AppContext';
import { Loader2 } from 'lucide-react';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();
  const { workspace, isLoading: appLoading } = useApp();
  const location = useLocation();

  if (isLoading || (user && appLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    // Redirect to login, preserving the intended destination
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (
    location.pathname.startsWith('/app') &&
    location.pathname !== '/app/onboarding' &&
    !workspace
  ) {
    return <Navigate to="/app/onboarding" replace />;
  }

  return <>{children}</>;
}
