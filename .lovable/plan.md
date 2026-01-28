
# Workspace Lifecycle Implementation Plan for LeaseIO

## Overview
This plan implements a complete lease workflow system with a simplified 6-stage status flow, Vaul drawer for creation, nudge/rejection logic, side-by-side AI review with confidence UI, and audit tracking.

## Architecture Flow

```text
+------------------+      +-------------------+      +------------------+
|   Initializer    |      |     Supabase      |      |    Approver      |
|   (Dashboard)    |      |                   |      |    (Inbox)       |
+--------+---------+      +---------+---------+      +--------+---------+
         |                          |                         |
   1. "Create New Lease"            |                         |
   Opens Vaul Drawer                |                         |
         |                          |                         |
   2. Fill form:                    |                         |
   - Toggle: Real Estate/Equipment  |                         |
   - Approver Email                 |                         |
   - Upload PDF (dropzone)          |                         |
         |                          |                         |
   3. Submit -----> INSERT lease    |                         |
         |          status: "Pending Approval"                |
         |                          |                         |
         |          Nudge Button    |                         |
         |          (60s cooldown)  |                         |
         +------------------------->|<------------------------+
                                    |  Query pending approvals
                                    |
                     +----- Approve | Reject -----+
                     |                            |
              "Abstracting"                 "Rejected"
              (5s mock process)             + rejection_comment
                     |                            |
              "Review Required"             Red Callout + Edit
                     |                       (re-submit)
         +-----------+                            |
         |                                        |
   4. Side-by-Side Review                         |
   - Left: PDF viewer                             |
   - Right: AI fields with                        |
     confidence borders                           |
   - Audit log tracks edits                       |
         |                                        |
   5. "Post Lease" button                         |
   (enabled after low-conf                        |
    fields interacted)                            |
         |                                        |
   6. status: "Posted" --------------------------->
      + Success notification
```

---

## Phase 1: Database Schema Updates

### Update `leases` Table
Add the following columns to the existing `leases` table:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| lease_type | text | NULL | 'Real Estate' or 'Equipment' |
| approver_email | text | NULL | Email of assigned approver |
| initializer_id | uuid | NULL | User who created the lease (FK to auth.users) |
| confidence_scores | jsonb | '{}' | AI confidence per field |
| rejection_comment | text | NULL | Required when rejected |
| audit_log | jsonb | '[]' | Array of audit entries |
| last_nudged_at | timestamptz | NULL | Last nudge timestamp |

### Update Status Values
Replace existing lifecycle statuses with the new simplified flow:
- Draft
- Pending Approval
- Rejected
- Abstracting
- Review Required
- Posted

### Migration SQL
```sql
-- Add new columns to leases table
ALTER TABLE public.leases 
ADD COLUMN IF NOT EXISTS lease_type text,
ADD COLUMN IF NOT EXISTS approver_email text,
ADD COLUMN IF NOT EXISTS initializer_id uuid REFERENCES auth.users(id),
ADD COLUMN IF NOT EXISTS confidence_scores jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS rejection_comment text,
ADD COLUMN IF NOT EXISTS audit_log jsonb DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS last_nudged_at timestamptz;

-- Add constraint for lease_type
ALTER TABLE public.leases 
ADD CONSTRAINT leases_type_check 
CHECK (lease_type IS NULL OR lease_type IN ('Real Estate', 'Equipment'));
```

---

## Phase 2: Fix Existing Build Errors

Before implementing new features, fix the three build errors in `LeaseReview.tsx`:

1. **Line 102**: Change `data.property_address` to `ext.property_address?.value`
2. **Line 159**: Change `action=` prop to `actions=`
3. **Line 338**: Add missing props to `RentScheduleTable`:
   - `currentMonthlyRent={derivedInsights.currentRent}`
   - `rentEscalationType={form.escalation_type || null}`

---

## Phase 3: Type Definitions

### Create `src/types/workflow.ts`

```typescript
export type WorkflowLeaseType = 'Real Estate' | 'Equipment';

export type WorkflowStatus = 
  | 'Draft' 
  | 'Pending Approval' 
  | 'Rejected' 
  | 'Abstracting' 
  | 'Review Required' 
  | 'Posted';

export interface ConfidenceScores {
  [field: string]: number; // 0-100
}

export interface AuditEntry {
  field: string;
  oldValue: string;
  newValue: string;
  userId: string;
  timestamp: string;
}

export interface CreateLeaseFormData {
  leaseType: WorkflowLeaseType;
  approverEmail: string;
  file?: File;
}

export const WORKFLOW_STATUS_CONFIG: Record<WorkflowStatus, {
  label: string;
  color: 'default' | 'secondary' | 'destructive' | 'outline' | 'warning';
  bgClass: string;
}> = {
  'Draft': { label: 'Draft', color: 'secondary', bgClass: 'bg-muted' },
  'Pending Approval': { label: 'Pending', color: 'warning', bgClass: 'bg-yellow-100' },
  'Rejected': { label: 'Rejected', color: 'destructive', bgClass: 'bg-red-100' },
  'Abstracting': { label: 'Processing', color: 'outline', bgClass: 'bg-blue-100' },
  'Review Required': { label: 'Review', color: 'outline', bgClass: 'bg-purple-100' },
  'Posted': { label: 'Posted', color: 'default', bgClass: 'bg-green-100' },
};
```

