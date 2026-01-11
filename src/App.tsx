import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { AppProvider } from "@/contexts/AppContext";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";

// Public pages
import Landing from "./pages/Landing";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";

// Auth pages
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import AcceptInvite from "./pages/AcceptInvite";

// App pages (protected)
import Onboarding from "./pages/app/Onboarding";
import LeaseReview from "./pages/app/LeaseReview";
import ImportHistory from "./pages/app/ImportHistory";
import Upgrade from "./pages/app/Upgrade";
import NewLease from "./pages/app/NewLease";
import ApprovalInbox from "./pages/app/ApprovalInbox";
import Dashboard from "./pages/Dashboard";
import Leases from "./pages/Leases";
import Notifications from "./pages/Notifications";
import NotificationDetail from "./pages/app/NotificationDetail";
import Integrations from "./pages/Integrations";
import Reports from "./pages/Reports";
import WorkspaceSettings from "./pages/settings/WorkspaceSettings";
import AccountSettings from "./pages/settings/AccountSettings";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <AppProvider>
        <LanguageProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Routes>
                {/* Public routes */}
                <Route path="/" element={<Landing />} />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="/terms" element={<Terms />} />

                {/* Auth routes */}
                <Route path="/login" element={<Login />} />
                <Route path="/signup" element={<Signup />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/accept-invite" element={<AcceptInvite />} />

                {/* Protected app routes */}
                <Route
                  path="/app/onboarding"
                  element={
                    <ProtectedRoute>
                      <Onboarding />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/dashboard"
                  element={
                    <ProtectedRoute>
                      <Dashboard />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/leases"
                  element={
                    <ProtectedRoute>
                      <Leases />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/leases/new"
                  element={
                    <ProtectedRoute>
                      <NewLease />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/leases/:leaseId"
                  element={
                    <ProtectedRoute>
                      <LeaseReview />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/approvals"
                  element={
                    <ProtectedRoute>
                      <ApprovalInbox />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/imports"
                  element={
                    <ProtectedRoute>
                      <ImportHistory />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/notifications"
                  element={
                    <ProtectedRoute>
                      <Notifications />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/notifications/:notificationId"
                  element={
                    <ProtectedRoute>
                      <NotificationDetail />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/integrations"
                  element={
                    <ProtectedRoute>
                      <Integrations />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/reports"
                  element={
                    <ProtectedRoute>
                      <Reports />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/settings/workspace"
                  element={
                    <ProtectedRoute>
                      <WorkspaceSettings />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/settings/account"
                  element={
                    <ProtectedRoute>
                      <AccountSettings />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/upgrade"
                  element={
                    <ProtectedRoute>
                      <Upgrade />
                    </ProtectedRoute>
                  }
                />

                {/* Legacy route redirects */}
                <Route path="/auth" element={<Navigate to="/login" replace />} />
                <Route path="/app/settings/billing" element={<Navigate to="/app/settings/account" replace />} />

                {/* 404 */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </LanguageProvider>
      </AppProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
