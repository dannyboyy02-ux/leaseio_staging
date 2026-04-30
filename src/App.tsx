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
import LeaseAudit from "./pages/LeaseAudit";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import PublicSummaryPage from "./pages/PublicSummaryPage";

// Auth pages
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import AcceptInvite from "./pages/AcceptInvite";

// App pages (protected)
import Onboarding from "./pages/app/Onboarding";
import LeaseReview from "./pages/app/LeaseReview";
import Portfolio from "./pages/app/Portfolio";
import ApprovalQueue from "./pages/app/ApprovalQueue";
import FinancialReview from "./pages/app/FinancialReview";
import ImportHistory from "./pages/app/ImportHistory";
import Upgrade from "./pages/app/Upgrade";
import Usage from "./pages/app/Usage";
import NewLease from "./pages/app/NewLease";
import ExtractionAnalytics from "./pages/app/ExtractionAnalytics";
import AuditLog from "./pages/app/AuditLog";
import Support from "./pages/app/Support";
import NeedsActionPage from "./pages/app/NeedsActionPage";
import Dashboard from "./pages/Dashboard";
import Leases from "./pages/Leases";
import Notifications from "./pages/Notifications";
import NotificationDetail from "./pages/app/NotificationDetail";
import Reports from "./pages/Reports";
import WorkspaceSettings from "./pages/settings/WorkspaceSettings";
import AccountSettings from "./pages/settings/AccountSettings";
import NotFound from "./pages/NotFound";
import { RequireRole } from "@/components/auth/RequireRole";
import {
  canAccessReportsAuditLog,
  canAccessReportsDataQuality,
  canAccessWorkspaceSettings,
} from "@/lib/authorization";

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
                <Route
                  path="/lease-audit"
                  element={
                    <ProtectedRoute>
                      <LeaseAudit />
                    </ProtectedRoute>
                  }
                />
                <Route path="/privacy" element={<Privacy />} />
                <Route path="/terms" element={<Terms />} />

                {/* Public share route — no auth required */}
                <Route path="/share/:token" element={<PublicSummaryPage />} />

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
                {/* Primary lease workbench */}
                <Route
                  path="/app/leases/:leaseId"
                  element={
                    <ProtectedRoute>
                      <LeaseReview />
                    </ProtectedRoute>
                  }
                />
                {/* Legacy /review sub-route — preserved for compatibility */}
                <Route
                  path="/app/leases/:leaseId/review"
                  element={
                    <ProtectedRoute>
                      <LeaseReview />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/leases/:leaseId/financial-review"
                  element={
                    <ProtectedRoute>
                      <FinancialReview />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/portfolio"
                  element={
                    <ProtectedRoute>
                      <Portfolio />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/approvals"
                  element={
                    <ProtectedRoute>
                      <ApprovalQueue />
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
                      <RequireRole allow={canAccessWorkspaceSettings}>
                        <WorkspaceSettings />
                      </RequireRole>
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
                <Route
                  path="/app/usage"
                  element={
                    <ProtectedRoute>
                      <Usage />
                    </ProtectedRoute>
                  }
                />
                {/* Data Quality — blocked in production; dev-only internal tool */}
                <Route
                  path="/app/reports/data-quality"
                  element={
                    import.meta.env.DEV ? (
                      <ProtectedRoute>
                        <RequireRole allow={canAccessReportsDataQuality}>
                          <ExtractionAnalytics />
                        </RequireRole>
                      </ProtectedRoute>
                    ) : (
                      <Navigate to="/app/dashboard" replace />
                    )
                  }
                />
                <Route
                  path="/app/reports/audit-log"
                  element={
                    <ProtectedRoute>
                      <RequireRole allow={canAccessReportsAuditLog}>
                        <AuditLog />
                      </RequireRole>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/support"
                  element={
                    <ProtectedRoute>
                      <Support />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/needs-action"
                  element={
                    <ProtectedRoute>
                      <NeedsActionPage />
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
