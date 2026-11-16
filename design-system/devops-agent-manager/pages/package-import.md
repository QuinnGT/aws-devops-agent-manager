# Page: Package import and export

Overrides `MASTER.md` for `/spaces/[alias]/plans/import` (upload), `/spaces/[alias]/plans/import/[importId]` (mapping result) and the package export dialog. Screens: the upload page, the mapping result (light and dark) and the export dialog.

The mapping result is sample package v2 (`sample-data/packages/v2`) read by `checkPackage` against a live asset list. Counts, sizes and line counts come from that package or are invented; times and the user are example data.

The flow: upload, then the layout mapping result, then a normal plan review (`plan-review.md`).

## Upload

**Layout, top to bottom.**

1. **Top bar:** breadcrumb "Plans › Import package"; `SyncStatus`.
2. **`PageHeader`:** title "Import package". Description: "Upload an instruction package as a zip. The app finds the asset each file belongs to and builds a plan that shows every change. Nothing changes in the space until the plan is applied."
3. **Two columns** (MASTER: main plus 320 px side):
   - **Upload card:**
     - Layout: a `Select` of the layouts in `policy/package-layouts.yaml`, by `label`, with `defaultLayout` selected. Help: "How the app reads the package's folders. The usual layout for this space is selected."
     - Drop zone: a dashed area with Upload icon, "Drop a zip file or a package folder here" and "or choose one".
     - Pickers: "Choose zip" (`input type=file accept=".zip"`) and "Choose folder" (`webkitdirectory`). Both are buttons, so dragging is never the only way in (WCAG 2.5.7).
     - Limits line, from `limits.packageRead`: "Up to 32 MB and 2,000 files. Absolute paths, .. segments and symlinks are rejected."
     - After a file is chosen, its name and size replace the "or choose one" line.
     - "Read package" (primary). Disabled through `DisabledReason` with "Choose a zip or a folder first." until a file is chosen.
   - **"What the import checks" card,** a numbered list:
     1. Finds the asset each file belongs to, and lists the files that aren't assets.
     2. Packs each skill and each memory store's list of memories from the source files, the way the space stores them.
     3. Checks the package, and each asset against the rules for its type.
     4. Compares each asset with the live space: create, update or unchanged.

**Reading.**
- Upload through a Route Handler (`POST`). Server Actions cap request bodies at 1 MB by default (Next.js `serverActions.bodySizeLimit`), and packages can be 32 MB.
- The handler streams to `readPackageZip`, or `readPackageFiles` for a folder, under the `packageRead` caps.
- It then runs `checkPackage` with the live asset list, stores the import, and redirects to the result page.
- Reading usually takes under a second for a package this size, so show the button's pending state only, with no `JobProgress`.

**Errors on upload.** A destructive `Callout` above the card, with the next step:

| Failure | Title | Body |
|---|---|---|
| Unsafe path, symlink or special file (`ValidationFailure`) | "The package was rejected" | The engine's message, for example "File path \"../x.md\" uses a .. segment." Then "Fix the package and upload it again." |
| Over a `packageRead` cap | "The package is too large" | "It is 41 MB; the limit is 32 MB." (or the entry count) |
| No file matched the layout | "Nothing in this package matches <layout label>" | "Check the layout choice, or the package's folder names." |

## Mapping result

**Layout, top to bottom.**

1. **Top bar:** breadcrumb "Plans › Import package › <file name>"; `SyncStatus`.
2. **Header** (the asset page header pattern):
   - Icon box with Package, and the file name as `h1`.
   - Meta: "<N> files · <size> · Layout <label> · Read <Time> by <name> · SHA-256 <first 12 hex in mono>". The full hash is in a tooltip.
   - Action: "Upload a different file" (ghost, Upload).
