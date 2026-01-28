
# Lease Amendment Workflow Enhancement Plan

## Overview
This plan enhances the existing CreateLeaseDrawer to support both New Leases and Lease Amendments with a multi-step flow, parent lease selection, and contextual comparison in the review interface.

## Architecture Flow

```text
+------------------------+
|  CreateLeaseDrawer     |
+------------------------+
           |
           v
+------------------------+
| Step 1: Lease Type     |
| [Real Estate][Equipment]|
+------------------------+
           |
           v
+------------------------+
| Step 2: Category       |
| [New Lease][Amendment] |
+------------------------+
           |
     +-----+-----+
     |           |
     v           v
[New Lease]  [Amendment]
     |           |
     |           v
     |    +------------------------+
     |    | Step 3: Parent Select  |
     |    | (Searchable Combobox)  |
     |    | Shows only "Posted"    |
     |    +------------------------+
     |           |
     +-----+-----+
           |
           v
+------------------------+
| Approver Email         |
| PDF Dropzone           |
+------------------------+
           |
           v
+------------------------+
| [Manual Entry] ghost   |
| [Submit for Approval]  |
+------------------------+
```

## Phase 1: Database Schema Update

### Add parent_lease_id Column
A migration is required to add the `parent_lease_id` column and `category` enum support:

```sql
ALTER TABLE public.leases 
ADD COLUMN IF NOT EXISTS parent_lease_id uuid REFERENCES public.leases(id);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_leases_parent_lease_id 
ON public.leases(parent_lease_id) 
WHERE parent_lease_id IS NOT NULL;
```

---

## Phase 2: Type Definitions Update

### Update `src/types/workflow.ts`

Add new types for lease categories:

```typescript
export type LeaseCategory = 'New Lease' | 'Lease Amendment';

export interface CreateLeaseFormData {
  leaseType: WorkflowLeaseType;
  category: LeaseCategory;
  approverEmail: string;
  parentLeaseId?: string; // Required when category = 'Lease Amendment'
  file?: File;
}
```

---

## Phase 3: Multi-Step CreateLeaseDrawer

### Component: `src/components/workflow/CreateLeaseDrawer.tsx`

**Step-based UI Flow:**

| Step | Content | Condition |
|------|---------|-----------|
| 1 | Lease Type Toggle (Real Estate / Equipment) | Always shown |
| 2 | Category Toggle (New Lease / Lease Amendment) | Always shown |
| 3 | Parent Lease Combobox | Only if category = "Lease Amendment" |
| 4 | Approver Email + PDF Dropzone | Always shown |

**State Management:**
```typescript
const [step, setStep] = useState(1);
const [parentLeases, setParentLeases] = useState<PostedLease[]>([]);
const [searchQuery, setSearchQuery] = useState('');
const [parentLeaseOpen, setParentLeaseOpen] = useState(false);

const form = useForm<CreateLeaseFormValues>({
  resolver: zodResolver(createLeaseSchema),
  defaultValues: {
    leaseType: 'Real Estate',
    category: 'New Lease',
    approverEmail: '',
    parentLeaseId: undefined,
  },
});
```

**Zod Schema Update:**
```typescript
const createLeaseSchema = z.object({
  leaseType: z.enum(['Real Estate', 'Equipment']),
  category: z.enum(['New Lease', 'Lease Amendment']),
  approverEmail: z.string().email('Please enter a valid email'),
  parentLeaseId: z.string().uuid().optional(),
}).refine((data) => {
  // Require parentLeaseId when category is Amendment
  if (data.category === 'Lease Amendment' && !data.parentLeaseId) {
    return false;
  }
  return true;
}, {
  message: 'Please select a parent lease for amendments',
  path: ['parentLeaseId'],
});
```

### Searchable Parent Lease Combobox

Build using Popover + Command (cmdk) pattern:

```typescript
// Fetch posted leases for selection
useEffect(() => {
  if (category !== 'Lease Amendment') return;
  
  const fetchPostedLeases = async () => {
    const { data } = await supabase
      .from('leases')
      .select('id, filename, tenant_name, landlord_name, property_address, lease_end')
      .eq('lifecycle_status', 'Posted')
      .eq('workspace_id', workspace?.id)
      .order('uploaded_at', { ascending: false });
    
    setParentLeases(data || []);
  };
  fetchPostedLeases();
}, [category, workspace?.id]);
```

