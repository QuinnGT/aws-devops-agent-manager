# Page: Revision detail and editor, two options

Overrides `MASTER.md` for `/spaces/[alias]/revisions/[revisionId]`. Data from `src/server/revisions/`. The rules cover a revision's branch, findings links, changelog, build and validation on every save, and the plan or package zip.

Two layouts were designed, and both are specified here. Screens (example data):

| Option | Layout |
|---|---|
| 1. Editor | File tree on the left, editor in the middle, build and findings on the right (light, dark and 768 px), plus the save dialog (light and dark) |
| 2. Change list | Each save is a row, and editing opens a sheet (light, dark and 768 px), plus the edit sheet (light and dark) |

The two options show the same revision at different moments: option 1 after save 4, whose build failed (so "Create plan" is disabled with its reason); option 2 after save 5, which fixed it.

**Decision: option 1, the editor layout, with a "Saves" tab that holds option 2's change list** (also recorded in MASTER "Page index"). The edit sheet is not built. Package files are long markdown (an instruction file can run past 150 lines), build errors name a file and a rule, and most saves touch two or three files. That work wants the full-width editor next to the file tree and the build result, which a sheet over the change list can't give. Option 2's strength is traceability: each change, its findings and its build in one list. That fits as the Saves tab in option 1.

## What both options share

**Top bar:** breadcrumb "Revisions › <revision name>"; `SyncStatus`.

**Header** (the asset page header pattern):
- Icon box with GitBranch, `h1` the name, the state `StatusBadge` (`revisions.md` states).
- Meta: "Based on release <name>" (or "Based on the live space, <Time>") · "Branch <branch in mono>" · "<N> saves" · "<N> linked findings" (option 1) or the authors (option 2).
- Actions on the right:

  | Action | Permission | Does |
  |---|---|---|
  | "Export package zip" (outline, Download) | `audits.read` | Downloads the package at the branch head as a zip in the revision's layout, for a space this app can't write to (the `package-import.md` export path) |
  | "Create plan" (primary, GitPullRequest) | `revisions.build` and `plans.create` | Calls `createPlan` with `origin: { kind: "revision", ... }` through the package import mapping and opens the plan in "checking" |

  Under the actions in muted 12.5 px: "Checks the package against the live space. Nothing is written until the plan is applied." **Disabled reasons** for "Create plan" (`DisabledReason`):
  - "The last build failed with <N> errors. Fix them and save to build again."
  - "Save your changes first." (unsaved edits)
  - "Building after your last save." (build running)
  - "Plan <title> is open. Apply or discard it first." (state Planned, with a link)
  - "No changes against <base>."

**Save:** each save is one commit on the revision branch with a message and at least one linked finding, then a build job. The save dialog (option 1) and the sheet (option 2) collect the same fields:
- Changed files with their "+N −M" counts.
- **Message:** required. Help: "The first line becomes the changelog entry's title."
- **Linked findings** (at least 1): a search `Input` over accepted, linkable findings (`listLinkableFindings`), then a list of results with `Checkbox`, each with the incident ID in bold, the title, and "Kind · audit name · accepted by <name>" (or "Kind · owner label · incident" for a fix). Help: "Only accepted findings can be linked. <N> selected." Findings already linked by earlier saves sort first.
- **Changelog entry** preview: the title, "Files: <paths>", "Evidence: <incident> (R<n>, ...)" built from the linked findings' citations.
- Buttons "Cancel" and "Save and build" (primary, Save). Disabled reasons: "Write a message." / "Link at least one accepted finding."

**Build and validation card:** header badge "Passed", "<N> errors" or "Building" (info, Loader). Rows with `ValidationList`, errors first, each naming the file as a link (opens it in the editor) on its own line, then the message and the code in mono. A success row "<N> skill zips and <N> memory indexes rebuilt, shared sections copied" with "After save <N>, <Time>". The build is the package build and validation in `src/server/packages/` and `src/server/validation/`, so its codes are those modules' codes.

**Generated files** (`reference/CHANGELOG.md`, skill zips, memory indexes) are read only. The tree marks them "Built" with a Lock icon, and opening one shows it with "This file is built from the package. Edit its sources instead."

**Shared sections:** editing a copied section in a target file (for example the handoff section in incident-triage.md) is a build error, `package.shared-section.edited`: "The handoff section differs from shared/handoff.md. Edit the shared file; the build copies it."

## Option 1: editor with file tree and right rail

- **Tabs** (client state, so unsaved text survives a switch): "Edit", "Diff against <base> +N −M", "Changelog", "Saves <N>".
- **Three columns** at 1280 px and up: file tree (232 px), editor (the rest), right rail (300 px).
  - **File tree** card "Package files <N>": folders in the layout's order, open where a file is edited; files with a 28 px row, the current one with `aria-current="page"`. Right-aligned text marks, never color alone: "Edited" (info-fg), "Error" (destructive-fg), "Built" (muted). A filter `Input` at the top when the package has more than 40 files. Footer "New file" (adds a file in the chosen folder; the layout decides where each asset type lives).
  - **Editor** card: the path in mono, "Unsaved changes" in warning-fg while dirty, "Save" (primary, opens the save dialog). The size meter for instruction files as in `draft-editor.md`. The `Textarea` editor from `draft-editor.md` (mono 13 px, `wrap="off"`, no spellcheck, inset focus ring). Footer help: "Plain markdown. Saving commits to the revision branch and runs the build."
  - **Right rail:** "Build and validation", then "Linked findings <N>" (the two latest, "Show all <N>").