---

## Phase 4: Create Lease Drawer Component

### `src/components/workflow/CreateLeaseDrawer.tsx`

**Features:**
- Uses Vaul Drawer (bottom sheet on mobile, side panel styling)
- React Hook Form with Zod validation
- Toggle switch for Lease Type (Real Estate / Equipment)
- Email input for Approver
- react-dropzone for PDF upload
- On submit: inserts into `leases` with status "Pending Approval"
- Shows Sonner success toast and closes drawer

**Zod Schema:**
```typescript
const createLeaseSchema = z.object({
  leaseType: z.enum(['Real Estate', 'Equipment']),
  approverEmail: z.string().email('Please enter a valid email'),
  file: z.instanceof(File).optional(),
});
```

**Key Implementation:**
- Toggle implemented using two styled buttons or RadioGroup
- Dropzone with file type validation (PDF only)
- Upload file to Supabase Storage bucket "leases"
- Insert lease record with: `status`, `lease_type`, `approver_email`, `initializer_id`, `storage_path`

---

## Phase 5: Update Dashboard with Create Button

### Modify `src/pages/Dashboard.tsx`

Replace the existing "New Lease" button logic with a button that opens the CreateLeaseDrawer:

```tsx
const [createDrawerOpen, setCreateDrawerOpen] = useState(false);

// In actions:
<Button variant="accent" onClick={() => setCreateDrawerOpen(true)}>
  <Plus className="h-4 w-4 mr-2" />
  Create New Lease
</Button>

// Render drawer:
<CreateLeaseDrawer 
  open={createDrawerOpen} 
  onOpenChange={setCreateDrawerOpen}
  onSuccess={(leaseId) => navigate(`/app/leases/${leaseId}`)}
/>
```

---

## Phase 6: Nudge Logic Component

### `src/components/workflow/NudgeApproverButton.tsx`

**Features:**
- Button appears for leases with status "Pending Approval"
- 60-second UI cooldown after clicking
- Updates `last_nudged_at` in database
- Shows Sonner toast confirmation

**Implementation:**
```typescript
const [cooldown, setCooldown] = useState(false);
const [secondsLeft, setSecondsLeft] = useState(0);

const handleNudge = async () => {
  await supabase
    .from('leases')
    .update({ last_nudged_at: new Date().toISOString() })
    .eq('id', leaseId);
  
  toast.success('Nudge sent to approver');
  setCooldown(true);
  setSecondsLeft(60);
};

// Timer effect to count down
useEffect(() => {
  if (!cooldown) return;
  const timer = setInterval(() => {
    setSecondsLeft(s => {
      if (s <= 1) { setCooldown(false); return 0; }
      return s - 1;
    });
  }, 1000);
  return () => clearInterval(timer);
}, [cooldown]);
```

---

## Phase 7: Approver Interface

### Update `src/pages/app/ApprovalInbox.tsx`

**Features:**
- Query leases where `approver_email` matches current user's email
- Filter by status "Pending Approval"
- Display: Lease Type, Initializer info, Submitted date
- Each item has Approve/Reject buttons

### `src/components/workflow/ApprovalDialog.tsx`

**AlertDialog with two flows:**

1. **Approve:**
   - Sets status to "Abstracting"
   - Triggers mock 5-second background process
   - After delay, updates to "Review Required"
   - Populates `abstraction_data` with mock data
   - Populates `confidence_scores` (some < 80%)

2. **Reject:**
   - Requires `rejection_comment` (Textarea, validated)
   - Sets status to "Rejected"
   - Stores comment in `rejection_comment` column

---

## Phase 8: Rejected Lease Callout

### Update `src/pages/Leases.tsx`

Add a section at the top for rejected leases:

```tsx
{rejectedLeases.length > 0 && (
  <Alert variant="destructive" className="mb-4">
    <AlertCircle className="h-4 w-4" />
    <AlertTitle>Rejected Leases</AlertTitle>
    <AlertDescription>
      {rejectedLeases.map(lease => (
        <div key={lease.id} className="flex items-center justify-between py-2">
          <span>{lease.filename}: {lease.rejection_comment}</span>
          <Button size="sm" onClick={() => handleEdit(lease.id)}>
            Edit & Resubmit
          </Button>
        </div>
      ))}
    </AlertDescription>
  </Alert>
)}
```

---

## Phase 9: Side-by-Side AI Review View

