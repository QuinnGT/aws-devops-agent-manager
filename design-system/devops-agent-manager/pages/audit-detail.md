# Page: Audit detail, Investigations and Findings tabs

Overrides `MASTER.md` for `/spaces/[alias]/audits/[auditId]` (Investigations, the default tab) and `/spaces/[alias]/audits/[auditId]/findings`. The Report tab is `audit-report.md`; one incident is `audit-item.md`; a draft audit renders `audit-new.md`. Screens: the Investigations tab and the Findings tab (each in light and dark, and at 768 px).

**The audit is one flow, not four screens.** A person reviews, decides, sends accepted package fixes to a revision, builds the report and saves the audit record. The flow strip at the top shows where they are, and each finding says what happens to it next. The Findings tab is a list and a detail side by side (the layout the plan page uses), after option 3 of the redesign.

## Shared header (all three tabs)

1. **Top bar:** breadcrumb "Audits › <audit name>" (plus "› Findings" or "› Report" on those tabs); `SyncStatus`.
2. **Title block** (the asset page header pattern): icon box with Microscope, `h1` the name, the state `StatusBadge` (`audits.md` states). Description: `audits.note` when set (72 characters per line). Meta: profile label · "Started <Time> by <name>" · "Model <modelId in mono>".
3. **Actions**, right side:

   | Action | Shown when | Permission |
   |---|---|---|
   | "Review next incident" (primary, ListChecks) | `reviewing` and any finding is proposed. Opens the first incident with proposed findings, in table order | `findings.review` |
   | "Rerun <N> failed reviews" (outline, RefreshCw) | Any item is `failed` | `audits.run` |
   | "Cancel audit" (ghost) | `running`. `AlertDialog`: "Cancel <name>? Reviews in progress stop after their current step. Finished reviews and findings are kept." | `audits.run` |

4. **Flow strip** (a `nav` of five linked cells, replacing the four tiles): each cell has a 11 px uppercase label, a line of text and sometimes a muted detail line. A done step shows a CircleCheck (with "(done)" for screen readers). The current step, the first one not done, has a 2 px bar along its bottom edge and `aria-current="step"`. It is five across from 1280 px, three across from 640 px and one column below. `flowStrip()` (`src/components/audits/flow.ts`) builds it.

   | Cell | Text | Detail | Links to | Done when |
   |---|---|---|---|---|
   | Reviews | "<reviewed> of <total> reviewed" | "<N> failed" (warning-fg) and "<N> citations passed" or "<f> of <N> citations failed the check" (warning-fg). While the analyzers run, `LiveJobProgress` for `audits.runId` | the Investigations tab | Every review finished and none failed |
   | Decide | "**<N> to decide** · <a> accepted", "**All decided** · <a> accepted" or "No findings yet" | | the Findings tab | No finding is proposed |
   | Fix in a revision | "<n> of <m> package fixes" (accepted package fixes that are in a revision that can still take them, of all accepted package fixes), "No package fixes", or "<m> accepted package fixes" when the revisions couldn't be read | "<k> in no revision yet. The rest are queued, not applied." (warning-fg) when some are in none; "Queued only: applied after edits, a save and the plan" when all are in a revision; "All applied to the space" when every one's plan was applied. Under the cell, "Add to a revision…" (outline, xs) when the viewer holds `revisions.build` and some are in none | the Findings tab, State Accepted, Fix "Accepted and not in a revision" when some are in none, else "Package fixes" | Every accepted package fix is in a revision, or there are none, or the revisions couldn't be read |
   | Report | "Built · <N> sections" or "Not built". N counts the sections the saved report holds: the ones shown, less narratives with no text yet | "<k> sections with no text yet, left out of the record" | the Report tab | The report is built |
   | Record | "Saved · <short commit>" or "Not saved" | | the Report tab's "Save the audit record" card | The record is saved |

   A running audit is at Reviews; a saved one is at Record; a cancelled audit has no current step. The analyzers' counts, the failed and waiting reviews, the findings by state, the citation check by review and the model's tokens are in the "Details" disclosure under the strip, so nothing the old tiles showed is lost.