UI Component Structure:
- Popover trigger shows selected lease or placeholder
- Command with CommandInput for search
- CommandList with filtered results showing:
  - Filename
  - Tenant name
  - Property address (truncated)
  - Lease end date

### Manual Entry Ghost Button

Add below the form:
```tsx
<Button 
  type="button" 
  variant="ghost" 
  className="w-full text-muted-foreground"
  onClick={() => {
    onOpenChange(false);
    navigate('/app/leases/new', { 
      state: { 
        category: form.getValues('category'),
        leaseType: form.getValues('leaseType'),
        parentLeaseId: form.getValues('parentLeaseId'),
      }
    });
  }}
>
  <FileText className="h-4 w-4 mr-2" />
  Enter Details Manually
</Button>
```

---

## Phase 4: Update NewLease.tsx for Amendment Support

### Read Navigation State
```typescript
const location = useLocation();
const navigationState = location.state as {
  category?: LeaseCategory;
  leaseType?: WorkflowLeaseType;
  parentLeaseId?: string;
} | null;

const [category, setCategory] = useState<'new' | 'amendment'>(
  navigationState?.category === 'Lease Amendment' ? 'amendment' : 'new'
);
const [parentLeaseId, setParentLeaseId] = useState<string | undefined>(
  navigationState?.parentLeaseId
);
```

### Add Category Toggle
Add a toggle at the top of the form to switch between "New Lease" and "Amendment".

### Parent Lease Selector
When "Amendment" is selected, show the same searchable combobox pattern used in the drawer.

### Include parent_lease_id in Submit
```typescript
const leaseId = await createDraftLease({
  category,
  parentLeaseId: category === 'amendment' ? parentLeaseId : undefined,
  // ... other fields
});
```

---

## Phase 5: Contextual Side-by-Side Review for Amendments

### Update `src/pages/app/LeaseReview.tsx`

**Parent Lease State:**
```typescript
const [parentLease, setParentLease] = useState<any | null>(null);
const isAmendment = !!lease?.parent_lease_id;
```

**Fetch Parent Lease Data:**
```typescript
useEffect(() => {
  if (!lease?.parent_lease_id) return;
  
  const fetchParentLease = async () => {
    const { data } = await supabase
      .from('leases')
      .select('*')
      .eq('id', lease.parent_lease_id)
      .single();
    
    if (data) setParentLease(data);
  };
  fetchParentLease();
}, [lease?.parent_lease_id]);
```

### Layout Options for Amendment Review

**Option A: Floating "Current Terms" Card**
A collapsible card positioned at the top of the right panel showing parent lease data:

```tsx
{isAmendment && parentLease && (
  <Collapsible open={showParentTerms} onOpenChange={setShowParentTerms}>
    <Card className="mb-4 border-blue-200 bg-blue-50/50">
      <CollapsibleTrigger asChild>
        <CardHeader className="cursor-pointer py-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <FileText size={14} className="text-blue-600" />
              Current Terms (Parent Lease)
            </span>
            <ChevronDown className={cn("h-4 w-4 transition-transform", showParentTerms && "rotate-180")} />
          </CardTitle>
        </CardHeader>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CardContent className="pt-0 grid grid-cols-2 gap-3 text-sm">
          <div>
            <Label className="text-xs text-muted-foreground">Monthly Rent</Label>
            <p className="font-medium">${parentLease.current_monthly_rent?.toLocaleString() || parentLease.base_rent_amount}</p>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Lease End</Label>
            <p className="font-medium">{parentLease.lease_end ? format(new Date(parentLease.lease_end), 'MMM d, yyyy') : 'N/A'}</p>
          </div>
          {/* Additional fields */}
        </CardContent>
      </CollapsibleContent>
    </Card>
  </Collapsible>
)}
```

**Option B: Third Panel (for larger screens)**
Add a third resizable panel when amendment is detected:

