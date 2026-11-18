# Page: Plan review

Overrides `MASTER.md` for `/spaces/[alias]/plans/[planId]`. Screens (example data): the plan page in light and dark.

## Plan states

| State | Header badge (tone, icon) | Meaning |
|---|---|---|
| checking | info, Loader | The live-space check is running |
| ready | success, CircleCheck | Checked, valid, no approval needed |
| waiting | warning, Clock | Approval requested, not yet given |
| approved | success, UserCheck | A second person approved |
| applying | info, Loader | The apply job is running |
| applied | success, CircleCheck | Every item written and verified, or skipped |
| failed | destructive, CircleX | At least one item failed to write or verify |
| discarded | neutral | Closed without applying |

## Layout, top to bottom

1. **Top bar:** breadcrumb "Plans › <plan title>"; `SyncStatus` on the right.
2. **`PageHeader`:**
   - Title: the plan title, with the state badge.
   - Meta line: "Plan by <author> from <N> drafts · checked against the live space <Time>". Other origins show the origin line instead of "from <N> drafts", except when it repeats the title (a version restore is titled "Restore <name> to v<N>").
   - Actions: "Discard plan" (ghost), for the author or an Admin. It opens an `AlertDialog`: "Discard this plan?" followed by "The drafts stay saved." for a plan made from drafts, or "Nothing changes in the space." for any other plan. Then the approval controls (see "Approve and apply").
3. **Callouts:**

   | When | Tone | Title | Body | Action |
   |---|---|---|---|---|
   | An item's live version changed after the check | warning | "<N> asset(s) changed after this plan was made" | "<name> moved from v<a> to v<b> at <Time> (<source>). Apply will skip it. Re-check to plan it again against the new version." | "Re-check live space" (`plans.create`) |
   | Validation failed | destructive | "Validation failed for <N> asset(s)" | From drafts: "Fix the draft, then re-check." From a package: "This plan can't be applied while an item fails validation. Fix the package and import it again, then discard this plan." Otherwise: "This plan can't be applied while an item fails validation. Discard it and create it again once the cause is fixed." The plan badge reads "Validation failed" (destructive) instead of "Ready". | "Open draft" (drafts only) |
   | Apply finished | success | "Applied <N> changes" | "Commit <short hash>", plus " · Release <name>" when one was tagged | "View in History" |
   | Apply failed | destructive | "<N> change(s) failed" | Which items failed and why. Items already written stay written. | "Create a plan for the failed items" |

   The re-check action appears only in the callout, not again in the header.
4. **Summary chips:** one row of small outlined chips, number first.
   - Content updates, Status changes and Skipped (number in warning-fg above zero) are always shown. Skipped reads "Skips not checked yet" until a check passes.
   - Metadata updates and Creates are shown only when above zero.
   - Deletes is shown only when above zero, with its number in destructive-fg and the title "A snapshot is committed before each delete". Deletes can only appear when the space setting `deletesEnabled` is on.
   - Validation: CircleCheck and "Validation passed", or CircleX and "Validation failed for <N>", plus ", <N> warnings". Its title gives "<checks> checks, <N> failed". Validation needs no live read: when the check failed and the page compares with the last synced version, the same per-asset and set rules run against that version and the last synced index (the index a passing check uses too), and the title adds ", checked against the last synced version". Before any check: "Validation not checked yet".
5. **Review area:** the changes list (340 px) and the selected item card side by side. From 1024 px the area is as tall as the window below the top bar (`100dvh` − 88 px, at least 32 rem), and the list and the card body each scroll on their own, so the page doesn't grow with the plan. Below 1024 px they stack: the list is at most 60% and the card at most 85% of the window height.
6. **Notes**, when the plan has any, under the review area.

## Changes list

