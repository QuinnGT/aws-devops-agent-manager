# Package import and export

The server side of package import and export: upload a package (zip or folder), map it against the space, turn it into a normal plan, and download a space's state at a git ref as a package zip. Built on `src/server/packages/` (read, check, map, export); every write to a space still goes through `createPlan` from `@/server/plans`.

Import from `@/server/package-io`.

## Configuration

| File | What it holds |
|---|---|
| `policy/package-io.yaml` | Upload retention (`uploads.retentionDays`, `uploads.expireCron`), the plan title template, whether validation errors block the plan, the import list page size, the export package name template, how many recent commits the export form offers, whether failing package checks block the download (`export.blockOnFailedChecks`) |
| `policy/limits.yaml` `packageRead` | Upload caps: zip size, file count, file size, total size, path length |
| `policy/package-layouts.yaml` | The layouts (`instruction-folders`, `instruction-folders-shared`, `agent-space-folders`), the default layout, and per layout what to keep when package assets share a name (`duplicates`) |

## Permissions

`PACKAGE_IO_PERMISSIONS` names the permission each entry point needs. The Server Action or Route Handler calls `requirePermission(permission, space.id)` first.

| Entry point | Permission |
|---|---|
| `importPackage` | `plans.create` |
| `remapImport` | `plans.create` |
| `createPlanFromImport` | `plans.create` |
| "Fix in a revision" (`requestCreateRevision` with `importId`, in revisions) | `revisions.build` |
| `loadImportList`, `loadImportDetail` | `assets.read` (the pages ask for `plans.create`, per `pages/package-import.md`) |
| `exportPackage`, `previewExport`, `loadExportOptions` | `history.read` |

## Route Handlers and pages

| Route | What it does |
|---|---|
| `POST /api/spaces/<alias>/packages/import` | The upload: a zip in `file`, or `files` plus `paths`; optional `layout`. Space lookup, `plans.create`, a cross-site check, then the body is read up to `uploadBodyLimit(limits.packageRead)` (the caps plus multipart framing). A larger or cut-off body gets 413 and is audited (`recordRefusedUpload`). 200 `{ importId, status }`, or 4xx `{ error: { title, body, field?, results? }, importId? }` |
| `GET /api/spaces/<alias>/packages/export?ref=&layout=&name=` | The zip (`exportDownloadHeaders`), `history.read`. Refusals are plain text (`refusalText`) |
| `GET /api/spaces/<alias>/packages/export/preview?ref=&layout=` | `{ preview: ExportPreview }` for the export dialog, or `{ error, field }`. Not audited |
| `/spaces/<alias>/plans/import` | Upload page |
| `/spaces/<alias>/plans/import/<importId>` | Mapping result, "Create the import plan" with the asset types to include (Server Action `createImportPlanAction`), and the Layout card with "Read again" (Server Action `changeImportLayoutAction`) |

`src/proxy.ts` leaves the upload route out of its matcher: when proxy runs, Next.js buffers the body and silently cuts it at `experimental.proxyClientMaxBodySize` (10 MB by default), below the package caps. The handler checks the session with the DAL before it reads anything, and refuses a body shorter than its Content-Length.

`http.ts` holds the handlers' pure helpers (body limit, body reading, error mapping); `format.ts` holds `formatBytes` and `joinAnd`, safe for client components.

## Import

```ts
importPackage(space, { upload, layout? }, actor): Promise<ImportPackageResult>
// upload: { kind: "zip"; fileName; bytes } | { kind: "folder"; name?; files: { path; data }[] }
// result: { importId, status: "analyzed" | "rejected" | "failed", summary, problems, layout, layoutChoice }
remapImport(space, importId, layout, actor): Promise<{ importId, status, summary }>
```

Without `layout` the layout is detected: `rankLayouts` maps the upload with every layout and the one that maps the most files to assets wins (ties: fewer unmapped files, then the default layout). Every layout's fit is stored in `results.layouts`, and `results.layoutChoice` says `detected` or `chosen`. `remapImport` maps the stored upload again with another layout while no plan exists (SHA-256 checked), updates the row's layout and results, and writes the audit event `package.import.layout` (`from`, `layout`).

