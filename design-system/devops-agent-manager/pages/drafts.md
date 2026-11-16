# Page: Drafts

Overrides `MASTER.md` for `/spaces/[alias]/drafts`. Screen (example data): the drafts list with a selection. A draft is one person's pending edit of one asset (`draft-editor.md`, "Model"). The flow covers plans steps 1 and 2: save drafts, then create a plan from them.

MASTER puts "New plan" on this screen. Here it is the "Create plan" button in the selection bar.

## Layout, top to bottom

1. **Top bar:** breadcrumb "Plans › Drafts"; `SyncStatus` on the right.
2. **`PageHeader`** (shared with the Plans page):
   - Title: "Plans".
   - Description: "Drafts are edits saved in this app. A plan checks them against the live space, and nothing is written until the plan is applied."
   - Action: "Import package" (outline, Upload icon), for users with `plans.create`. It opens `package-import.md`.
3. **Tabs as links**, the asset page pattern: "Plans <open plans>" (`/plans`) and "Drafts <open drafts>" (`/drafts`). The current one has `aria-current="page"`. The sidebar's Plans item stays active on both.
4. **"Open drafts" card:**
   - Header: `h2` "Open drafts", and a `ToggleGroup` "Mine <n>" or "Everyone <n>". The choice lives in `?who=mine|all`; the default is `all`, so people see each other's work in progress.
   - Then the table, the selection bar and the footer help.

## Table

| Column | Content |
|---|---|
| Select | A checkbox, only on your own drafts that aren't in a plan. Accessible name "Select <name>". The header checkbox selects every selectable row, and is mixed when some are selected |
| Draft | Bold asset name, linked to the draft editor, over the type label ("Memory in chat-tool-use-best-practices"). When another person also has a draft of the same asset, add " · you also have a draft" or " · <name> also has a draft" |
| Change | Icon and text from the MASTER plan-item words: "Update content" (info, SquarePen), "Set Inactive" or "Set Active" (agent color, PowerOff or Power), "Update metadata" (SquarePen) |
| Based on | Mono `v<N>`. When live moved past it, a second line "Live is v<b>" in warning-fg with TriangleAlert |
| Validation | Badge from the last save: "Passed", "<N> errors" or "<N> warnings" |
| Plan | The open plan that holds the draft, linked with an underline, or "Not in a plan" in muted text |
| Author | Name |
| Saved | `Time`, right-aligned |
| Actions | "Discard" (ghost, 28 px), on your own drafts that aren't in a plan |

- Row order: your drafts that aren't in a plan, then drafts in a plan (grouped by plan), then other people's drafts. Within each group, saved time, oldest first.
- Checked rows get a 3% foreground tint.
- Over 50 rows, use "Show more".

**Checkbox.** shadcn `Checkbox` draws a 16 px box. Give it a 24 by 24 px hit area (a `size-6` wrapper, or padding on the cell) to meet the target-size rule. The unchecked border needs 3:1 against the card: use `border-muted-foreground`, not `border-input`.

## Selection bar

Shown when at least one draft is selected, under the table on a `bg-muted` strip:

- "<N> drafts selected" in bold.
- "Plan title": a visible label and an `Input`. The default is the asset names ("service-catalog and cache-path-check", or "service-catalog, cache-path-check and 3 more"), which the user can change.
- "Create plan from <N> drafts" (primary, GitPullRequest icon).
- "Clear selection" (ghost).

Footer help, always shown: "You can add your own drafts that aren't in a plan yet. Creating the plan checks them against the live space, then opens the plan for review."

**Create plan.**
- It calls `createPlan` with `origin: { kind: "drafts", draftIds }`, one item per draft (with its `baseVersion` and `baseUpdatedAt`), and the title.
- Then it goes to the new plan page, which starts in "checking" (`plan-review.md`).
- No toast: the plan page's checking state is the confirmation.

**Disabled reasons** (through `DisabledReason`), first match:

| When | Reason |
|---|---|
| A selected draft has validation errors | "Fix the errors in <name> first." |
| The title is empty | "Enter a plan title." |

## States

| State | What shows |
|---|---|
| Drafts exist, none selected | Table; no selection bar |
| Some selected | Selection bar |
| A draft is in a plan | No checkbox; Plan column links to the plan. When the plan is applied or discarded, the draft leaves this list (applied) or becomes selectable again (discarded) |
| A draft's asset was deleted from the space | Change column reads "Asset deleted" in destructive-fg; the checkbox is disabled with the reason in the row: "The asset was deleted from the space." |

## Empty states

| View | Title | Body | Action |
|---|---|---|---|
| Mine, none | "No drafts yet" | "Open an asset and choose Edit as draft. Drafts stay in this app until a plan applies them." | "Open assets" |
| Everyone, none | "No open drafts in this space" | Same body | "Open assets" |

## Discard

An `AlertDialog`, the same as in the draft editor: "Discard your draft of <name>?", "Your edits are deleted. The live space is not affected.", with "Discard draft" and "Cancel".

## Audit log

Record `plan.create` (origin `drafts`, the draft IDs) and `draft.discard`.

## Data

- A loader returns the space's open drafts with: asset name, type label and parent; change kind; base version and live version; validation counts; open plan ID and title; author; saved time.
- It also returns the counts for the two tabs.
- Server Actions: `createPlanFromDrafts(draftIds, title)` and `discardDraft(draftId)`.

## Open items

- **Draft granularity.** This screen assumes one draft per person per asset. "Draft: one or more edited assets" in the original design and `asset-detail.md`'s "adds a status change to the user's draft" can also be read as a named draft that holds several assets. Per-asset drafts need no draft names and no "which draft?" choice, so they are the default here. `plan-review.md`'s "Plan by Alex Rivera from 2 drafts" for a plan with 5 items reads as the other model. Under this one it would say "from 4 drafts" (the "No change" memory store row being a referenced store), as the Plans screen does.
- **Other people's drafts in your plan.** The default lets you select only your own drafts, which is easy to relax later. A team may want a Publisher to bundle colleagues' drafts into one plan.
