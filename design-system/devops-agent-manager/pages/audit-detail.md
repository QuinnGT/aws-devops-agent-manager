# Page: Audit detail, Investigations and Findings tabs

Overrides `MASTER.md` for `/spaces/[alias]/audits/[auditId]` (Investigations, the default tab) and `/spaces/[alias]/audits/[auditId]/findings`. The Report tab is `audit-report.md`; one incident is `audit-item.md`; a draft audit renders `audit-new.md`. Screens: the Investigations tab and the Findings tab (each in light and dark).

## Shared header (all three tabs)

1. **Top bar:** breadcrumb "Audits › <audit name>" (plus "› Findings" or "› Report" on those tabs); `SyncStatus`.
2. **Title block** (the asset page header pattern): icon box with Microscope, `h1` the name, the state `StatusBadge` (`audits.md` states). Description: `audits.note` when set (72 characters per line). Meta: profile label · "Started <Time> by <name>" · "Model <modelId in mono>".
3. **Actions**, right side:

   | Action | Shown when | Permission |
   |---|---|---|
   | "Review next incident" (primary, ListChecks) | `reviewing` and any finding is proposed. Opens the first incident with proposed findings, in table order | `findings.review` |
   | "Rerun <N> failed reviews" (outline, RefreshCw) | Any item is `failed` | `audits.run` |
   | "Cancel audit" (ghost) | `running`. `AlertDialog`: "Cancel <name>? Reviews in progress stop after their current step. Finished reviews and findings are kept." | `audits.run` |

4. **Stat tiles** (`StatTile`, four across):

   | Tile | Value | Detail |
   |---|---|---|
   | Analyzers | "<done> of <total>" with CircleCheck when complete | The analyzer names and the investigation count |
   | Reviews | "<done> of <items>" | "<N> failed" in destructive-fg when above zero · "<concurrency> at a time" · input tokens summed from `model_calls` |
   | Findings | "<N> accepted" | "<N> proposed · <N> rejected · <N> in all" |
   | Citation check | "<N> passed" (reviews whose `citationCheck.ok`) | "<N> reviews cite records that failed the check", warning-fg count |

   While `running`, the Reviews tile replaces the detail with `LiveJobProgress` for `audits.runId`, and the page refreshes every 10 s until the state changes.
5. **Callouts** (at most three, most severe first):

   | When | Tone | Title | Body | Action |
   |---|---|---|---|---|
   | Items failed | warning | "<N> review(s) failed" | Per item, up to three: "<ID> stopped at the step limit (<N> steps) before it returned a result." / "<ID>: the output didn't match the profile's schema." / "<ID>: <model error as a plain sentence>." Then "Rerun it, or leave it out: the report counts only accepted findings." | "Rerun review" |
   | Audit cancelled | neutral info | "This audit was cancelled" | "Cancelled <Time> by <name>. <N> reviews had finished; their findings are kept." | none |
   | Finalized | success | "Finalized <Time> by <name>" | "The record is in <repository>, commit <short hash in mono>. Findings and the report can't change." | none |

6. **Tabs as links** (`LinkTabs`): "Investigations <items>", "Findings <findings>", "Report".

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

**Toolbar** (MASTER "Filters", URL params): "Kind" (the profile's `findings` labels), "State" (Proposed, Accepted, Rejected, All; default Proposed while the audit is in review, All once finalized), "Failure mode" (the profile's `failureModes` labels), "Fix owner" (`fixOwners` labels), and a text filter over titles and values.

**Table,** grouped by incident (group header rows in the release-preview style):

- **Group row:** the incident ID in mono linked to `audit-item.md`, then "<N> proposed" and, when any, "· <N> with a failed citation". On the right, the bulk action (below).
- **Finding rows:**

  | Column | Content |
  |---|---|
  | Finding | Bold title (the extractor's title template, filled; untrusted plain text), the kind label below |
  | Failure mode or owner | A diagnosis's primary failure mode label, or a fix's owner label |
  | Citations | "<N> passed" (success) or "<f> of <N> failed" (warning) |
  | State | `StatusBadge`: "Proposed" (info, Clock), "Accepted" (success, Check), "Rejected" (neutral, X); "Edited" as a neutral badge next to it when `edited` |
  | Actions | "Accept" and "Reject" (ghost) for a proposed finding without citation problems; "Review" (opens the incident at that finding) when a citation failed or the finding has editable fields that are empty |

**Bulk accept, per incident.** "Accept <N>" when every proposed finding in the group passed the check; "Accept the <N> without problems" when some failed; hidden when none qualify. It accepts in one transaction, records one audit event per finding, and shows a toast "Accepted <N> findings in <ID>". It never accepts a finding with a failed citation: those need a person to open them.

Footer: "<N> proposed findings in <M> incidents. Bulk accept leaves out findings with a failed citation." and "Show more" after 50 rows.

**Rejecting** from this table opens a small `Popover` with an optional note ("Why, for the record") and "Reject". The note is `reviewNote`.

## States

| State | What shows |
|---|---|
| Loading | `loading.tsx`: header skeleton, four stat tiles, tabs, ten table rows |
| Running, nothing reviewed yet | Investigations table with "Waiting" and "Reviewing" badges; Findings tab `EmptyState` "No findings yet", body "Findings appear as each review finishes." |
| No proposed findings left | Findings tab with State Proposed: `EmptyState` "Every finding has a decision", body "<a> accepted and <r> rejected. Build the report next.", action "Open the report" |
| Filters match nothing | `EmptyState` "No findings match these filters", action "Clear filters" |
| Finalized | Read only: no Accept, Reject, Rerun or Cancel. The finalized callout shows |
| Read only (Viewer) | Same tables, no actions column, no bulk buttons, no header actions |
| Audit not found | `notFound()` |

## Permissions

| Action | Permission |
|---|---|
| See the audit, tabs and tables | `audits.read` |
| Accept, reject, bulk accept | `findings.review` |
| Rerun failed reviews, cancel | `audits.run` |

## Audit log

`finding.accept`, `finding.reject` (with the note), `finding.bulk-accept` (incident, count, finding IDs), `audit.rerun` (items), `audit.cancel`.

## Data

- `getAudit(spaceId, auditId)`: header fields, counts for the tiles, callout inputs (failed items with reasons, cancel and finalize info), and the profile snapshot's labels.
- `listAuditItems(auditId, filter)`: one row per item with the columns above.
- `listFindings(auditId, filter)`: grouped rows with citation summary, state, edited flag.
- Service functions: `acceptFinding`, `rejectFinding(note)`, `acceptFindings(auditId, incidentId)` (skips failed citations, returns the count), `rerunItems`, `cancelAudit`.

## Components

`PageHeader` (or the asset header pattern), `StatTile`, `StatusBadge`, `Callout`, `LinkTabs`, `LiveJobProgress`, `EmptyState`, `Time`, the filter toolbar (`MultiSelect`), shadcn `Table`, `ToggleGroup`, `Popover`, `AlertDialog`.

## Open items

- **Score column.** The profile has no field that says which `fields` entry is the score. This page assumes `scorecard.score`. The audits module could add an optional `scoreField` to the profile.
- **Title for the incident.** The investigation title comes from the journal task. Confirm the audits module returns it with the item.