5. **Callouts** (at most three, most severe first):

   | When | Tone | Title | Body | Action |
   |---|---|---|---|---|
   | Items failed | warning | "<N> review(s) failed" | Per item, up to three: "<ID> stopped at the step limit (<N> steps) before it returned a result." / "<ID>: the output didn't match the profile's schema." / "<ID>: <model error as a plain sentence>." Then "Rerun it, or leave it out: the report counts only accepted findings." | "Rerun review" |
   | Audit cancelled | neutral info | "This audit was cancelled" | "Cancelled <Time> by <name>. <N> reviews had finished; their findings are kept." | none |
   | Accepted package fixes in no revision (all tabs; when the report is ready, the title starts "Ready to save the record, but ") | warning | "<N> accepted package fixes are in no revision" | "A package fix is only made in a revision. Until you add them to one, they won't reach the agent." When ready: "You can still save the record: a person may decide a fix won't be made." (saving is never blocked by this). Then the queued sentence below | "Add the <N> fixes to a revision…" (the dialog below; needs `revisions.build`) and, when ready, "Open the Report tab". Beside the text from 1280 px, under it below |
   | Ready to save the record (hidden on the Report tab) | success | "Ready to save the record" | "Every investigation is reviewed and every finding has a decision: <a> accepted, <r> rejected. Build the report, then save the audit record on the Report tab. Saving it changes nothing in the Agent Space." Then the queued sentence | "Open the Report tab" |
   | Fixes queued and none in no revision | info | "Accepted fixes are queued, not applied" | The queued sentence | none |
   | Record saved | success | "Record saved <Time> by <name>" | "Commit <short hash, copyable> in <folder> on <branch> of <repository>: audit.json, findings.json and report.md." Then the push result ("Pushed to <remote>", "Local only: this repository has no remote", or the push error) and "Findings and the report can't change. Nothing in the Agent Space changed." | none |

6. **Tabs as links** (`LinkTabs`): "Investigations <items>", "Findings <findings>", "Report".

   **The queued sentence** says plainly that accepting is not applying: "Accepting a fix doesn't apply it. A fix in a revision is only queued: it reaches the agent after someone edits the files in the revision, saves, and applies its plan. Still waiting: <revision> (<state>; <n> fixes of this audit), …". Each revision is a link, with its state in words (`revisionStage()` in `src/server/audits/revision-stage.ts`): "no saves yet", "saved, no plan yet", "planned: the plan is <state>" or "being created"; one that was applied, abandoned or failed isn't listed. A fix "of this audit" is an accepted package fix of this audit that the revision holds.

## Investigations tab

**Toolbar:** a `ToggleGroup` in URL params (`?show=`): "All <N>", "With proposed findings <N>", "Citation problems <N>", "Failed <N>"; and a text filter "Filter by incident or title".

**Table:**

| Column | Content |
|---|---|
| Incident | The incident ID in mono, linked to `audit-item.md`; the investigation title below in muted 12 px (from the journal task, untrusted plain text) |
| Score | The first `fields` value the profile marks as the score (`scorecard.score`), right-aligned. Empty when the profile has none |
| Review | `StatusBadge`: "Reviewed" (success, Check), "Reviewing" (info, Loader), "Waiting" (neutral, Clock) for pending and analyzing, "Failed" (destructive, CircleX) with the short reason below, "Skipped" (neutral, CircleMinus) with `stateReason` below |
| Citation check | "Passed" (success) with "<N> citations" below, or "<N> failed" (warning, TriangleAlert) with "of <N> citations". "Not checked" when there is no review output |
| Primary failure mode | The current diagnosis finding's `primary_failure_mode`, as its `failureModes` label. "No result" when the review failed |
| Findings | "<a> accepted, <p> proposed, <r> rejected", leaving out zero counts; the proposed count in bold. "None" when the review failed |

- Order: incident ID ascending. All rows show (the audit limit is 500), with "Show more" after 50.
- A rerun replaces `currentReviewId`; the row shows the current review only. Older reviews are on the incident page.

## Findings tab

A filter toolbar, then the list and the detail side by side, then the record card. The selected finding is in the address, `?finding=<id>`, so a link to one finding opens the tab with it selected (the revision page links here). Without it the first finding in the list is selected; an address with a finding and no `state` shows every state, so the finding is in the list whatever its state. A selected finding the filters leave out stays in the list, under a note, until another is picked. After a decision the finding stays selected, so the person reads who decided and what happens next; J moves on to the next proposed finding.

