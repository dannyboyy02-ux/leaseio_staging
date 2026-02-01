
# Complete Translation Coverage Plan

## Executive Summary

This plan will achieve 100% translation coverage by auditing every single page and component in the codebase, extracting all hardcoded English strings, and adding them to the translation system. After implementation, every piece of text visible to users (except PDF content from uploaded leases) will be translatable. The plan also establishes a pattern that ensures all future development automatically uses translations.

---

## Current State

### What's Already Translated
The following pages and components use the `t()` function correctly:
- Dashboard (mostly)
- Leases list page
- Notifications
- Reports
- Integrations
- Account Settings
- Workspace Settings
- Landing page sections
- Login and Forgot Password pages
- Import History (partially)
- Support page

### What Needs Translation
After auditing every file, here are all pages/components with hardcoded English strings:

---

## Part 1: Pages with Hardcoded Strings

### 1.1 Signup Page (`src/pages/Signup.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 28-33 | Timezone labels ("Eastern Time (ET)", etc.) | Keep as-is (technical) |
| 61 | "Missing field" | `auth.errors.missing_field` |
| 61 | "Please enter your first name." | `auth.errors.missing_first_name` |
| 65 | "Please enter your last name." | `auth.errors.missing_last_name` |
| 69 | "Please enter your email." | `auth.errors.missing_email` |
| 74 | "Invalid email" / "Please enter a valid email address." | `auth.errors.invalid_email` |
| 78 | "Weak password" / "Password must be at least 8 characters." | `auth.errors.weak_password` |
| 82 | "Password mismatch" / "Passwords do not match." | `auth.errors.password_mismatch` |
| 86 | "Terms required" / "Please accept the Terms and Privacy Policy." | `auth.errors.terms_required` |
| 108 | "An error occurred during sign up." | `auth.errors.signup_failed` |
| 110 | "An account with this email already exists. Please sign in." | `auth.errors.already_registered` |
| 114 | "Sign up failed" | `auth.errors.signup_failed` |
| 125 | "Account created!" / "Please check your email to confirm your account." | `auth.success.account_created` |
| 148 | "Create your account" | `auth.create_your_account` |
| 150 | "Start with the {plan} plan" | `auth.start_with_plan` |
| 157 | "First name" | `auth.first_name` |
| 167 | "Last name" | `auth.last_name` |
| 179 | "Work email" | `auth.work_email` |
| 192 | "Company name" | `auth.company_name` |
| 203 | "Time zone" | `auth.timezone` |
| 206 | "Select timezone" | `auth.select_timezone` |
| 219 | "Password" | `auth.password` |
| 229 | "Minimum 8 characters" | `auth.min_password` |
| 234 | "Confirm password" | `auth.confirm_password` |
| 253-256 | Terms agreement text | `auth.agree_terms`, etc. |
| 264 | "Creating account..." | `auth.creating_account` |
| 267 | "Create account" | `auth.create_account` |
| 274 | "Already have an account?" | `auth.have_account` |
| 276 | "Sign in" | `auth.sign_in` |