- **Diff tab:** `FileDiffView` per changed file, base against the branch head, with a file `ToggleGroup` or the tree to switch.
- **Changelog tab:** the generated `reference/CHANGELOG.md` rendered through `SafeMarkdown`.
- **Saves tab:** option 2's change list.
- 1024 to 1279 px: tree and editor side by side, the rail below them, two cards across. Below 900 px: the tree becomes a file `Select` above the editor, and the rail stacks.
- Leaving with unsaved edits triggers the browser's `beforeunload` prompt.

## Option 2: change list with an edit sheet

- **Stat tiles:** Changes (count, last time), Files changed (count and "+N −M against <base>"), Linked findings (count, "From <N> audits"), Build (result, "<N> warnings · after change <N>").
- **Two columns** (main plus the 340 px side column):
  - **Changes card:** `h2` "Changes" and "Edit files" (primary, SquarePen, opens the sheet). One row per save, newest first: GitCommitHorizontal, the message in bold, "<N> files · +N −M · <author> · <Time>", the linked findings as chips ("INCIDENT-20101 · Diagnosis", each a link to the finding's incident page), and on the right the build badge and "Diff" (expands the save's diff inline, `aria-expanded`). Footer: "Started from <base> on <Time> by <name>."
  - **Side:** "Build and validation" and "Changelog preview" (the two newest entries, "Show all <N> entries").
- **Edit sheet** (shadcn `Sheet` from the right, 760 px or full width below it): title "Edit files", description "Edit one or more package files, then save them as one change with its linked findings." File `Select` with "New file", the files edited in this change with counts, the editor with its size meter, Message, Linked findings, then "Cancel" and "Save and build". Closing with unsaved edits asks "Discard your edits?" in an `AlertDialog`.

## States

| State | What shows |
|---|---|
| Loading | Header skeleton, then the three columns (option 1) or tiles and list (option 2) as `Skeleton` blocks |
| Just created | The base exported, no saves: Changes or Saves `EmptyState` "No changes yet", body "Edit a file and save it with the findings it addresses.", action "Edit files" or focus on the tree |
| Building | Build card badge "Building"; "Create plan" disabled with "Building after your last save." The page refreshes when the job ends |
| Build failed | As designed in option 1 |
| Planned | Info callout "Plan <title> is open" with its state and a link; editing still allowed, and a save after the plan was made shows a warning: "This save is not in plan <title>. Discard the plan and create a new one to include it." |
| Applied | Success callout "Applied <Time> by plan <title>. Release <name> was tagged." with links; the page is read only |
| Abandoned | Neutral callout "Abandoned <Time> by <name>"; read only, with "Reopen" (`revisions.build`) |
| Branch missing | Destructive callout "The branch <branch> isn't in the history repository." with an Admin next step |
| Read only (Viewer) | Files, diffs, changelog and saves; no Save, New file, Edit files or Create plan. Export stays |

## Permissions

| Action | Permission |
|---|---|
| See the revision, files, diffs, changelog | `audits.read` |
| Edit, save, new file, abandon, reopen | `revisions.build` |
| Create plan | `revisions.build` and `plans.create` (both Editor) |
| Apply the plan | `revisions.apply` (Publisher), on the plan page (`plan-review.md`) |
| Export package zip | `audits.read` |

## Audit log

`revision.save` (commit, files, linked finding IDs, build result), `revision.build` (result, error count), `plan.create` (origin `revision`), `revision.export`, `revision.abandon`, `revision.reopen`.

## Data

- `getRevision(spaceId, revisionId)`: name, branch, base, state, saves (commit, message, files with counts, linked finding IDs and short titles, author, time, build result), the package file tree with edited, error and built marks, the latest build results, linked findings, the changelog preview, the open or applied plan.
- `readRevisionFile(revisionId, path)` and `revisionDiff(revisionId, path?)` against the base.
- Service functions: `saveRevision({ files, message, findingIds }, actor)` (commit, then enqueue the build), `createRevisionPlan`, `exportRevisionZip`, `abandonRevision`.

## Components

`StatusBadge`, `StatTile`, `Callout`, `DisabledReason`, `EmptyState`, `ValidationList`, `Checkbox`, `Time`, `SafeMarkdown`, `FileDiffView`, `DiffCounts`, `SizeMeterView` and `PathTree` from `src/components/assets/`, shadcn `Tabs`, `Dialog`, `Sheet`, `Select`, `Textarea`, `AlertDialog`.

## Open items

- **Linked findings per save or per file.** The original design says "each change links to one or more accepted findings". This page links per save. Per file would make the changelog finer but the save dialog longer.
- **Citations in the changelog.** The entry's evidence lists record numbers from the findings' citations. A finding with a failed citation: list it with "(check failed)", or leave it out.