```tsx
<ResizablePanelGroup direction="horizontal">
  {/* PDF Panel */}
  <ResizablePanel defaultSize={isAmendment ? 35 : 50}>
    {/* PDF viewer */}
  </ResizablePanel>
  
  <ResizableHandle />
  
  {/* Parent Terms Panel - only for amendments */}
  {isAmendment && parentLease && (
    <>
      <ResizablePanel defaultSize={25} minSize={15} collapsible>
        <div className="h-full flex flex-col bg-blue-50/30 border-r">
          <div className="p-2 border-b bg-blue-100/50">
            <span className="text-[10px] font-bold uppercase text-blue-700">
              Current Terms
            </span>
          </div>
          <ScrollArea className="flex-1">
            {/* Parent lease fields for comparison */}
          </ScrollArea>
        </div>
      </ResizablePanel>
      <ResizableHandle />
    </>
  )}
  
  {/* Review Panel */}
  <ResizablePanel defaultSize={isAmendment ? 40 : 50}>
    {/* Existing review form */}
  </ResizablePanel>
</ResizablePanelGroup>
```

### Visual Diff Indicators
For each field in the review form, show change indicators when values differ from parent:

```tsx
const getChangeBadge = (fieldId: string, currentValue: any, parentValue: any) => {
  if (!isAmendment || !parentLease) return null;
  
  const hasChanged = currentValue !== parentValue && parentValue != null;
  if (!hasChanged) return null;
  
  return (
    <Badge variant="outline" className="text-[9px] text-orange-600 border-orange-300 bg-orange-50">
      Changed from: {parentValue}
    </Badge>
  );
};
```

---

## Phase 6: UI Component Summary

### New/Modified Files:

| File | Action | Description |
|------|--------|-------------|
| `src/types/workflow.ts` | Modify | Add LeaseCategory type |
| `src/components/workflow/CreateLeaseDrawer.tsx` | Modify | Multi-step form with category + parent selection |
| `src/components/workflow/ParentLeaseCombobox.tsx` | Create | Reusable searchable parent lease selector |
| `src/pages/app/NewLease.tsx` | Modify | Support amendment category + parent lease |
| `src/pages/app/LeaseReview.tsx` | Modify | Add parent lease comparison UI |
| Migration | Create | Add parent_lease_id column |

---

## Implementation Order

1. **Database Migration** - Add `parent_lease_id` column to leases table
2. **Type Updates** - Add `LeaseCategory` type and update `CreateLeaseFormData`
3. **ParentLeaseCombobox** - Create reusable searchable dropdown component
4. **CreateLeaseDrawer** - Implement multi-step flow with category + parent selection
5. **NewLease Page** - Update manual entry form to support amendments
6. **LeaseReview** - Add parent lease fetching and comparison UI

---

## Technical Notes

### Searchable Combobox Pattern
Uses existing shadcn/ui components:
- `Popover` + `PopoverTrigger` + `PopoverContent` for dropdown container
- `Command` + `CommandInput` + `CommandList` + `CommandItem` for search functionality
- Filter parent leases client-side based on search query

### Parent Lease Query Filter
Only shows leases with `lifecycle_status = 'Posted'` from the same workspace:
```sql
SELECT id, filename, tenant_name, landlord_name, lease_end 
FROM leases 
WHERE lifecycle_status = 'Posted' 
AND workspace_id = $workspace_id
ORDER BY uploaded_at DESC
```

### Amendment Validation
- Parent lease must be in "Posted" status
- Amendment inherits `lease_type` from parent (optional UX enhancement)
- `parent_lease_id` is stored as foreign key reference

### Mobile Responsiveness
- Multi-step form works well in drawer on mobile
- Parent lease comparison card (Option A) is mobile-friendly
- Three-panel layout (Option B) automatically collapses on mobile

---

## Security Considerations

1. **RLS Policy for parent_lease_id** - Users can only select parent leases from their workspace
2. **Validation** - Server-side check that parent_lease_id points to a Posted lease in same workspace
3. **Foreign Key** - Database-level constraint ensures referential integrity