3. **Callouts:** only when validation has errors. Destructive, "Validation failed for <N> asset(s)", body "Fix the package and upload it again.", no action.
4. **Stat tiles:**

   | Tile | Value | Detail |
   |---|---|---|
   | Creates | count | Breakdown in console words: "5 instruction files, 8 skills, 3 memory stores, 10 memories" |
   | Updates | count | Names when there are three or fewer ("Instructions GENERIC"), otherwise the breakdown |
   | Unchanged | count | "<N> live assets aren't in the package and stay as they are" |
   | Validation | "Passed" with CircleCheck, or "<N> failed" in destructive-fg | "<e> errors, <w> warnings" |

5. **Two columns:** the mapping on the left; the plan, warnings and file roles cards on the right (340 px).

**Assets by type card.**
- Header: "Assets by type", with the total in muted 12 px.
- Table: Type (linked, sets `?type=`; the selected row uses the plan review's selected style), Create, Update and Unchanged (right-aligned), and a Validation badge.
- Rows only for types the package contains, in console order.

**Selected type card.**
- Header: "<Type plural> · <N> files", and "From <layout dir>/" with the folder in mono.
- Table:

  | Column | Content |
  |---|---|
  | File | Path relative to the type's folder, in mono |
  | Asset | The display name in bold ("Global instructions", a skill name, `<store>/<memory>`), with an instruction file's identity key (`GENERIC`) under it in mono, or "None" in muted text |
  | Change | "Create" (success, CirclePlus); "Update v<a> → v<b>" (info, SquarePen) with "+N −M" below; "Unchanged" (muted, Equal); "Not imported" (warning, TriangleAlert) |
  | Size | Right-aligned. Instructions add "<lines> lines" under the size |
  | Validation | Badge |

- Unchanged means the content hash and the metadata hash match live (`assetContentHash`, `metadataHash`).
- Over 50 rows, "Show more".

**Create the import plan card** (first in the side column).
- Plan title: an `Input`, default "Import <file name>".
- Button: "Create plan with <N> changes" (primary, GitPullRequest, `plans.create`). N is creates plus updates; unchanged assets are not plan items.
- Help: "The plan checks the live space next. You review every diff there before anything is written."
- The button calls `createPlan` with `origin: { kind: "package", importId, fileName }` and goes to the plan page in "checking".
- Disabled reasons:
  - "Validation failed for <N> asset(s). Fix the package and upload it again."
  - "Nothing to import: every asset in the package matches live."

**Warnings card** ("Errors and warnings" when there are errors).
- One row per `ValidationResult`, errors first: icon, message, and the code in mono 12 px.
- For asset results, start the message with the asset key ("INCIDENT_RCA: AGENTS.md has 151 lines; about 120 lines is recommended.").

**File roles card.** A definition list of the role counts from `packageToDesiredAssets`:

| Role | Text |
|---|---|
| `asset` | "<N> assets": "Uploaded as instructions, skills, stores and memories" |
| `build-artifact` | "<N> build files": "Packed skills and lists of memories, built again from the source files" |
| `non-asset` | "<N> not assets": the layout's `nonAssets` folders, for example "README.md, evaluation/, reference/, tools/ and instructions/shared/" |
| `manifest` | "1 manifest": its path, when present |
| `skipped` | "<N> skipped": the file names |

**Rules.**
- An import never deletes or deactivates live assets that aren't in the package. They stay as they are, and the Unchanged tile says how many.
- The plan uses the built content (rebuilt zips and indexes), not the uploaded build files.

## Agent Space folder packages

Packages laid out like the Agent Space (one folder per asset with `_asset.json`, as in an Agent Space export) use the `agent-space-folders` layout. From `src/server/packages/` and `src/server/package-io/`:

- **Upload:** the Layout select defaults to "Detect from the files". The app maps the upload with every layout and picks the one that maps the most asset files; the usual layout for the space is marked "(usual for this space)".
- **Mapping result header:** "Layout <label> (detected)" when it was detected.
- **Layout card** (side column): each layout's fit ("61 files in 29 assets", "27 files, 34 not mapped") and "Read again" to re-read the stored upload with another layout. Allowed until a plan exists.
- **Assets by type** gains a "Left out" column. The selected type's table lists left-out rows with their reason: a package asset that shares a name with another and can't be told apart in this space (`duplicate`), or one the space would have to create but whose type's `createSchema` refuses it, such as a LEARNED skill (`cannot-create`).
- **Create plan card:** a checkbox per asset type, each with its changes and failing assets. The button counts the changes in the selected types ("Create plan with 7 changes") and is disabled with the reason while a selected type has errors. The plan notes list what was left out by choice and why.
- **Matching:** an asset whose `_asset.json` ID is live in this space updates that asset ("matched by its asset ID"); otherwise it matches by name; otherwise it is created.

## Export dialog

Opened from "Export package" on the Releases list (latest commit selected) and "Export as package" on a release (that release selected). A shadcn `Dialog`.

- **Title:** "Export as package". **Description:** "Downloads a package zip from the history repository, for a space this app can't write to."
- **Source:** a `Select` listing releases (newest first, with the tag in mono), "Latest history commit (<short hash>, <relative time>)", and "A commit…". The last reveals an `Input` for a commit hash, with the field error "No commit <hash> in <repository>." Help: "A release, the latest history commit, or a commit you enter."
- **Layout:** a `Select` of policy layouts, default `defaultLayout`. Help: "How the app arranges the package's folders."
- **Package name:** an `Input`, default "<space alias>-<release name>" or "<space alias>-<short hash>". Help: "The zip's file name and top folder."
- **Facts,** recomputed when the source or layout changes (a server preview, not the zip itself):
  - Includes: "<N> assets: <breakdown>".
  - Left out: "<N> <type plural>. This layout has no folder for them." Shown only when above zero.
  - Built: "Skill zips and memory indexes are rebuilt. Metadata the files can't carry goes to <manifest path>." The path comes from the layout's `manifest`.
- **Buttons:** "Cancel" (outline) and "Download zip" (primary, Download).
- **Download:** a Route Handler `GET` that streams the zip from `exportPackageZip`, with the source, layout and name in the query.
- **Disabled reason** for the download: "The package doesn't pass its checks: <N> errors." The errors are listed in a destructive `Callout` in the dialog. Each problem is listed once (the build leaves a missing shared section to the package checks), and files a layout marks optional (`requiredFiles` with `level: warning`, such as a layout's optional extra files) are warnings that don't count.

## Permissions

| Action | Permission |
|---|---|
| Upload and see results | `plans.create` (the Import package button is hidden without it) |
| Create the import plan | `plans.create` |
| Apply it | `plans.apply` (`plan-review.md`) |
| Export | `history.read` |

## Audit log

Record:
- `package.import`: file name, SHA-256, layout, counts by change and type, and the result, including rejected uploads.
- `plan.create`: origin `package`.
- `package.export`: source ref, layout, package name, asset count.

## Data

- `readImport(spaceId, upload, layout, actor)`: stores the import and returns its ID.
- `getImport(spaceId, importId)`: header facts, counts by type and change, the per-file rows, the results and the role counts.
- `createImportPlan(importId, title, actor)`.
- `previewExport(spaceId, ref, layout)`: the facts.
- `exportPackage(spaceId, ref, layout, name, actor)`: the zip.

## Open items

- **Live assets not in the package.** The default leaves them as they are. Rollback sets added skills Inactive instead, so an import option may be wanted to do the same for skills and memories that a package dropped. The original design is silent.
- **Export with failing checks.** The default blocks the download. A package that fails `validate_package` would also fail an external package-validation tool, but blocking stops a user who wants the files anyway.
- **"Load it on the Agents page by hand"** in the `package.no-agent-type` message names a console page. Check that the name matches the console's current wording.