**Toolbar** (MASTER "Filters", URL params): "Kind" (the profile's `findings` labels), "State" (Proposed, Accepted, Rejected, All; default Proposed while the audit is in review, All once its record is saved), "Failure mode" (the profile's `failureModes` labels), "Fix owner" (`fixOwners` labels), "Next step" (All, Package fixes, Accepted and not in a revision; shown when a fix owner changes the package), and a text filter over titles, values and incident IDs. Changing a filter drops the selection.

**Layout.** From 1024 px the area is as tall as the window below the top bar (`100dvh` − 88 px, at least 32 rem), 340 to 400 px of list and the rest detail, and the list and the detail body each scroll on their own, so the page doesn't grow with the findings. Below 1024 px they stack: the list is at most 60% and the detail at most 85% of the window height. Moving the selection keeps its row in view inside the list and doesn't scroll the page.

### The list

- A header: "Findings <N>" and, when there are accepted package fixes in no revision and the viewer holds `revisions.build`, "Add the <N> accepted package fixes to a revision…" (outline, GitBranch; the dialog below).
- Groups by incident, in incident order. A sticky group header: the incident ID in mono linked to `audit-item.md`, "<N> findings, <P> proposed" and "<F> with a failed citation", and on the right the bulk accept: "Accept <N>" when every proposed finding in the incident passed the check, "Accept the <N> without problems" when some failed, hidden when none qualify. It accepts in one transaction, records one audit event per finding and shows a toast "Accepted <N> findings in <ID>". It never accepts a finding with a failed citation nobody has checked.
- A finding row is a link, `aria-current` when selected (a 3 px bar at the left in foreground and a 5% tint, as in the plan page). Line 1: the kind and the owner (or the failure mode) in a muted uppercase 11 px line, then a TriangleAlert when a citation failed and wasn't checked, "Edited" when edited, and the state chip. Line 2: the title in two lines at most (`line-clamp-2`); the detail shows the rest.
- Footer: "<N> proposed findings in <M> incidents. Bulk accept leaves out findings with a failed citation nobody has checked." and "Show <N> more" after 50 rows.

### The detail

