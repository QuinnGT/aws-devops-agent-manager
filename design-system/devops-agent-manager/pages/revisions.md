# Page: Revisions list and New revision

Overrides `MASTER.md` for `/spaces/[alias]/revisions`. One revision opens `revision-detail.md`. Data from `src/server/revisions/`. Screens (example data): the revisions list and its empty state (light and dark), and the new revision dialog (light and dark).

## Model

- A revision is a git branch `revision/<space-alias>/<branch name>` in the history repository, holding a package in the space's layout under `packages/<space-alias>/<branch name>/`.
- It starts from the live space (as of the last sync) or from a release.
- Each save is a commit that links to one or more accepted findings; the changelog is built from those links.
- Build and validation run on every save. "Create plan" turns the package into a plan against the live space through the package import mapping (`PlanOrigin` kind `revision`). Applying that plan tags a release.

## Layout, top to bottom

1. **Top bar:** breadcrumb "<space name> › Revisions"; `SyncStatus`.
2. **`PageHeader`:** title "Revisions", description "A revision is a package you edit on its own branch of the history repository. Each change links to accepted findings, and a plan applies it to the live space." Action "New revision" (primary, GitBranch, `revisions.build`).
3. **Card:** filter toolbar (State: Open (draft, build failed, ready, planned), Applied, Abandoned, All; default Open. Name filter), table, footer "Show <N> abandoned revisions".

## Table

| Column | Content |
|---|---|
| Revision | Bold name linked to the revision page, the branch in mono 12 px below |
| Based on | "Release <name>" as one link to the release page, or "Live space, <date>" (no wrap) |
| State | `StatusBadge` from the table below |
| Linked findings | Distinct findings linked by any save, right-aligned |
| Last build | "Passed" (success, Check) or "<N> errors" (destructive, CircleX), the build time below in muted 12 px. "Not built yet" for a revision with no save |
| Plan and release | The plan title as a link with its plan state below ("Waiting for approval"), then "Release <name>" as a link once applied. "No plan yet" in muted text |
| Updated | `Time` of the last save or state change, right-aligned |

Order: updated, newest first.

**States.** These are `STATUS` presets:

| State | Tone | Icon | Word | When |
|---|---|---|---|---|
| Draft | neutral | SquarePen | Draft | No save yet, or not built since the last save |
| Build failed | destructive | CircleX | Build failed | The last build has errors |
| Ready | success | CircleCheck | Ready | The last build passed and no open plan exists |
| Planned | info | GitPullRequest | Planned | A plan from this revision is open |
| Applied | success | GitMerge | Applied | The plan was applied and the release tagged |
| Abandoned | neutral | CircleX | Abandoned | A person abandoned it; the branch stays |

## New revision dialog

A `Dialog` (nothing is written to the space).

- **Title** "New revision"; **description** "Starts a package on its own branch of the history repository. Nothing changes in the space until a plan is applied."
- **Name:** `Input`, required, free text.
- **Branch name:** `Input` in mono, filled from the name as you type (lowercase, spaces to hyphens) until edited by hand. Help: "Letters, numbers, dots and hyphens. The branch is <full branch in mono>." Field errors: "A revision with this branch name already exists." / "Use letters, numbers, dots and hyphens." The rule goes in `policy/revisions.yaml`.
- **Start from:** a radio group of cards:
  - "A release", with a `Select` of releases ("v1.1 · Nov 2, 4:15 PM · 26 assets"), the latest selected. The default when any release exists.
  - "The live space", "As of the last sync, <RelativeTime>. <N> assets." When the sync is stale or failed (MASTER sync states), a warning line under it: "The last sync was <Time>. Sync first so the revision starts from what is live." with "Sync now" (`sync.run`).
- **Layout:** a `Select` of package layouts from the space's policy, its default selected. Help: "The base is written as a package in this layout: instructions, skills, memory, evaluation and reference folders."
- **Facts:** Folder (mono), Repository (mono).
- **Buttons:** "Cancel" and "Create revision" (primary, GitBranch). Creating runs a worker job (export the base as a package, commit, create the branch) and shows `JobProgress` in the dialog, then opens the revision page.
- **Disabled reasons:** "Enter a name." / "The history repository isn't set up for this space." (with a link to Space settings for Admins) / "There are no releases yet." (only disables the release option).
- **Width:** the form is one `minmax(0,1fr)` column, so a long release or layout label truncates in its `Select` instead of widening the dialog past 540 px.
- **Import mode** ("Fix in a revision" on an import, `package-import.md`): title "Fix in a revision"; description "Starts a revision from the live space with the files of <file name>. There you can edit the files, see each error and warning by file, and create the plan when the checks pass. Nothing changes in the space until a plan is applied."; the name prefilled from the file name (without `.zip`, other characters as hyphens); Start from is one fixed card "The live space, with the files of the import" with the last sync line and "Creating it syncs the space first, then adds the files of <file name> as the first save."; Layout is the import's, as text, with "The import was read with this layout, so the revision keeps it."

## States

| State | What shows |
|---|---|
| Loading | `HeaderSkeleton`, toolbar and six table rows |
| No revisions | `EmptyState` "No revisions yet", body "Start one from the live space or a release to edit the instruction package on its own branch. Accepted audit findings become the evidence in its changelog.", action "New revision" (`revisions.build`) |
| No accepted findings in the space | The same empty state, plus a muted line "No audit has accepted findings yet, so changes can't be linked. Start with an audit." linking to Audits |
| Filters match nothing | `EmptyState` "No revisions match these filters", action "Clear filters" |
| Create failed | Destructive callout in the dialog with the error and a next step; the form keeps its values |
| Read only (Viewer) | The table; "New revision" hidden |

## Permissions

| Action | Permission |
|---|---|
| See the page | `audits.read` (the nav table in MASTER) |
| New revision | `revisions.build` |
| Sync now in the dialog | `sync.run` |

## Audit log

`revision.create` (name, branch, base, layout).

## Data

- `listRevisions(spaceId, filter)`: name, branch, base (release name or live with time), state, linked finding count, last build result and time, the open or applied plan (ID, title, state), the release tagged at apply, updated time.
- Service function `createRevision({ name, branch, base, layoutId }, actor)` enqueues the worker job and returns its run ID.