### 1.2 New Lease Page (`src/pages/app/NewLease.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 95 | "Business Plan Required" | `new_lease.business_required` |
| 97-98 | Description text | `new_lease.business_required_desc` |
| 101 | "Upgrade to Business" | `new_lease.upgrade_business` |
| 111 | "New Lease" | `new_lease.title` |
| 112 | "Capture lease intent early" | `new_lease.subtitle` |
| 115 | "Back" | `common.back` |
| 126 | "Lease Category" | `new_lease.lease_category` |
| 127 | "Is this a new lease or an amendment?" | `new_lease.lease_category_desc` |
| 143 | "New Lease" (button) | `new_lease.new_lease` |
| 153 | "Amendment" | `new_lease.amendment` |
| 166 | "Parent Lease" | `new_lease.parent_lease` |
| 167 | "Select the original lease being amended" | `new_lease.parent_lease_desc` |
| 181 | "Lease Type" | `new_lease.lease_type` |
| 182 | "What type of asset is being leased?" | `new_lease.lease_type_desc` |
| 196 | "Real Estate" | `new_lease.real_estate` |
| 206 | "Equipment" | `new_lease.equipment` |
| 217 | "Asset Category" | `new_lease.asset_category` |
| 218 | "More specific categorization for reporting" | `new_lease.asset_category_desc` |
| 252 | "Business Unit / Location" | `new_lease.business_unit` |
| 253 | "Which team or location will use this lease?" | `new_lease.business_unit_desc` |
| 257 | Placeholder text | `new_lease.business_unit_placeholder` |
| 268 | "Estimated Lease Term" | `new_lease.estimated_term` |
| 269 | "How long do you expect this lease to run? (in months)" | `new_lease.estimated_term_desc` |
| 274 | "Minimum" / "Maximum" | `common.minimum` / `common.maximum` |
| 285 | "to" | `common.to` |
| 297 | "months" | `common.months` |
| 305 | "Estimated Monthly Cost" | `new_lease.estimated_cost` |
| 306 | "Optional: What's the expected monthly payment range?" | `new_lease.estimated_cost_desc` |
| 348 | "Notes" | `new_lease.notes` |
| 349 | "Optional: Any additional context or requirements" | `new_lease.notes_desc` |
| 354 | Placeholder text | `new_lease.notes_placeholder` |
| 369 | "Cancel" | `common.cancel` |
| 379 | "Creating..." | `common.creating` |
| 382 | "Save Draft" | `new_lease.save_draft` |

### 1.3 Lease Review Page (`src/pages/app/LeaseReview.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 87-89 | "N/A" | `common.na` |
| 97-99 | Confidence percentages (keep dynamic) | N/A |
| 123 | "Landlord" | `lease.landlord` |
| 124 | "Tenant" | `lease.tenant` |
| 125 | "Premises Address" | `lease.property_address` |
| 126-127 | "Lease Start" / "Lease End" | `lease.commencement_date` / `lease.expiration_date` |
| 128 | "Monthly Rent" | `lease.monthly_rent` |
| 129 | "Escalation Type" | `lease.escalation_type` |
| 357 | "Lease records updated successfully" | `lease.save_success` |
| 359 | "Update failed" | `lease.save_error` |
| 385-387 | "Lease posted successfully..." | `lease.post_success` |
| 394 | "Failed to post lease" | `lease.post_error` |
| 366 | "Please review all highlighted fields before posting" | `lease.review_warning` |
| 401 | "Initializing Cockpit..." | `lease.initializing` |
| 408 | "Abstraction Cockpit" | `lease.cockpit_title` |
| 426 | "Save Draft" | `lease.save_draft` |
| 449 | "Source Document" | `lease.source_document` |
| 459 | "Document stream unavailable" | `lease.document_unavailable` |
| 483 | "Review & Verification Panel" | `lease.review_panel` |

### 1.4 Extraction Analytics / Data Quality Page (`src/pages/app/ExtractionAnalytics.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 78 | "N/A" | `common.na` |
| 214 | "Extraction Analytics" | `analytics.title` |
| 215 | "Monitor AI extraction quality and user corrections" | `analytics.subtitle` |
| 219 | "Back" | `common.back` |
| 228 | "Refresh" | `common.refresh` |
| 240 | "Total Leases Processed" | `analytics.total_processed` |
| 250 | "Avg Confidence Score" | `analytics.avg_confidence` |
| 261 | "Excellent" / "Good" / "Needs Improvement" | `analytics.excellent` / `analytics.good` / `analytics.needs_improvement` |
| 268 | "Total Corrections" | `analytics.total_corrections` |
| 275 | "User-made edits" | `analytics.user_edits` |
| 279 | "Most Corrected Field" | `analytics.most_corrected` |
| 287 | "Focus area for AI improvement" | `analytics.focus_area` |
| 296 | "Corrections by Field" | `analytics.corrections_by_field` |
| 298 | Description text | `analytics.corrections_desc` |
| 327 | "No corrections recorded yet" | `analytics.no_corrections` |
| 335 | "Confidence Distribution" | `analytics.confidence_distribution` |
| 336 | Description text | `analytics.confidence_desc` |
| 364 | "No confidence data recorded yet" | `analytics.no_confidence_data` |
| 375 | "Recent Corrections" | `analytics.recent_corrections` |
| 376 | Description text | `analytics.recent_desc` |
| 384 | "Date" / "Field" / "Original Value" / "Corrected Value" | `analytics.date` / `analytics.field` / `analytics.original` / `analytics.corrected` |
| 400 | "(empty)" / "(cleared)" | `analytics.empty` / `analytics.cleared` |
| 415 | "No corrections recorded yet" | `analytics.no_corrections` |

