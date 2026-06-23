import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { AppProvider } from "@/contexts/AppContext";
import { FirmProvider } from "@/contexts/FirmContext";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";

// ─── Eager-loaded routes (kept in the main bundle for fast first paint) ────
// Marketing + auth + legal — visited on cold loads, optimised for fast first
// paint. Everything else below is React.lazy()-split into per-chunk JS.
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import NotFound from "./pages/NotFound";

// ─── Lazy-loaded routes (split into per-chunk JS, fetched on demand) ──────
// Audit 2026-05-07 found the prod bundle was 4.05 MB / 1.19 MB gzipped in a
// single chunk — every customer paid for the full app surface (PDF lib +
// charts + every page) on first paint. React.lazy splits each route into its
// own chunk; React.Suspense renders the fallback while the chunk loads.

// Public-but-rare
const LeaseAudit = lazy(() => import("./pages/LeaseAudit"));
const PublicSummaryPage = lazy(() => import("./pages/PublicSummaryPage"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite"));

// App workbench (post-login)
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Leases = lazy(() => import("./pages/Leases"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Reports = lazy(() => import("./pages/Reports"));
const Onboarding = lazy(() => import("./pages/app/Onboarding"));
const LeaseReview = lazy(() => import("./pages/app/LeaseReview"));
const LeaseReportDetail = lazy(() => import("./pages/app/LeaseReportDetail"));
const PortfolioReportsAdmin = lazy(() => import("./pages/app/PortfolioReportsAdmin"));
const DisclosureReportLibrary = lazy(() => import("./pages/app/DisclosureReportLibrary"));
const SignatorReview = lazy(() => import("./pages/app/SignatorReview"));
const RerouteAuditDashboard = lazy(() => import("./pages/app/RerouteAuditDashboard"));
const OperationsPage = lazy(() => import("./pages/app/OperationsPage"));
const ExceptionsDashboard = lazy(() => import("./pages/app/ExceptionsDashboard"));
const Portfolio = lazy(() => import("./pages/app/Portfolio"));
const ApprovalQueue = lazy(() => import("./pages/app/ApprovalQueue"));
const FinancialReview = lazy(() => import("./pages/app/FinancialReview"));
const ImportHistory = lazy(() => import("./pages/app/ImportHistory"));
const ExtractionAnalytics = lazy(() => import("./pages/app/ExtractionAnalytics"));
const AuditLog = lazy(() => import("./pages/app/AuditLog"));
const Support = lazy(() => import("./pages/app/Support"));
const NeedsActionPage = lazy(() => import("./pages/app/NeedsActionPage"));
const NotificationDetail = lazy(() => import("./pages/app/NotificationDetail"));

// Settings + account
const FirmDashboard = lazy(() => import("./pages/app/firm/FirmDashboard"));
const FirmInbox = lazy(() => import("./pages/app/firm/FirmInbox"));
const FirmMembers = lazy(() => import("./pages/app/firm/FirmMembers"));
const FirmWorkspaces = lazy(() => import("./pages/app/firm/FirmWorkspaces"));
const FirmSettings = lazy(() => import("./pages/app/firm/FirmSettings"));
const FirmBilling = lazy(() => import("./pages/app/firm/FirmBilling"));
const FirmOnboarding = lazy(() => import("./pages/app/firm/FirmOnboarding"));
const AcceptFirmInvitation = lazy(() => import("./pages/AcceptFirmInvitation"));
const AccountSettings = lazy(() => import("./pages/settings/AccountSettings"));
const WorkspacesSection = lazy(() => import("./pages/settings/WorkspacesSection"));
const ApprovalPoliciesListPage = lazy(() => import("./pages/settings/ApprovalPoliciesListPage"));
const ApprovalPolicyEditPage = lazy(() => import("./pages/settings/ApprovalPolicyEditPage"));

import { RequireRole } from "@/components/auth/RequireRole";
import {
  canAccessReportsAuditLog,
  canAccessReportsDataQuality,
  canEditWorkspaceSettings,
} from "@/lib/authorization";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <AuthProvider>
        <AppProvider>
          <FirmProvider>
          <LanguageProvider>
            <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <Suspense
                fallback={
                  <div
                    style={{
                      minHeight: "100vh",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "#6b7280",
                      fontFamily:
                        '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                      fontSize: "0.875rem",
                    }}
                  >
                    Loading…
                  </div>
                }
              >
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
                <Route path="/firm/accept-invitation" element={<AcceptFirmInvitation />} />

                {/* Phase 10 — firm context (firm members only; pages self-guard) */}
                <Route path="/app/firm" element={<ProtectedRoute><FirmDashboard /></ProtectedRoute>} />
                <Route path="/app/firm/inbox" element={<ProtectedRoute><FirmInbox /></ProtectedRoute>} />
                <Route path="/app/firm/members" element={<ProtectedRoute><FirmMembers /></ProtectedRoute>} />
                <Route path="/app/firm/workspaces" element={<ProtectedRoute><FirmWorkspaces /></ProtectedRoute>} />
                <Route path="/app/firm/billing" element={<ProtectedRoute><FirmBilling /></ProtectedRoute>} />
                <Route path="/app/firm/settings" element={<ProtectedRoute><FirmSettings /></ProtectedRoute>} />
                <Route path="/app/firm/onboarding" element={<ProtectedRoute><FirmOnboarding /></ProtectedRoute>} />

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
                {/* Legacy /app/leases/new (NewLease + useLifecycleWorkflow) retired
                    2026-06-23 (Cluster A #5): its transitions did browser lifecycle
                    writes the governance trigger rejects, and it bypassed approval-
                    chain resolution. Redirect to the leases list. */}
                <Route path="/app/leases/new" element={<Navigate to="/app/leases" replace />} />
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
                {/* Financial-impact review — URL/chain-state only (no nav entry):
                    reached from the approval flow when a request needs a finance
                    sign-off step. Intentionally not in the sidebar (C5). */}
                <Route
                  path="/app/leases/:leaseId/financial-review"
                  element={
                    <ProtectedRoute>
                      <FinancialReview />
                    </ProtectedRoute>
                  }
                />
                {/* Phase 8 — single-lease disclosure report detail */}
                <Route
                  path="/app/leases/:leaseId/reports/:reportId"
                  element={
                    <ProtectedRoute>
                      <LeaseReportDetail />
                    </ProtectedRoute>
                  }
                />
                {/* Phase 5 — signator review (intentional friction page) */}
                <Route
                  path="/app/leases/:leaseId/signator-review"
                  element={
                    <ProtectedRoute>
                      <SignatorReview />
                    </ProtectedRoute>
                  }
                />
                {/* Phase 6 — admin reroute audit dashboard. Gated to
                    admin/owner: surfaces governance findings (would-be
                    reroutes the auto-trigger missed) that require
                    administrative judgment to act on. */}
                <Route
                  path="/app/admin/reroute-audit"
                  element={
                    <ProtectedRoute>
                      <RequireRole allow={canEditWorkspaceSettings}>
                        <RerouteAuditDashboard />
                      </RequireRole>
                    </ProtectedRoute>
                  }
                />
                {/* Phase 8 — admin portfolio reports page. Generates
                    workspace-scoped portfolio-period disclosure reports. */}
                <Route
                  path="/app/admin/reports"
                  element={
                    <ProtectedRoute>
                      <RequireRole allow={canEditWorkspaceSettings}>
                        <PortfolioReportsAdmin />
                      </RequireRole>
                    </ProtectedRoute>
                  }
                />
                {/* Phase 8 — disclosure report library (single + portfolio) */}
                <Route
                  path="/app/reports/disclosure"
                  element={
                    <ProtectedRoute>
                      <DisclosureReportLibrary />
                    </ProtectedRoute>
                  }
                />
                {/* Phase 7 — admin exceptions dashboard. Stuck chains,
                    deactivated approvers, recent overrides, active OOO. */}
                <Route
                  path="/app/admin/exceptions"
                  element={
                    <ProtectedRoute>
                      <RequireRole allow={canEditWorkspaceSettings}>
                        <ExceptionsDashboard />
                      </RequireRole>
                    </ProtectedRoute>
                  }
                />
                {/* Operational Monitoring Phase 2 — vendor health,
                    upcoming renewals, recent alerts. RLS-gated to ops
                    admins via is_ops_admin helper (LeaseIO HQ
                    workspace owner/admin only at v1). */}
                <Route
                  path="/app/admin/operations"
                  element={
                    <ProtectedRoute>
                      <OperationsPage />
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
                {/* Workspaces drill-down — second-level settings rail with
                    back arrow. Role gating happens per-section inside the
                    page (every member can at least see My Workspaces). */}
                <Route
                  path="/app/settings/workspaces"
                  element={
                    <ProtectedRoute>
                      <WorkspacesSection />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/settings/workspaces/:section"
                  element={
                    <ProtectedRoute>
                      <WorkspacesSection />
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/settings/approval-policies"
                  element={
                    <ProtectedRoute>
                      <RequireRole allow={canEditWorkspaceSettings}>
                        <ApprovalPoliciesListPage />
                      </RequireRole>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/app/settings/approval-policies/:id"
                  element={
                    <ProtectedRoute>
                      <RequireRole allow={canEditWorkspaceSettings}>
                        <ApprovalPolicyEditPage />
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
                <Route path="/app/settings/billing" element={<Navigate to="/app/settings/account?tab=billing" replace />} />
                {/* 2026-06 Claude-alignment pass — old settings satellites
                    fold into the two-surface settings architecture. */}
                <Route path="/app/settings/workspace" element={<Navigate to="/app/settings/workspaces/profile" replace />} />
                <Route path="/app/account/workspaces" element={<Navigate to="/app/settings/workspaces" replace />} />
                <Route path="/app/upgrade" element={<Navigate to="/app/settings/account?tab=billing" replace />} />
                <Route path="/app/usage" element={<Navigate to="/app/settings/account?tab=usage" replace />} />

                {/* 404 */}
                <Route path="*" element={<NotFound />} />
              </Routes>
              </Suspense>
              </BrowserRouter>
            </TooltipProvider>
          </LanguageProvider>
          </FirmProvider>
        </AppProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
