# LeaseIO — Approval Policy Editor: Visual Contract Addendum

**Status:** Addendum to `docs/APPROVAL_POLICY_EDITOR_REDESIGN.md`. Written after the first implementation pass shipped with correct structural bones but a visually flat surface.
**Owner:** Daniel
**Audience:** Claude Code, future contributors

This addendum locks the visual layer. The parent spec (`APPROVAL_POLICY_EDITOR_REDESIGN.md`) covers principles and architecture. This document covers pixels — specifically the four primitives that got lost in the first implementation:

1. The colored-pill rule sentence
2. The approver person card (with avatar)
3. Side-by-side parallel rendering with an "AND at the same time" connector
4. The seeded empty state for new rules

If any of those four diverge from this document, the implementation has not satisfied the spec.

---

## 1. Approver card

Each approver renders as a card with an avatar, name, and role — NOT as a generic dropdown. The current "Manager approver" dropdown inside a "WHO APPROVES?" header is the wrong pattern.

**Empty slot** (no approver chosen yet):

```jsx
<button className="w-full p-3 border-2 border-dashed rounded-lg text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors flex items-center justify-center gap-2">
  <UserPlus className="w-4 h-4" />
  Choose an approver…
</button>
```

Clicking opens a combobox/popover that lets the admin pick either a specific person OR a role ("Anyone with role: Finance Director"). The picker is the only place where the user/role distinction surfaces — once chosen, the card renders the same way for both.

**Populated slot** (approver chosen):

```jsx
<div className="flex items-center gap-3 p-3 bg-card border rounded-lg">
  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center text-xs font-medium text-blue-800 dark:text-blue-200 shrink-0">
    SK
  </div>
  <div className="flex-1 min-w-0">
    <div className="text-sm font-medium truncate">Sara Kim</div>
    <div className="text-xs text-muted-foreground truncate">Department Head</div>
  </div>
  <Button variant="ghost" size="icon" className="h-7 w-7">
    <MoreVertical className="h-4 w-4" />
  </Button>
</div>
```

For role-based approvers (`approver_role` set, `approver_user_id` null), substitute:
- Avatar initials = role abbreviation (DH, FD, CFO)
- Name line = "Anyone with role"
- Role line = the role's display label

### Avatar colors

Deterministic from the approver identifier so the same person/role always renders the same color across the page. Hash the identifier (user UUID or role string) and mod by 6:

| Hash mod 6 | Bg light | Bg dark | Text light | Text dark |
|---|---|---|---|---|
| 0 | `bg-blue-100` | `bg-blue-900/40` | `text-blue-800` | `text-blue-200` |
| 1 | `bg-emerald-100` | `bg-emerald-900/40` | `text-emerald-800` | `text-emerald-200` |
| 2 | `bg-pink-100` | `bg-pink-900/40` | `text-pink-800` | `text-pink-200` |
| 3 | `bg-amber-100` | `bg-amber-900/40` | `text-amber-800` | `text-amber-200` |
| 4 | `bg-violet-100` | `bg-violet-900/40` | `text-violet-800` | `text-violet-200` |
| 5 | `bg-teal-100` | `bg-teal-900/40` | `text-teal-800` | `text-teal-200` |

A simple djb2 or FNV-1a hash is fine. Consistency matters more than distribution quality.

---

## 2. Side-by-side parallel rendering

This is the single most important visual move. When two or more approvers share the same `parallel_group` within a step, they render horizontally with an "AND at the same time" connector between them.

```jsx
<div className="flex items-stretch gap-2">
  <div className="flex-1 min-w-0"><ApproverCard ... /></div>
  <div className="flex items-center px-1 text-[10px] font-medium text-muted-foreground leading-tight text-center whitespace-nowrap">
    AND<br/>at the<br/>same<br/>time
  </div>
  <div className="flex-1 min-w-0"><ApproverCard ... /></div>
</div>
```

For three+ approvers in parallel: same pattern, with connectors between each pair. The connector text stays identical — repetition reinforces the meaning, it does not feel redundant.

**Mobile fallback** (viewport < 640px): stack vertically. Replace the inline connector with a full-width centered label between cards:

```jsx
<div className="flex flex-col gap-2">
  <ApproverCard ... />
  <div className="text-center text-xs font-medium text-muted-foreground">— AND at the same time —</div>
  <ApproverCard ... />
</div>
```

**Adding to a parallel group**: the existing "+ Add another approver to this step" link, when clicked inside an existing step, defaults to adding to the same `parallel_group`. To add a sequential next round, the affordance is at the step level: a separate "+ Add another step" button below the chain.

---

## 3. Rule sentence pills

The match-criteria area must render as an English sentence at all times, including when no criteria are set. The current empty state — "This rule applies to all requests" with a separate "+ Add filter" button — is the wrong shape; it puts the affordance outside the sentence instead of inside it.

### Empty state

Render this exact sentence with all four tokens as dashed-outline placeholder pills:

> When someone requests a **[any lease type]** in **[any department]** for **[any annual cost]**, located in **[any region]**.

Each bracketed token is clickable. Clicking opens the appropriate selector. Once selected, the placeholder pill becomes a solid colored pill (see below).

```jsx
{/* Empty pill */}
<button className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-muted-foreground/40 text-sm text-muted-foreground hover:border-foreground hover:text-foreground transition-colors">
  any lease type
  <ChevronDown className="w-3 h-3" />
</button>

{/* Filled pill */}
<button className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 dark:bg-blue-900/30 text-sm font-medium text-blue-800 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors">
  Real Estate
  <ChevronDown className="w-3 h-3" />
</button>
```

### Pill color by criterion type