### 1.5 Audit Log Page (`src/pages/app/AuditLog.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 148 | "Audit Log" | `audit.title` |
| 149 | "Track all lease state transitions and changes" | `audit.subtitle` |
| 151 | "Export CSV" | `audit.export_csv` |
| 163 | "Filters" | `audit.filters` |
| 169 | "Lease ID" | `audit.lease_id` |
| 170 | "Filter by Lease ID..." | `audit.filter_placeholder` |
| 180 | "Status" | `audit.status` |
| 190 | "All statuses" | `audit.all_statuses` |
| 191-200 | Status options | Use existing `lease.*` keys |
| 215 | "Timestamp" | `audit.timestamp` |
| 216 | "Lease" | `audit.lease` |
| 217 | "Transition" | `audit.transition` |
| 218 | "Reason" | `audit.reason` |
| 224 | "Loading..." | `common.loading` |
| 229 | "No state transitions found" | `audit.no_transitions` |
| 252 | "Unknown" | `common.unknown` |
| 300 | "Showing X - Y of Z" | `audit.showing` |
| 309 | "Previous" | `common.previous` |
| 317 | "Next" | `common.next` |

### 1.6 Upgrade Page (`src/pages/app/Upgrade.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 41-43 | Toast messages | `upgrade.toast_upgrade` / `upgrade.toast_contact` |
| 52 | "Upgrade Your Plan" | `upgrade.title` |
| 53 | "Unlock more features and scale your lease management" | `upgrade.subtitle` |
| 57 | "Back to Dashboard" | `upgrade.back_to_dashboard` |
| 81 | "Monthly" | `pricing.monthly` |
| 95 | "Annual" | `pricing.annual` |
| 98 | "Save X%" | `pricing.save` |
| 129 | "Most Popular" | `pricing.most_popular` |
| 135 | "Current" | `pricing.current` |
| 141 | "Free" | `pricing.free` |
| 171 | "Current Plan" | `pricing.current_plan` |
| 175 | "Upgrade to X" | `pricing.upgrade_to` |
| 179 | "Downgrade to X" | `pricing.downgrade_to` |
| 184 | "Free Tier" | `pricing.free_tier` |
| 188 | "Select Plan" | `pricing.select_plan` |
| 200 | "Frequently Asked Questions" | `upgrade.faq_title` |
| 204-218 | FAQ content | `upgrade.faq1_q` / `upgrade.faq1_a`, etc. |

### 1.7 Privacy Policy Page (`src/pages/Privacy.tsx`)
All content is hardcoded English legal text. These should be translated:
- Page title, all section headings, all paragraph content

### 1.8 Terms of Service Page (`src/pages/Terms.tsx`)
All content is hardcoded English legal text. These should be translated:
- Page title, all section headings, all paragraph content

### 1.9 Reset Password Page (`src/pages/ResetPassword.tsx`)
Keys already exist in locale files - just need to import `useAppTranslation` and use `t()`.

### 1.10 Accept Invite Page (`src/pages/AcceptInvite.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 16 | "Preparing invitation..." | `invite.preparing` |
| All status messages | Various | `invite.*` keys |

---

## Part 2: Components with Hardcoded Strings

### 2.1 Lease List Confidence Badges (`src/pages/Leases.tsx`)
| Line | Hardcoded String | Translation Key |
|------|------------------|-----------------|
| 56 | "Pending" | `lease.pending` |
| 64 | "High Confidence" | `lease.high_confidence` |
| 72 | "Review Needed" | `lease.review_needed` |
| 79 | "Verify Carefully" | `lease.verify_carefully` |
| 130 | "Failed to load leases" | `leases.load_error` |
| 155 | "Lease deleted successfully" | `leases.delete_success` |
| 162 | "Failed to delete lease" | `leases.delete_error` |
| 405 | "Confidence" | `leases.confidence` |

