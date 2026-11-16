# Page: Space home

Overrides `MASTER.md` for `/spaces/[alias]`. Code: `src/app/(app)/spaces/[alias]/page.tsx`. Screens: the home page in light and dark, and at 1024, 768 and 390 px.

## Layout, top to bottom

1. **Top bar:** breadcrumb "<space name> › Home"; right side `SyncStatus` and "Sync now" (needs `sync.run`).
2. **`PageHeader`:** title is the space display name. Meta line: "<environment> space · <region> · account <accountId as 1111-2222-3333> · history in <repo name in mono>". The environment comes from the optional `environment` space setting (see MASTER, "Supporting pieces the shared components rely on"); leave out "<environment> space" when it is unset. No header actions.
3. **Attention callouts:** zero to three `Callout`s (rules below).
4. **Stat tiles:** four `StatTile`s.
5. **Two columns:** "Recent changes" on the left; "Who made changes" and "Releases" on the right.

## Attention callouts

Show at most three, in this order. Each one appears only while its condition holds.

| Condition | Tone | Title | Body | Action (permission) |
|---|---|---|---|---|
| Last sync failed | destructive | Last sync failed | The error message, then "History may be missing changes since <Time>." | "Sync now" (sync.run) |
| Connection test failed | destructive | Can't reach this space | "<failed step>: <error name>." | "Test connection" (spaces.manage) |
| No sync has finished | info | Not synced yet | "Assets and history appear after the first sync." | "Sync now" (sync.run) |
| History repo has unpushed commits and push is off | warning | History is only on this machine | "<N> commits in <repo> are not pushed." | "Repository settings" (spaces.manage) |
| Changes inside the CloudTrail lookup window have source Unknown | info | <N> recent changes have no known source | "The CloudTrail lookup found no event for them. Check that the read role can call LookupEvents." | "Show these changes" (opens History filtered to Unknown) |

Differences from the first design, on purpose:

- The first design's repo callout said the repository was meant for one customer's history only and offered "Move to a test repository". That copy fit one test space. The general rule is unpushed commits. The "change a space's history repository" action is a separate open decision.
- The first design flagged all 33 unknown changes. Those are older than the 90-day CloudTrail window, so they are expected and nothing can be done about them. Flag only unknown changes inside the window, which point to a real lookup problem. The "Who made changes" card explains the old ones.

The unpushed count comes from a `HistoryRepo` method that counts local commits ahead of the remote branch.

## Stat tiles

| Tile | Icon | Value | Detail | Action |
|---|---|---|---|---|
| Connection | Plug | "Connected" with CircleCheck, or "Connection failed" with CircleX | "Connected when checked at <Time>, using <the AWS profile, its roles, or this app's own AWS credentials>." While the space can't be reached, only "Failed at <Time>": the "Can't reach this space" callout is the one place for the cause, the next step and "Test connection" | none |
| Last sync | RefreshCw | `RelativeTime` of the last completed sync | "Every <interval> min · <total> changes recorded" | none |
| Live assets | Layers | count of live assets | breakdown in console order and words: "1 instruction file, 4 skills, 3 memory stores, 9 memories, 3 artifacts" | none (the Assets nav item covers it) |
| Journals | NotebookText | cached investigations | "No investigations cached yet", or "Last export <Time>" | "Export journals" (journals.export) |

## Recent changes

Use `ChangeFeed` with the filter toolbar (Source, Type, date range, name). On Home the date range defaults to "Last 30 days" and the feed stops at 20 rows or groups, followed by "Show older changes". That button opens History with the same filters in the URL. The "Open history" link sits in the card header.

**Day headers.** `Time format="day"` ("Monday, Nov 10"), in the viewer's time zone.

**Grouping.** Group consecutive changes (newest first) when there are three or more that share a source, the same parent (memory store) or, with no parent, the same asset type, and fall on the same day within 15 minutes of the group's first change. One Learning-agent run usually forms one group.

- Group title, one pattern for every group: "<N> changes in <parent>" ("4 changes in chat-tool-use-best-practices"), or "<N> changes to <type plural>" when the changes have no parent ("3 changes to skills").
- Group detail line: what happened, then the names: "4 updated: <first two names> and 2 more", or "2 created, 3 updated: ..." when kinds differ. The full list of names when it is three or fewer.
- Group action: "Show all <N>" expands the rows inline (`Collapsible`, with `aria-expanded`).
- A group has no version badge; only a single change shows one.

**Row content.**
- Left: `SourceBadge`, with the principal in its tooltip.
- Title: the asset-type icon, the name linked to the asset page, and a `VersionBadge` ("new" for created, "deleted" for deleted, otherwise `v<N>`).
- Detail line: "<Type> in <parent> · <what happened>". For console and CLI changes it names the principal without the role's unique ID (full value in a tooltip) and the long policy label ("alex-Admin in the Operator Web App"; the chip says "Web app" to match). For agent changes it says "created by the DevOps Agent" or "content updated by the DevOps Agent". When a reason exists, the detail line ends with "Reason: <text>". The detail line wraps to two lines, so who made the change stays readable at 1440 px without opening History.
- Right: `Time format="time"`, then the actions.

What happened, by kind:

| Kind | Text |
|---|---|
| created | created |
| content | content updated |
| metadata | status or metadata changed, version unchanged |
| deleted | deleted |
| baseline | first recorded at v<N> |

Row actions (28 px ghost buttons):

| Action | Shown when | Goes to |
|---|---|---|
| Diff | kind is content or metadata | the asset's Versions tab comparing the previous version with this one |
| View | kind is created or baseline | the asset page |
| Add reason | the user has `reasons.write` and the change has no reason | the existing add-reason form |

## Who made changes

Scope is all recorded changes for the space; the header reads "All <N> recorded". One row per source in the fixed order of the source table in MASTER, including zero counts, so every space reads the same way. Each row has a `SourceBadge`, a bar at the source token (width = share), and "<count> · <percent>%", with the percent left out for zero. Footnote when Unknown is above zero: "AWS keeps a record of who made each change for 90 days. Changes marked Unknown are older than that." (the number of days comes from policy)

## Releases

- **No release yet:** `EmptyState` "No releases yet" with "A release pins every asset's version and status, so a rollback has a fixed target."
- **With a release:** the latest release's name, `Time`, "<N> changes since this release", and "Compare with live".
- **"Create release"** (in "No releases yet"): hidden for roles without `releases.create`, which see the `RoleNote` ("You're a Viewer, so you can look but not create releases. ...", with "See who has each role"). While `connectionView` is `failed` or `rejected` it is disabled through `DisabledReason`: "A release starts with a sync, and the app can't reach the space. <cause>" plus `ConnectionNextStep` when the cause needs Space settings.

## Data

- Existing: `getSpaceOverview(spaceId)` (sync state, asset counts, investigation count), `getHistoryRepoForSpace`, `parseConnectionDetail`.
- Added for this page: the `FeedItem` query (filters: sources, types, since, name, limit), counts by source, and the unpushed commit count.
- Keep the page a server component. Only `SyncStatus`, the filter menus and the group expanders are client components.