| Criterion | Pill ramp |
|---|---|
| Asset type / lease type | blue |
| Department | emerald |
| Region | teal |
| Annual cost range | violet |

### Removing a filter

Hovering a filled pill reveals a small × button on the right; clicking it sets the criterion back to its empty-pill placeholder state. There is no separate "remove filter" command and no need for the helper text "click the × to remove it" — the affordance is self-explanatory.

### "+ Add filter" affordance

This stays, but it appears below the sentence ONLY for criteria not represented in the default sentence (currently: nothing — the four shown above cover all match fields except a possible future addition). When all four criteria are visible by default, the "+ Add filter" button is unnecessary and should be removed.

---

## 4. Seeded empty state for new rules

When the user clicks **+ New rule**, do NOT auto-fill the Name field with the user's display name. The current implementation shows "Daniel" pre-populated, which is a placeholder bug, not a feature.

Seed instead:

| Field | Initial value |
|---|---|
| Name | Empty. Placeholder: `e.g., Mid-size real estate leases` |
| Description | Empty. Placeholder: `Notes for other admins (optional)` |
| Active | ON |
| Match criteria | All empty — renders the four-pill empty sentence from §3 |
| Step 1 (Concept) | One empty approver slot ("Choose an approver…") |
| Step 2 (Signator) | One empty approver slot |
| Advanced settings | Collapsed |

The empty sentence and empty card slots together create the visual scaffolding that makes the page legible at a glance. A blank canvas with no structural cues was the failure mode of the original UI; this redesign avoids it specifically by always rendering the structure even when the data is empty.

---

## 5. Step header and inter-step connector

Each step is preceded by a circled-number badge and a two-part caption:

```jsx
<div className="flex items-center gap-2 mb-3">
  <div className="w-5.5 h-5.5 rounded-full border border-border flex items-center justify-center text-xs font-medium bg-background">
    1
  </div>
  <span className="text-sm font-medium">First, get the green light</span>
  <span className="text-xs text-muted-foreground">— before any paperwork starts</span>
</div>
```

The "STEP 1" sub-header inside each step card in the current implementation is redundant with this badge and should be removed.

Between Step 1 and Step 2, render a 24px-tall vertical line in `border-border`, centered horizontally in the card column. This is the visual signal that Step 2 follows Step 1 in time.

```jsx
<div className="flex justify-center my-3">
  <div className="w-px h-6 bg-border"></div>
</div>
```

---

## 6. What to remove from the current implementation

- The literal "STEP 1" sub-header inside step cards (redundant with the circled badge)
- The "WHO APPROVES?" section header inside each approver slot (redundant — the avatar+name card answers the question)
- Helper text *"Build a one-sentence rule by adding filters. Click any filter to change its values; click the × to remove it."* — this is replaced by the actual rendered sentence
- Auto-fill of the user's display name in the Name field (a real bug)
- The "Manager approver" dropdown shown directly in the chain — replaced by the approver-card pattern, with the dropdown moving inside the picker that opens when an empty slot is clicked

---

## 7. What to keep from the current implementation

- The Name / Description / Active card at the top
- The "When does this rule apply?" card title
- The "+ Add another approver to this step" link
- Drag handle on each step
- The trash-can icon on each approver card (mapped to MoreVertical → menu → Remove in the new version)
- The "Try it on a sample request" primary button
- The Cancel / Create rule footer pair
- Dark mode parity

---

## 8. Visual ground truth

A fully-populated rule should look approximately like this. The current implementation is missing the rule sentence, the person-card pattern, and the side-by-side parallel rendering — those are the three rows below that need to land.

```
┌─────────────────────────────────────────────────────┐
│ ← All rules                                         │
│                                                     │
│ Mid-size real estate leases                         │
│ Active · Last updated 2 days ago by Daniel          │
├─────────────────────────────────────────────────────┤
│ WHEN DOES THIS RULE APPLY?                          │
│                                                     │
│ When someone requests a [Real Estate] in            │
│ [any department] for [$50,000 – $500,000],          │
│ located in [any region].                            │
├─────────────────────────────────────────────────────┤
│ WHO NEEDS TO APPROVE?                               │
│                                                     │
│ ① First, get the green light                        │
│   ┌──────────────┐ AND  ┌──────────────┐            │
│   │ (SK) Sara Kim│ at   │ (FD) Anyone w│            │
│   │  Dept Head   │ the  │  Finance Dir │            │
│   └──────────────┘ same └──────────────┘            │
│                                                     │
│        │  (vertical connector)                      │
│                                                     │
│ ② Then, sign the deal                               │
│   ┌──────────────────────────────────────┐          │
│   │ (MR) Maya Rodriguez                  │          │
│   │  CFO · Backup: David Chen +3d        │          │
│   └──────────────────────────────────────┘          │
├─────────────────────────────────────────────────────┤
│ ▸ Advanced settings                                 │
├─────────────────────────────────────────────────────┤
│ [Try it on a sample request]   [Cancel] [Save rule] │
└─────────────────────────────────────────────────────┘
```

The four primitives — pill sentence, person cards, side-by-side parallel with the AND connector, and seeded empty state — are the contract. Everything else is implementation detail.

---

## 9. Out of scope (clarifying what this is NOT)

Just to head off the same pushback the first round generated: this redesign is NOT moving toward a Blockly / Scratch-style block editor, a free-form 2D canvas, drag-from-palette, or snap-together connectors. The card-based vertical chain with side-by-side parallel rendering is the target architecture. The visual richness comes from the avatars, pills, and connector labels — not from a different editor paradigm.

If a future spec changes that decision, it will say so explicitly.