A header bar (it doesn't scroll): "<Kind> <i> of <n> for <incident ID> · Owner: <owner label>" (sentence case, the incident ID linked to `audit-item.md`; "Fix 2 of 3 for INCIDENT-20101", "Diagnosis for INCIDENT-20101") and, under or beside it, the decision buttons. Under it, scrolling:

1. The state chip, "Edited" and "<N> citations failed" when any. **Kept apart from the buttons.**
2. The finding's title with none of its text cut off (`h2`, 16 px). The stored title is cut at 300 characters for lists; the detail rebuilds it from the title template.
3. A definition list of the finding's fields with the profile's labels (`fieldLabels`, `valueLabels`), the way the incident card shows them. A field that is a list of citations is the Evidence section. In Edit mode the list becomes the edit form (`audit-item.md`, "Edit").
4. **Evidence** with a summary chip ("<N> citations passed", "<f> of <N> failed the check", "<N> failed citations checked by a reviewer") and a help line, "R<n> is record <n> of this investigation's journal. Press a record number to read it here, under its row." One row per record and quote: the citation chip "R<n>" (blue, underlined, pointer cursor; it opens the record), the quoted text in full, and the check result under it ("The quoted text is in R12." with CircleCheck, or the reason it failed with TriangleAlert, or "Checked by <name>: <note>"). A failed, unchecked citation offers **I checked the record** (outline, sm, Check; it also opens that record, so the note and the record are side by side).
   **The record opens under the row that was clicked**, as the incident page's journal record card (plain text, the quoted text marked, R<n−1> and R<n+1>, "Open in journal", and **Close**, which returns focus to the chip). It scrolls into view with the least movement (`scrollIntoView({ block: "nearest" })`, instantly with reduced motion) in the detail and the page, each time a chip or O opens it. R<n−1> and R<n+1> keep it under the same row. Saving a check keeps the same record open. O opens the first citation that failed and nobody checked, else the first one.
5. **What happens next** (below).
6. A keyboard line, "Keyboard: A accept · E edit · R reject · J next proposed · K previous · O open a record" and the "Single keys on" switch of the incident page (the same setting).

### Decision buttons

One shared component, `DecisionButtons`, also used by the incident page's finding cards (`audit-item.md`). A proposed finding shows three outline buttons joined in one group: **Accept** (success border and text, Check, key A), **Edit** (neutral, SquarePen, key E; only when the profile lets the viewer edit it) and **Reject** (destructive border and text, X, key R; it opens the note form under the header, "Why, for the record", then "Reject"). A decided finding shows "Accepted by <name>, <Time>" or "Rejected by <name>, <Time>" and "Change decision" (outline, Undo2). A finding with a failed citation adds "Accepting keeps the flag in the record." Each button has an accessible name with the finding's title.

### What happens next

A dashed card under the evidence. `nextStepFor()` (`src/server/audits/next-step.ts`) decides the text and the one action. The finding's kind of fix comes from its `owner` field and the profile's `fixOwners`: an owner with `changesPackage` (and a `linkable` kind) is a **package fix**; any other owner is an **action for people**; a finding with no owner (a diagnosis) is **recorded**.

| Finding | Proposed | Accepted | Rejected |
|---|---|---|---|
| Recorded (a diagnosis) | "Accepting records it and counts it in the report. Nothing else changes." | "Recorded. This finding is counted in the report." | |
| Action for people | "Accepting lists it in the report as an action for <owner>. It doesn't change the package." | "Listed in the report as an action for <owner>. It doesn't change the package, so there is nothing to add to a revision." | |
| Package fix | "Accepting only queues it with the package fixes. It doesn't change the agent. It is a package fix (<owner>), so it is made in a revision: a copy of the package. Someone edits the files there, saves with this finding linked, and applies the revision's plan to the space." Button **Accept and add to revision…** | Not in a revision: the same sentence, then "It isn't in one yet. Accepting it didn't change the agent." and **Add to revision…**. In one: "Queued in a revision, not applied yet. A fix in a revision is only queued: it reaches the agent after someone edits the files in the revision, saves, and applies its plan." and the revisions, each a link; "Applied. The plan of its revision was applied to the space." once every one was applied | |
| Any | | | "Rejected. It is left out of the report, and no revision takes it." and "Why: <note>" |

Each revision a package fix went to is a row: its name (a link to the revision) and where the finding stands in it, in words (`linkStageWords()`): "Not made yet: no save has addressed it", "Made in a save, no plan yet", "Planned: the plan is <state>", "Applied to the space", "The revision is being created", "The revision was abandoned" or "The revision couldn't be created"; then "Open the plan" and "Release <name>" links when they exist. A revision that was abandoned or failed doesn't count as one; the finding offers "Add to revision…" again. A viewer without `revisions.build` sees no button and the line "Someone who can build revisions adds it to one." A viewer who can accept but not build sees "You can accept it here. Someone who can build revisions adds it to one afterwards." When the revisions can't be read the card says so and offers nothing.

**The "Add to revision…" dialog** (`Dialog`): "Add this fix to a revision" (or "Accept this fix and add it to a revision", or "Add <N> package fixes to a revision" for the bulk buttons, which list the fixes). It says that a revision is a copy of the package where the fix is made, that adding only queues the fix on its to-address list, that it reaches the agent after someone edits the files in the revision, saves, and applies its plan, and that nothing changes in the Agent Space until then. A radio list of the open revisions, newest first, then "Start a new revision" with a name (checked against the revision name rule from policy, with its hint) and an optional note. **Which one is selected:** the revision that holds the most findings of this audit (`defaultChoice()` in `src/components/audits/revision-choice.ts`), else "Start a new revision"; an unrelated revision is never preselected. **Each revision says what it is:** its name and state in words ("No saves yet", "Saved, no plan yet", "Planned: the plan is <state>", "Being created"), "Started from <the live space or release name> by <name> on <date>", "Findings from this audit (<n>), <other audit> (<m>)" or "No findings in it yet" (`revisionAuditSources()`, `src/server/revisions/sources.ts`, read through the revisions list), and "<n> waiting to be addressed, <m> addressed in saves". The button says "Add to <name>", "Accept and add to <name>" or "… to a new revision". A new revision is created from the live space by `createRevisionForFindings`; its create job runs in the worker. When accepting first succeeds and the revision then refuses, the message says the finding stays accepted.

### The record card

Under the split view, a short card, "Record": where "Save the audit record" will put the record (folder, branch and repository, from `audit-report.md`) and the push outcome to expect as a chip ("Pushes to <remote>", "Local only: this repository has no remote", "Local only: pushing is off for this repository"), with "Open the Report tab to save it". After the record is saved it reads "Record saved": the time and the person, the commit (short hash, copyable), the folder and branch, the three files, and "Pushed to <remote>", the push error, or why it stayed on this machine.

## States

| State | What shows |
|---|---|
| Loading | `loading.tsx`: header skeleton, the strip, tabs, ten table rows. The Findings tab has its own: a filter bar and the list and detail as blocks |
| Running, nothing reviewed yet | Investigations table with "Waiting" and "Reviewing" badges; Findings tab `EmptyState` "No findings yet", body "Findings appear as each review finishes." |
| No proposed findings left | Findings tab with State Proposed: `EmptyState` "Every finding has a decision", body "<a> accepted and <r> rejected." (and "<N> accepted package fixes aren't in a revision yet." when so) "Build the report next.", action "Open the report" |
| Filters match nothing | `EmptyState` "No findings match these filters", action "Clear filters" |
| Record saved | Decisions are read only: no Accept, Edit, Reject, Change decision, Rerun or Cancel. "Add to revision…" still works for an accepted package fix. The "Record saved" callout shows |
| Read only (Viewer) | Same list and detail; the decision line says who decided, but there are no buttons, no bulk buttons, no header actions and no "Add to revision…" |
| Audit not found | `notFound()` |

## Permissions

| Action | Permission |
|---|---|
| See the audit, tabs, list and detail | `audits.read` |
| Accept, edit, reject, change decision, bulk accept | `findings.review` |
| Rerun failed reviews, cancel | `audits.run` |
| Add to revision…, start a revision with findings | `revisions.build` |
| Accept and add to revision… | `findings.review` and `revisions.build` |

## Audit log

`finding.accept`, `finding.reject` (with the note), `finding.reopen`, `finding.edit`, `finding.accept-all` (incident, count, finding IDs), `finding.citation.check`, `audit.rerun` (items), `audit.cancel`. The revisions module records adding findings to a revision and creating one with findings.

## Data

- `loadAuditDetail`: header fields, counts for the strip and "Details", callout inputs (failed items with reasons, cancel and record info), and the profile snapshot's labels.
- `loadFindingsQueue`: every finding of the current reviews with its tags, citation summary and state; the page filters, groups and pages it.
- `loadFindingDetail(space, auditId, findingId, viewer)`: one finding with the profile's labels, its full title, its citations and the viewer's actions. It doesn't read the journal; a record is read on demand through the records route.
- `loadFixContext(spaceId, auditId, profile, { canBuild })`: each finding's kind of fix, where the package fixes went (`findingRevisionLinks`), the open revisions (`listRevisionOptions`, only with `revisions.build`) and the progress for the strip. Read once per request. When the revision calls fail it says so and the page still renders.
- `loadRecordInfo(space, audit, layout)` (`src/server/audit-reports/record.ts`): the facts of "Save the audit record" before and after it.
- Service functions: `reviewFinding`, `acceptAllProposed`, `checkCitation`, `rerunItems`, `cancelAudit`; `addFindingsToRevision` and `createRevisionForFindings` from `src/server/revisions`, through the `addToRevisionAction` Server Action.

## Components

`PageHeader`, `FlowStrip`, `StatusBadge`, `Callout`, `LinkTabs`, `LiveJobProgress`, `EmptyState`, `Time`, the filter toolbar (`AuditFilters`), shadcn `Card`, `Dialog`, `AlertDialog`, `Switch`. Local to the audit pages: `FindingsWorkspace`, `DecisionButtons`, `NextStepPanel`, `AddToRevisionDialog`, `RecordSummary`, `CopyCommit`.

## Open items

- **Score column.** The profile has no field that says which `fields` entry is the score. This page assumes `scorecard.score`. The audits module could add an optional `scoreField` to the profile.
- **Title for the incident.** The investigation title comes from the journal task. Confirm the audits module returns it with the item.
