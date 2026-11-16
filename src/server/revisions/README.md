# Revisions

Revisions are branches of packages in the history repository (`revisions`, `packages/<space-alias>/<package>/`). Services, jobs and page loaders live here; pages, Server Actions and Route Handlers are under `src/app/`. Rules live in `policy/revisions.yaml` (section `src/server/policy/sections/revisions.ts`).

Import from `@/server/revisions`.

## What a revision is

A branch `historyLayout.revisionBranch` (`revision/<space-alias>/<name>`) in the space's history repository. The branch starts at the base commit and holds an instruction package under `historyLayout.packageDir` (`packages/<space-alias>/<package>/`, package name from `revisions.packageName`, default the revision name) in one of the layouts in `package-layouts.yaml`. Each save is one commit on the branch. The rest of the tree on the branch is the base commit's, unchanged.

### Git: plumbing, no checkout

The working copy stays on the default branch with a clean tree, so sync keeps committing there while revisions are edited. Revision commits use additive `HistoryRepo` methods built on git plumbing against a temporary index file under `.git/` (`read-tree`, `hash-object -w --no-filters`, `update-index`, `write-tree`, `commit-tree`, `update-ref <ref> <new> <old>`). No files are checked out, the bytes are stored exactly (no CRLF or attribute conversion), and the ref update is a compare-and-swap against the parent, so a second writer gets `BranchMovedError` instead of overwriting a save. A dedicated worktree under `DAM_DATA_DIR` was the alternative; plumbing was chosen because it needs no second checkout to keep clean, works on bare-style use, and makes the compare-and-swap explicit.

| Method | What it does | Process |
|---|---|---|
| `branchHead(branch)` | Commit of `refs/heads/<branch>`, or null | any |
| `listTree(ref, dir)` | Files under a folder at a ref, with blob IDs and sizes (`ls-tree -r -l -z`) | any |
| `readBlobs(ref, paths)` | Many files at a ref in one `cat-file --batch` | any |
| `diffNameStatus(from, to, dir)` | Added, modified and deleted paths (renames off) | any |
| `createBranch(branch, commit)` | Create a branch; fails when it exists | worker |
| `commitToBranch(branch, changes, opts)` | Commit file changes to a branch that is not checked out; repeatable trailers; `expectedHead` guard; null when nothing changed | worker |
| `pushBranch(branch)` | Push one branch; no-op without a remote or with push off | worker |

The existing `diff(from, to, path)`, `log({ ref })` and `resolveCommit` are used as they are.

## Configuration

`policy/revisions.yaml`: name rule (pattern, length, case rule), package name template, committer, create (sync first, commit message, base labels), save (unlinked rule, message and reason lengths, caps on findings, files and bytes), trailer names, the change record (path, title, heading, intro, markers, column names, caps), plan title and reason templates, release name and note templates, `export.requirePassingBuild`, `pushBranches`, page caps.

## Lifecycle

