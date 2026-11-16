# Page: Plans list

Overrides `MASTER.md` for `/spaces/[alias]/plans`. Screen (example data): the plans list. One plan opens `plan-review.md`.

## Layout, top to bottom

1. **Top bar:** breadcrumb "<space name> › Plans"; `SyncStatus` on the right.
2. **`PageHeader`**, shared with the Drafts page (`drafts.md`): title "Plans", the same description, and "Import package" (outline, `plans.create`).
3. **Tabs as links:** "Plans <open plans>" (current) and "Drafts <open drafts>".
4. **Card:** filter toolbar, table, footer.

"New plan" is not on this page: plans start from the Drafts tab, a release rollback (`releases.md`) or a package import (`package-import.md`).

## Filters

A toolbar in the MASTER "Filters" pattern, with state in URL search params:

| Filter | Values | Default |
|---|---|---|
| Status | Open (checking, ready, waiting, approved, applying), Closed (applied, failed, discarded), All | Open |
| Origin | All, Drafts, Rollback, Package import, Retry of a failed plan | All |
| Title | Free text `Input` "Filter by plan title" | empty |

## Table

| Column | Content |
|---|---|
| Plan | Bold title linked to the plan page, over the origin line in muted 12 px. The origin line is left out when it repeats the title (a version restore is titled "Restore <name> to v<N>") |
| Status | The header badge from the `plan-review.md` states table (tone and icon), for example "Waiting for approval" with Clock |
| Changes | Items that will be written (not skipped or unchanged), right-aligned. Before a check: "Not checked". When an open plan's check failed before comparing anything, the count against the last synced version (as on the plan page), with "vs last synced version" under it in muted 12 px |
| Author | Name |
| Updated | `Time`, right-aligned |

Origin line by `PlanOrigin.kind`:

| Kind | Text |
|---|---|
| `drafts` | "From <N> drafts" |
| `rollback`, release | "Rollback to release <name>" |
| `rollback`, commit | "Rollback to commit <short hash>" |
| `rollback`, version | "Restore <asset name> v<N>" |
| `package` | "Package import" (the file name is in the title) |
| `retry` | "Retry of <plan title>" |

- Order: updated time, newest first. Over 50 rows, "Show more".
- With Status "Open", the footer offers "Show <N> closed plans", which sets Status to All.
- While any visible plan is checking or applying, a small client component calls `router.refresh()` every 10 s and stops when none remain. No spinner beyond the badge.

## Empty states

| Filter | Title | Body | Action |
|---|---|---|---|
| Open, none open, drafts exist | "No open plans" | "<N> drafts are waiting. Select them on the Drafts tab to create a plan." | "Open drafts" |
| Open, none at all | "No plans yet" | "Plans are created from drafts, a release rollback or a package import. Nothing is written to the space without one." | "Open drafts" |
| Filters match nothing | "No plans match these filters" | "Clear the filters to see every plan." | "Clear filters" |

## Permissions

The page needs `assets.read`. "Import package" needs `plans.create` and is hidden without it. The page has no writes.

## Audit log

None. Plans are created on the Drafts, rollback and import screens.

## Data

A loader returns the plans with status, origin, item counts, author and updated time, filtered by the URL params. It also returns the open plan count and the open draft count for the tabs.