### Update `src/pages/app/LeaseReview.tsx`

**Left Panel (existing):** PDF viewer using signed URL

**Right Panel Enhancements:**

1. **Confidence UI:**
   - Each field shows confidence percentage
   - Fields with `confidence_scores[field] < 80` get amber border
   
   ```tsx
   const getFieldBorderClass = (field: string) => {
     const confidence = lease?.confidence_scores?.[field] || 100;
     if (confidence < 80) return 'border-amber-400 border-2';
     return '';
   };
   ```

2. **Audit Tracking:**
   - Track original values on load
   - On any field change, append to `audit_log`
   
   ```typescript
   const trackFieldChange = (field: string, oldValue: string, newValue: string) => {
     if (oldValue === newValue) return;
     
     const entry: AuditEntry = {
       field,
       oldValue,
       newValue,
       userId: user.id,
       timestamp: new Date().toISOString(),
     };
     
     setAuditLog(prev => [...prev, entry]);
   };
   ```

3. **Low-Confidence Interaction Tracking:**
   - Track which low-confidence fields have been interacted with
   - Use a Set to store field names
   
   ```typescript
   const [interactedLowConfFields, setInteractedLowConfFields] = useState<Set<string>>(new Set());
   
   const handleFieldFocus = (field: string) => {
     const confidence = lease?.confidence_scores?.[field] || 100;
     if (confidence < 80) {
       setInteractedLowConfFields(prev => new Set([...prev, field]));
     }
   };
   ```

---

## Phase 10: Post Lease Footer

### Persistent Footer Component

```tsx
<div className="sticky bottom-0 border-t bg-background p-4 flex justify-between items-center">
  <div className="text-sm text-muted-foreground">
    {lowConfidenceFields.length} fields require attention
  </div>
  <Button 
    disabled={!allLowConfFieldsInteracted}
    onClick={handlePostLease}
  >
    <CheckCircle className="h-4 w-4 mr-2" />
    Post Lease
  </Button>
</div>
```

**Post Logic:**
```typescript
const handlePostLease = async () => {
  // Save audit log
  await supabase
    .from('leases')
    .update({
      status: 'Posted',
      audit_log: auditLog,
      ...form, // Save all form fields
    })
    .eq('id', leaseId);
  
  toast.success(
    'Lease posted successfully. The Approver and Initializer have been notified via email.',
    { duration: 5000 }
  );
  
  navigate('/app/leases');
};
```

---

## File Structure Summary

```text
src/
  components/
    workflow/
      CreateLeaseDrawer.tsx     # Vaul drawer with form
      ApprovalDialog.tsx        # Approve/Reject AlertDialog
      NudgeApproverButton.tsx   # Nudge with 60s cooldown
      WorkflowStatusBadge.tsx   # Status badge component
      RejectedLeaseCallout.tsx  # Red callout for rejected leases
  types/
    workflow.ts                 # New workflow types
  pages/
    Dashboard.tsx              # Updated with Create button
    Leases.tsx                 # Updated with rejected callout
    app/
      ApprovalInbox.tsx        # Updated approver interface
      LeaseReview.tsx          # Updated with confidence UI + audit
```

---

## Implementation Order

1. **Database Migration** - Add new columns to leases table
2. **Fix Build Errors** - Resolve 3 errors in LeaseReview.tsx
3. **Type Definitions** - Create workflow.ts types
4. **CreateLeaseDrawer** - Vaul drawer with form + dropzone
5. **Dashboard Update** - Replace New Lease button
6. **NudgeApproverButton** - 60-second cooldown logic
7. **ApprovalDialog** - Approve/Reject with mock abstraction
8. **RejectedLeaseCallout** - Red alert with edit button
9. **LeaseReview Updates** - Confidence UI + audit tracking
10. **Post Lease Footer** - Conditional enable + success notification

---

## Mock Abstraction Data

When transitioning from "Abstracting" to "Review Required":

```json
{
  "abstraction_data": {
    "property_address": "123 Main Street, Suite 100",
    "landlord_name": "ABC Properties LLC",
    "tenant_name": "Demo Company Inc",
    "lease_start": "2025-02-01",
    "lease_end": "2028-02-01",
    "monthly_rent": 5000,
    "security_deposit": 10000
  },
  "confidence_scores": {
    "property_address": 95,
    "landlord_name": 88,
    "tenant_name": 72,
    "lease_start": 91,
    "lease_end": 85,
    "monthly_rent": 65,
    "security_deposit": 78
  }
}
```

Fields with confidence < 80 (tenant_name, monthly_rent, security_deposit) will display amber borders.

---

## Security Considerations

1. **RLS Policies**: Existing policies cover SELECT/UPDATE for workspace members
2. **Email Validation**: Zod validates approver email format
3. **Audit Trail**: All manual changes logged with user ID and timestamp
4. **Status Transitions**: Only valid transitions allowed via application logic
