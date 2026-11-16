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
   - Action: "Discard plan" (ghost), for the author or an Admin. It opens an `AlertDialog`: "Discard this plan?" followed by "The drafts stay saved." for a plan made from drafts, or "Nothing changes in the space." for any other plan.
3. **Callouts:**

   | When | Tone | Title | Body | Action |
   |---|---|---|---|---|
   | An item's live version changed after the check | warning | "<N> asset(s) changed after this plan was made" | "<name> moved from v<a> to v<b> at <Time> (<source>). Apply will skip it. Re-check to plan it again against the new version." | "Re-check live space" (`plans.create`) |
   | Validation failed | destructive | "Validation failed for <N> asset(s)" | From drafts: "Fix the draft, then re-check." From a package: "This plan can't be applied while an item fails validation. Fix the package and import it again, then discard this plan." Otherwise: "This plan can't be applied while an item fails validation. Discard it and create it again once the cause is fixed." The plan badge reads "Validation failed" (destructive) instead of "Ready". | "Open draft" (drafts only) |
   | Apply finished | success | "Applied <N> changes" | "Commit <short hash>", plus " · Release <name>" when one was tagged | "View in History" |
   | Apply failed | destructive | "<N> change(s) failed" | Which items failed and why. Items already written stay written. | "Create a plan for the failed items" |

   The re-check action appears only in the callout, not again in the header.
4. **Summary tiles:**
   - Content updates, Status changes and Will be skipped (value in warning-fg) are always shown.
   - Creates is shown only when above zero.
   - Deletes is shown only when above zero, with its value in destructive-fg. Deletes can only appear when the space setting `deletesEnabled` is on.
   - Validation shows "Passed" or "<N> failed", with "<checks> checks". Validation needs no live read: when the check failed and the page compares with the last synced version, the same per-asset and set rules run against that version and the last synced index (the index a passing check uses too), and the detail adds ", checked against the last synced version". "Apply will skip" stays "Not checked" until a check passes.
5. **Two columns:** items and the selected item's diff on the left; "Approve and apply" and "What apply does" on the right.

## Items table

Columns:

- **Asset:** bold name over the type label.
- **Change:** icon and text from the plan-item row of the MASTER status table. Creates use CirclePlus and "Create". Deletes use the destructive tone and "Delete (snapshot taken first)".
- **Live → new:** mono, for example "v5 → v6", "v1, status only", or "planned v1, live v2". A version restore says where the content comes from: "v2 → v3, same content as v1".
- **Validation:** a badge.
- **Progress:** added while applying, with Waiting, Writing, Verifying, Done, Skipped or Failed.

The selected row has a 3 px left bar in foreground and a 5% tint. The selection is `?item=<planItemId>`, and the asset name is the control that sets it.

## Selected item card

- Header: "<name> · <main file>", the +N and −M counts, a Content or Metadata `ToggleGroup`, and Unified or Split (1024 px and wider, MASTER "Diffs").
- For instructions, the `SizeMeterView` for the size after the change ("4.6 KB of 25 KB · 95 lines (about 120 recommended)"), in the tones from `asset-detail.md`.
- The diff of live against planned content, in the MASTER "Diffs" style.

## Approve and apply card

**Change reason.**
- `Textarea` with a visible label. Add "(required for this space)" when the space setting `changeReasonRequired` is on (the default).
- Help text: "Saved with the git commit and shown in History."
- Who can type it: the author while requesting approval, and anyone whose role can apply this plan while it is open, even while Apply is still disabled (checking, check failed, waiting for approval). It is sent with Apply. For a role that can't apply, the reason is read only, with `missingRoleReason` for applying. Next to "Approve" it is read only too: approving doesn't save it.
- An inline error appears when the reason is required and empty at apply.

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

**Apply confirmation.** An `AlertDialog`:
- Title: "Apply <N> changes to <space name>?"
- Body: the counts by change type, the skipped items by name, and the change reason.
- Buttons: "Apply <N> changes" (primary) and "Cancel".

Confirming starts the job, shows the toast "Applying <N> changes", and turns on the Progress column with `JobProgress` above the table.

## What apply does

A short numbered list, always shown:

1. Re-reads each asset and skips any that changed since this check.
2. Writes each change once, with the plan item as its client token.
3. Reads every asset back and compares content hashes.
4. Commits the result to git with your reason.

## Audit log

Record an audit event for request approval, approve, reject, apply started, apply finished or failed, and discard (AGENTS.md: `recordAuditEvent`).