### 2.2 Quick Stats Component (`src/components/dashboard/QuickStats.tsx`)
Audit for any hardcoded strings.

### 2.3 Upcoming Events Component (`src/components/dashboard/UpcomingEvents.tsx`)
Audit for any hardcoded strings.

### 2.4 Pending Approvals Section (`src/components/dashboard/PendingApprovalsSection.tsx`)
Audit for any hardcoded strings.

### 2.5 Workflow Components
- `CreateLeaseDrawer.tsx`
- `ApprovalDialog.tsx`
- `RejectedLeaseCallout.tsx`
- `NudgeApproverButton.tsx`
- `WorkflowStatusBadge.tsx`

### 2.6 Lease Components
- `LeaseCard.tsx`
- `ReviewCard.tsx`
- `RentScheduleTable.tsx`
- `NotificationConfigurator.tsx`
- `LeaseUploadModal.tsx`

---

## Part 3: Implementation Approach

### Step 1: Add All Missing Keys to Locale Files
Update `public/locales/en/common.json` and `public/locales/es/common.json` with all new translation keys organized by namespace.

### Step 2: Update Pages (in order of complexity)
1. **Signup.tsx** - Import `useAppTranslation`, replace all hardcoded strings
2. **NewLease.tsx** - Import `useAppTranslation`, replace all strings
3. **LeaseReview.tsx** - Major update, many strings
4. **ExtractionAnalytics.tsx** - Rename to DataQuality, translate all
5. **AuditLog.tsx** - Translate all
6. **Upgrade.tsx** - Translate all
7. **Privacy.tsx** - Full legal content translation
8. **Terms.tsx** - Full legal content translation
9. **ResetPassword.tsx** - Add `t()` calls
10. **AcceptInvite.tsx** - Translate status messages

### Step 3: Update Components
Update all components listed in Part 2 with `t()` calls.

### Step 4: Confidence Badge Components
Create a shared `getConfidenceLabel(score, t)` utility that returns translated confidence labels.

---

## Part 4: Ensuring Future Translation Coverage

### 4.1 Create a Translation Linting Rule
Add ESLint rule or custom script to detect hardcoded strings in JSX.

### 4.2 Developer Documentation
Create a `TRANSLATION.md` file documenting:
- How to add new translation keys
- Naming conventions (`namespace.key_name`)
- How to test translations

### 4.3 Translation Key Structure
```text
namespace:
  - nav.*           → Navigation items
  - dashboard.*     → Dashboard page
  - leases.*        → Leases list page
  - lease.*         → Single lease (review page)
  - new_lease.*     → New lease creation
  - analytics.*     → Data quality/analytics
  - audit.*         → Audit log
  - upgrade.*       → Upgrade page
  - auth.*          → Authentication (login, signup, etc.)
  - common.*        → Shared strings (Cancel, Save, etc.)
  - form.*          → Form validation messages
  - legal.*         → Privacy & Terms content
  - invite.*        → Invitation flow
```

---

## Part 5: Estimated New Translation Keys

| Namespace | Approximate New Keys |
|-----------|---------------------|
| `auth.*` | ~25 |
| `new_lease.*` | ~20 |
| `lease.*` | ~15 |
| `analytics.*` | ~20 |
| `audit.*` | ~15 |
| `upgrade.*` | ~15 |
| `legal.*` | ~50 (Privacy + Terms) |
| `invite.*` | ~10 |
| `common.*` | ~10 |
| **Total** | **~180 new keys** |

---

## Part 6: What Will NOT Be Translated

1. **PDF content** from uploaded lease documents (user data)
2. **Technical identifiers** (UUIDs, file paths)
3. **Timezone labels** (standardized technical names)
4. **Brand names** (LeaseIO, QuickBooks, etc.)
5. **Email addresses** (support@leaseio.app)
6. **Dynamically extracted lease data** (landlord names, property addresses)

---

## Technical Notes

- All pages will import either `useLanguage` from `@/contexts/LanguageContext` or `useAppTranslation` from `@/hooks/useAppTranslation`
- Date formatting will use the existing `src/lib/i18n.ts` utilities with locale awareness
- Currency formatting will use `Intl.NumberFormat` with appropriate locale

This plan ensures complete translation coverage in a single implementation pass.