- Header: "Changes" and "<N> assets"; a `Segmented` "All", "Errors <N>" and "Warnings <N>" (each only when above zero); then the apply job's `JobProgress` while applying.
- A search field, "Filter by name or type", from 10 rows.
- Rows are grouped by change, in this order: Content updates, Metadata updates, Status changes, Deletes, Creates, No change, Not compared yet. Empty groups are left out, and a plan with one group shows no group headers. Group headers are buttons with the count and a chevron (`aria-expanded`). Creates and No change start collapsed when another group is shown, also when they appear after the check. Selecting a row in a collapsed group (Previous, Next) opens it. While a filter or search is active, every group with a match is open.
- A row is a link: the bold name, wrapping; on the right the validation icon (CircleX destructive-fg, TriangleAlert warning-fg or CircleCheck success-fg) with the count of errors or warnings; below, "<type> · <Live → new>" muted, for example "Instructions (AGENTS.md) · v8 → v9", "Memory in verity · new" or "v2 → v3, same content as v1", with "Set Inactive" or "Set Active" for a status change and "Skip: live changed" in warning-fg for an item apply will skip; on the right the +N and −M counts. While applying, the counts give way to the progress word (Waiting, Writing, Verifying, Done, Skipped or Failed, in the item progress tones), with the message under the type for Skipped and Failed.
- The selected row has a 3 px left bar in foreground and a 5% tint, and scrolls into view when it changes. The selection is `?item=<planItemId>`.

## Selected item card

- Header: "<name> · <main file>", the +N and −M counts, a Content or Metadata `ToggleGroup`, and the layout: Words, Lines, or Split (1024 px and wider, MASTER "Diffs"). Then "<position> of <total>" and Previous and Next (icon buttons, links to the rows before and after in list order, also the k and j keys outside a field or dialog). The layout carries over from item to item; Content or Metadata starts again for each.
- Words, the default: a removed line and an added line from the same run that share at least half of their non-space text show as one row (tint muted 40%, sign "~", both line numbers), with the removed words struck through in destructive and the added words in success. Other lines show as in Lines.
- For instructions, the `SizeMeterView` for the size after the change ("4.6 KB of 25 KB · 95 lines (about 120 recommended)"), in the tones from `asset-detail.md`.
- The diff of live against planned content, in the MASTER "Diffs" style.
- The body under the header scrolls on its own and starts at the top for each item.

## Approve and apply

In the page header, after "Discard plan": "Reject" (outline) for an approver, and the first button of the table below. A disabled button shows its reason next to it (`DisabledReason`). A closed plan shows the closed note instead ("Applied <Time>. Nothing more to do on this plan.").

The button opens one dialog, which is also the confirmation:

- Title: "Apply <N> changes to <space name>?", "Request approval for this plan?" or "Approve this plan?".
- Description: for apply "Writes go to <space name>. There is no undo: to go back, restore an earlier version as a new plan."; for a request "The plan waits for a second person to approve it. The change reason is saved with the request."; for approve "Approving lets the plan be applied. Nothing is written to the space until then."
- For apply, the counts by change type and the skipped items by name.
- **Change reason.** A `Textarea` with a visible label, "(required for this space)" when the space setting `changeReasonRequired` is on (the default), and the help "Saved with this change in the history and shown on the History page." It can be typed by the author requesting approval and by anyone applying. Next to "Approve" it is read only: approving doesn't save it. An inline error appears when the reason is required and empty at apply.
- The approval facts.
- For apply, "What apply does".
- Buttons: "Cancel" (outline) and the action ("Apply <N> changes", "Request approval", "Approve").

**Approval facts.** A definition list:
- Approval: "A second person must approve" when the space setting `approvalRequired` is on, or "Not required for this space".
- Can approve: "Publishers and Admins, except the plan's author".
- Requested: "<Time>, no response yet", or Approved: "<name>, <Time>".

**Buttons by role and state.** Show the first row that applies:

| Who | State | Primary button | Otherwise |
|---|---|---|---|
| Author, approval required | ready, not requested | "Request approval" | |
| Approver (`plans.approve`, not the author) | waiting | "Approve" | "Reject" (outline, asks for a note) |
| Publisher (`plans.apply`) | approved, or ready when no approval is needed | "Apply <N> changes" | |
| Anyone else, or a blocked state | any | the disabled button that would apply, through `DisabledReason` | Reasons: "Apply unlocks after approval.", "Validation failed for <N> asset(s).", "You need the Publisher role to apply.", "The plan author can't approve their own plan." |

<N> counts only the items that will be written, not skipped or unchanged ones.

Applying starts the job, closes the dialog, shows the toast "Applying <N> changes", and turns on the progress words in the changes list with `JobProgress` above the rows.

## What apply does

A short numbered list, in the apply dialog:

1. Re-reads each asset and skips any that changed since this check.
2. Writes each change once, with the plan item as its client token.
3. Reads every asset back and compares content hashes.
4. Commits the result to git with your reason.

## Audit log

Record an audit event for request approval, approve, reject, apply started, apply finished or failed, and discard (AGENTS.md: `recordAuditEvent`).