| Step | Entry point | Where | Permission |
|---|---|---|---|
| Create | `requestCreateRevision(space, { name, base, layout?, note? }, actor)` then job `revisions.create` | web, then worker | `revisions.build` |
| Save | `requestSaveRevision(space, revisionId, { message, edits, findingIds, unlinkedReason?, expectedHead? }, actor)` then job `revisions.save` | web, then worker | `revisions.build` |
| Plan | `createPlanFromRevision(space, revisionId, actor, { reason?, title? })` | web | `plans.create` |
| Export | `exportRevision(space, revisionId, actor)`, `revisionDownloadHeaders(result)` | web (Route Handler) | `audits.read` (a read, like exporting a release) |
| Abandon | `abandonRevision(space, revisionId, actor, { note? })` | web | `revisions.build` |
| Release after apply | `tagReleaseAfterApply` (plan-applied hook) | worker | (the applier's apply) |
| Pages | `loadRevisionList`, `loadRevisionDetail`, `loadLinkableFindings` | web | `audits.read` |

`REVISION_PERMISSIONS` names them. Refusals throw `RevisionError` with a `code`, a plain message, `fieldErrors` for forms and the blocking `results`.

### Create

`base` is `{ kind: "live" }` or `{ kind: "release", releaseId }`. The name must pass the policy pattern, git's ref rules and the release name rules (applying the revision tags a release with the name from `revisions.release.name`), and be unique per space under the case rule; a release with that name must not exist yet. The row is inserted in state `creating`; the job then:

1. live: runs the reconcile sync (`revisions.create.syncBeforeCreate`, the same sync a release of HEAD runs) and reads the assets at the history repository's HEAD; release: reads the assets at the release commit and never syncs;
2. turns them into package files with the layout (`snapshotsToDesiredAssets`, `exportPackageZip`). When the release was tagged after a plan made from an earlier revision (`releases.plan_id` to `revisions.plan_id`), that revision's package at the planned commit is the export `base`, so README, `evaluation/`, `reference/` (the change record included) and shared section sources carry over while asset files come from the release;
3. runs the build and validation (`checkPackage` against the live index);
4. creates the branch at the base commit and commits the package (trailers `Revision-Id`, `Space`), state `open`.

Problems turning assets into a package (`export.not-placed`, files git doesn't hold) are kept in `base.exportResults` and listed first in the first build. A failed create sets state `failed` with the reason; a failed revision without a branch gives its name back to the next create. A rerun finds its branch by `Revision-Id` and finishes.

### Save

One `revisions.save` job per save, one at a time per revision (pg-boss `singleton` policy keyed by revision ID; later saves wait). Edits are `{ path, encoding: "utf8" | "base64", content | null }` with package-relative paths (the package reader's path rules: no absolute paths, `..`, backslashes or control characters), within `revisions.save` caps and `limits.packageRead.maxEntryBytes`. `expectedHead` (the head the editor loaded) refuses a save when the branch moved (`moved`); the branch update itself is also a compare-and-swap.

The job applies the edits, regenerates the change record, runs `checkPackage` (shared sections, memory indexes, skill zips, `VALIDATION.json`, package checks, mapping, asset rules against the live index), and commits the person's files and the build's files together. Trailers: `Revision-Id`, one `Finding-Id` per linked finding, `Unlinked-Reason` when none is linked, `Revision-Change-Id` (the change row ID, so a retried job finds its own commit), `Space`. A save whose build fails is still committed (it is the person's work); the stored build result blocks the plan and the download. The change row records the commit and its parent, the person's paths, the build's paths, the message, the findings or the unlinked reason, the build status and the author.

**Linking.** Every finding must be returned by `listLinkableFindings(spaceId, { ids })`: accepted, its extractor marked `linkable` in the profile the audit ran with, and of the same space. **A save without a finding link needs a reason** (`save.unlinked: reason`, at least `reasonMinChars`): some changes have no finding behind them (restoring a file, a README, a rename the asset rules ask for), and refusing them would push people to link an unrelated finding and make the change record cite the wrong evidence. The reason goes into the change record and a trailer. `refuse` and `allow` are the other settings.

### Change record

**Written into the package on every save**, at `changelog.path` (default `reference/CHANGELOG.md`, a non-asset path in the instruction folder layouts), so the exported package and the plan's package carry it, and the detail page shows the same text (`renderChangelogSection` on demand). The revision's section sits between markers that name the revision, at the top under the title line, above the hand-written history, so a save replaces only that section and earlier revisions' sections stay. Shape, after `reference/CHANGELOG.md`: `## <name>, <Month D, YYYY>`, a `Source: <base>.` line, then a table with one row per change: change message, files, audit, incident, finding title, and evidence (the finding's checked record citations, `R<n> "<quote>"`, marked when the citation check did not confirm them). Finding text is untrusted model output a person accepted: each cell is one line, with `|`, `<` and `>` escaped.

### Plan

Refused (`build-failed`, `plan-open`, `not-open`) unless the latest build passed at the branch head and no plan from the revision is open or applied. The package at the head goes through the package import mapping (`analyzeImport` from package-io, against the live index with committed states) and `planItemsFromAnalysis` (create and update items, `baseVersion: null`, references by name); refused when the mapping has validation errors or nothing changes. `createPlan` gets origin `{ kind: "revision", revisionId, name }`, the title `revisions.plan.title` ("Apply revision v2.4"), a reason naming the change messages and every linked finding (`revisions.plan.reason`, within `plans.limits.reasonMaxChars`), and notes for unchanged and untouched assets. The plan ID and the head it was made from are stored on the revision; a later save marks the plan out of date on the pages.

### Release after apply

`plans/hooks.ts` (foundation change) runs registered hooks after the apply job ends with the plan in state `applied`. `revisions/jobs.ts` registers `tagReleaseAfterApply`: for a plan with origin `revision` it calls `requestCreateRelease({ spaceId, name: revisions.release.name, note, commit: plan.resultCommit, planId }, applier)` (a release of a given commit never syncs first), and stores the release ID, name and job run on the revision, state `applied`. A refused release (for example a name taken since) is stored as `releaseError` and audited; the apply stays done. Idempotent on retries.

### Export

The package at the branch head, zipped under one top folder (`zipPackage`, deterministic) and named with the layout's `build.packageZip` (`<package>.zip`). Refused while the build fails (`export.requirePassingBuild`). The committed package is already built, so the build does not run again.

## Loaders

- `loadRevisionList(space, { limit?, offset? })`: name, base, state, linked finding count, change count, last build (and whether it is for the head), plan link and state, release link and whether it exists.
- `loadRevisionDetail(space, idOrName, viewer?, { path?, diffPath? })`: the list fields plus branch, package folder, commits, the file tree at the head (with file roles from the layout and the files the last save's build wrote), one file's content (text, binary or too large), linked findings with their current state, the build result, the change record preview, the diff against the base (first branch commit to head: changed paths, and the unified diff of the package or one file, capped), the changes newest first, and `actions.{save,createPlan,export,abandon}` with the reason each is unavailable (`missingRoleReason` for a missing permission).
- `loadLinkableFindings(space, { auditId? })`: the save form's finding picker.

## Audit log

`revision.create` (worker; ok or error), `revision.save` (worker; ok or error), `revision.plan`, `revision.export` (ok, or error when refused), `revision.abandon`, `revision.release` (worker; ok or error).

## Tests

Unit: `names.test.ts`, `changelog.test.ts`, `plan-input.test.ts`, `states.test.ts`, `branch-git.test.ts` (the HistoryRepo branch methods on a real local repository), Integration: `revisions.int.test.ts` against `TEST_DATABASE_URL` with a local history repository under a temporary `DAM_DATA_DIR` (jobs run directly; `enqueue` is mocked).
