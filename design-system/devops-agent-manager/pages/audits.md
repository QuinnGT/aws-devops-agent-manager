# Page: Audits list

Overrides `MASTER.md` for `/spaces/[alias]/audits`. Screens (example data, shortened): the audits list and the empty state when there are no audits (each in light and dark).

One audit opens `audit-detail.md`. "New audit" opens `audit-new.md`.

## Layout, top to bottom

1. **Top bar:** breadcrumb "<space name> › Audits"; `SyncStatus` on the right.
2. **`PageHeader`:**
   - Title "Audits".
   - Description: "An audit reviews a set of investigations. You accept, edit or reject each finding, send accepted package fixes to a revision, then build a report and save the audit record."
   - Action: "New audit" (primary, CirclePlus, `audits.run`), a link to `/spaces/[alias]/audits/new`.
3. **Card:** filter toolbar, table, footer.

## Filters

MASTER "Filters" pattern, state in URL search params:

| Filter | Values | Default |
|---|---|---|
| State | Open (draft, running, reviewing), Record saved, Cancelled, All | Open |
| Profile | All, then each profile's `label` from `policy/audits.yaml` | All |
| Name | `Input` "Filter by audit name" | empty |

## Table

| Column | Content |
|---|---|
| Audit | Bold name linked to the audit page, over the profile `label` in muted 12 px |
| State | `StatusBadge` from the state table below. While running, a second line in muted 12 px: "<done> of <total> reviews" |
| Investigations | `audit_items` count, right-aligned. A draft with none yet: "Not chosen" in muted text |
| Accepted, Proposed, Rejected | Finding counts by `findings.state`, three right-aligned columns. Zero shows as a muted 0 |
| Created by | Name (`audits.createdBy`) |
| Created | `Time`, right-aligned |

Order: created, newest first. Over 50 rows, "Show more". With State "Open", the footer offers "Show <N> cancelled audits" or "Show <N> audits with a saved record" when there are any.

**States** (`AUDIT_STATES` in `src/server/db/schema/audits.ts`). Add these as `STATUS` presets in `status-words.ts`:

| State | Tone | Icon | Word |
|---|---|---|---|
| `draft` | neutral | SquarePen | Draft |
| `running` | info | Loader (motion-safe spin) | Running |
| `reviewing` | warning | ListChecks | In review |
| `finalized` | success | CircleCheck | Record saved |
| `cancelled` | neutral | CircleX | Cancelled |

"In review" uses the warning tone because a person has work to do, the same reason "Waiting for approval" does. Once every investigation is reviewed and every finding decided, an audit in review reads "Ready to save the record" (success, CheckCheck). The state is still `finalized` in code and in the database; people read "Record saved", because nothing in the Agent Space changes when the record is saved. An audit draft is neutral, unlike the info-tone `STATUS.draft` for asset drafts, so that info stays free for "Running" in the same column.

While any visible audit is running, a small client component calls `router.refresh()` every 10 s and stops when none remain (the plans list pattern).

## States

| State | What shows |
|---|---|
| Loading | `loading.tsx`: `HeaderSkeleton`, then a toolbar row and six table rows of `Skeleton` |
| No audits | `EmptyState` "No audits yet", body "Start one to review a set of investigations against their confirmed root cause. You need cached journals for them and, for the benchmark profile, a confirmed root cause and a scorecard per incident.", action "New audit" (only with `audits.run`) |
| No journals cached | Same title; body ends "No investigations are cached yet." and the action is "Export journals" (`journals.export`) instead |
| Filters match nothing | `EmptyState` "No audits match these filters", body "Clear the filters to see every audit.", action "Clear filters" |
| Policy has no profiles | Not reachable: the policy section requires at least one profile |
| Read only (Viewer) | The same table. "New audit" is hidden |

## Permissions

| Action | Permission | Without it |
|---|---|---|
| See the page and the nav item | `audits.read` | Nav item hidden (MASTER) |
| New audit | `audits.run` | Button hidden |

Viewers read audits and reports. Editors run audits and review findings. Publishers and Admins have both through `inherits`.

## Audit log

None. The page has no writes.

## Data

A loader in `src/server/audits/` returns, per audit: id, name, profile ID and label (from `profileSnapshot`, or from policy for a draft), state, item count, reviews done and total while running, finding counts by state, created by and at. It applies the URL filters and returns the open, finalized and cancelled counts for the footer.

## Components

`PageHeader`, `StatusBadge`, `Time`, `EmptyState`, the filter toolbar pattern from `feed-filters.tsx` (`MultiSelect`), shadcn `Table`.