1. The upload is read with the package reader (`readUpload`): absolute paths, `..` segments, backslashes, symlinks, encryption, ZIP64 and duplicate names are rejected, and every `limits.packageRead` cap applies. A rejected upload gets a `package_imports` row with status `rejected` and the reasons, and nothing is stored.
2. The upload is stored at `DAM_DATA_DIR/package-imports/<import id>.zip` (mode 0600). A folder upload is stored as a deterministic zip, so the same folder always has the same SHA-256. The row records the SHA-256 of the stored zip and when it expires.
3. `checkPackage` runs against the space's current index (`asset_index`, not deleted), which aims the package at the space (`targetPackageAssets` in `src/server/packages/`: source asset IDs, duplicate names, references by source ID), and each package asset is matched to a live asset:
   - its source asset ID (an Agent Space folder's `_asset.json`) is live in the space: that asset (`matchedBy: "asset-id"`);
   - otherwise a live asset with its identity (`asset-types.yaml` `identity`; `matchedBy: "identity"`);
   - no match: **create**;
   - a match whose `assetContentHash` and `metadataHash` (`src/server/history/content-hash.ts`) equal the committed state (`asset.json` at the history repository's HEAD): **unchanged**;
   - otherwise **update**, with what differs (content, metadata keys).

   The metadata compared is the committed metadata patched with the package's (PATCH semantics), with name references (`refs.memoryStore`, `refs.skills`) resolved to live IDs. For single-file types the lone file is compared under the committed file's name, because the service names it (a store's file is `<store>.md` live and `README.md` in a package).
4. Every file gets a role (`asset`, `build-artifact`, `manifest`, `non-asset`, `skipped`, `unmapped`), and the build step's created or rewritten files are marked. Text files carry their line count, and updated items whose content changed carry `diffStat` (lines added and removed against the committed files, read at the same commit).
5. Live assets the package doesn't mention are listed as untouched. Import never deletes. Package assets that are not planned are in `results.leftOut` with the reason: a duplicate name whose source IDs are not all live in the space (the one with `status: ACTIVE` is planned), or, on a plan made with a type selection, the types left out.
6. Audit event `package.import` (result `error` for rejected and failed uploads).

## Plan

```ts
createPlanFromImport(space, importId, actor, { reason?, title?, includeTypes? }): Promise<{ planId, checkRunId, items, summary, notes }>
```

Reads the stored upload again (SHA-256 checked), maps it against the index as it is now with only `includeTypes` (default: every type; unknown names are dropped, an empty choice is refused), and calls `createPlan` with `origin: { kind: "package", importId, fileName }`, the plan `notes` from `importPlanNotes` (the types left out by choice as counts, then each left-out duplicate with its reason) and only the create and update items (`baseVersion: null`; update items carry the live `assetId`, create items none; references stay as names in `refs`). Refused with `PackageIoError` when the import is in another space (`not-found`), already planned, held by a revision (`in-revision`), rejected, expired, changed on disk, has validation errors (`import.blockPlanOnErrors`) or has nothing to change. Validation results about only the types left out don't block the plan (`checkPackage` `includeTypes`); a refusal with a type selection leaves the stored all-types mapping as it is. A claim (status `planning`) stops a double submit from creating two plans; a failed `createPlan` puts the import back. Audit event `package.plan` (with `includeTypes` when given). Update items found by source asset ID carry the note "From the package folder <dir>, matched by its asset ID." An item whose optional references were dropped (a `reference.not-in-package` warning) adds "Leaves out 3 references in memory_stores that aren't in this package or this space."

## Fix in a revision

`to-revision.ts`: an import can move to a revision (see `src/server/revisions/README.md`, "Create"), where its files are edited and checked before the plan. The revision's base records `fromImport`.

- `importRevision(spaceId, importId)`: the revision that holds the import (state creating, open or applied), or null.
- `readImportForRevision(space, importId, policy, { revisionId? })`: the import's row, layout and package, refused like a plan (not found, planned, not read, expired, changed on disk) and when another revision holds it. Validation errors don't refuse it.

While a revision holds the import, `createPlanFromImport` and `remapImport` refuse with `in-revision`, and the detail page says where the import went.

## Export

```ts
exportPackage(space, { ref?, layout?, name? }, actor): Promise<ExportPackageResult>
// { zip, fileName, warnings (export.not-placed), results, ok, ref, layout, assets, sha256 }
previewExport(space, { ref?, layout?, name? }): Promise<ExportPreview>
// { ok, blockedReason, ref, layout, layoutLabel, packageName, fileName, included, leftOut, manifest, errors, warnings }
exportDownloadHeaders(result): Record<string, string>
```

The `agent-space-folders` layout exports one folder per asset with its `_asset.json` and an `INDEX.json`; the preview's `assetFolders` names them for the dialog.

`ref` is `HEAD` (default), a commit hash (7 to 64 hex characters), or one of the space's release tags (`history-layout.yaml` `releaseTag`). Anything else is refused before it reaches git. `name` replaces the policy's package name (`export.packageName`). The space's assets are read from `asset.json` files under `spaces/<alias>/` at that commit (bytes, so binary files survive), converted with `snapshotsToDesiredAssets` and zipped with `exportPackageZip`. Without a base package, a layout that requires files a live space can't supply (a shared section's source, optional agent files) fails its checks (see `src/server/packages/README.md`), so `ok` is false for a live space in such a layout. By default (`export.blockOnFailedChecks: false`) such an export still downloads every asset as it is, because the space already holds each one and the errors are layout conventions; `export.notes.path` (default `reference/EXPORT-NOTES.md`) is added listing the errors, and `previewExport` returns `notesFile` and the errors for the dialog. While `blockOnFailedChecks` is true, the export is refused with `PackageIoError("checks-failed")` carrying the errors, and audited with result `error`. Audit event `package.export`, also for refused refs. `previewExport` runs the same build for the dialog's facts and writes no audit event.

## Loaders for the pages

- `loadImportList(space, { limit?, offset? })`: `{ imports: ImportListItem[], hasMore, pageSize }`, newest first.
- `loadImportDetail(space, importId)`: `ImportDetail | null`: the import, its summary, the mapping table grouped by asset type (`groups`, each with create, update and unchanged counts), file roles grouped by role, validation errors and warnings, untouched live assets grouped by type, `plan: { planId, canCreate, reason }` (for all types), `leftOut`, `layouts: { candidates, choice, canChange }`, `revision: { current, canStart, reason }` for "Fix in a revision", and `planTypes: { types, unattributedErrors, blockOnErrors, stateReason }` for the type choice: per type its assets, changes and errors (`resultTypes` attributes a result by asset key, by the asset its file belongs to, or by type folder). The page's `selectionBlocker` decides the button from the selection.
- `loadExportOptions(space)`: layouts, the default layout, and export points (`head`, `releases`, `commits`), or `repo.ok: false` with the reason.

## Input parsing for the actions and handler

- `importRequestFromForm(formData)`: a zip in `file`, or a folder as `files` plus `paths` (each file's `webkitRelativePath`, same order), plus optional `layout` and `name`. Returns `ImportPackageRequest`.
- `createPlanRequestFromForm(formData)`: `importId` (UUID), optional `title` and `reason`, and when `typeSelection` is set, the checked `types` (at least one).
- `layoutRequestFromForm(formData)`: `importId` (UUID) and `layout`.
- `exportRequestFromSearchParams(searchParams)`: `ref` and `layout` from the download URL.

Each throws `PackageIoError("bad-request")` with a plain message.

## Jobs

`package-io.expire-uploads` (daily, `uploads.expireCron`) deletes stored uploads past `expiresAt` and sets `fileDeletedAt`. The rows and their results stay. Audit event `package.import.expired`.
