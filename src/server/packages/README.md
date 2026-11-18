# Package tools and validation

Pure libraries: no AWS calls, no database, no disk writes (except `readPackageFolder`, which only reads). Plans, package import, revisions and the editor are built on these functions.

- `src/server/packages/`: read a package folder or zip, map it to desired assets, build it, export desired assets back to a package zip.
- `src/server/validation/`: validate one draft asset, a whole desired asset set, or a package.

Rules live in policy, not code:

| File | What it holds |
|---|---|
| `policy/asset-types.yaml` | Per asset type: JSON Schema for `metadata` (errors), an optional warning schema, a create-only schema, identity template, references, count limits, file limits, frontmatter rules, plus the UI keys (`label`, `content`, `mainFile`, `supportsStatus`, `editable`, `managedNames`) |
| `policy/limits.yaml` | Sizes and counts from the asset, instruction and memory guides, extra name patterns, and the caps for reading uploads (`packageRead`) |
| `policy/package-layouts.yaml` | Layouts (`instruction-folders`, `instruction-folders-shared`, `agent-space-folders`): where instructions, skills and memory live, or the Agent Space folders and their descriptors, which files are not assets, agent type names, shared sections and their markers, what to do with duplicate names, build steps and package checks |
| `policy/agent-types.yaml` (foundation) | Agent type IDs; injected into the schemas as `#/$defs/agentType` |

Import from `@/server/packages` and `@/server/validation`.

## Core types

```ts
// src/server/packages/types.ts
interface PackageContents { name: string; files: Map<string, Buffer> }   // package-relative paths, sorted

interface DesiredFile { path: string; encoding: "utf8" | "base64"; content: string; sourcePath?: string }

interface DesiredAsset {
  assetType: string;
  key: string;                    // identity within the type: skill/store name, agent_type, "<store>/<memory name>"
  assetId?: string;               // set when the asset exists in the space
  metadata: Record<string, unknown>;
  files: DesiredFile[];
  refs?: Record<string, string | string[]>;   // references by identity before IDs exist: { memoryStore: "x" }, { skills: [...] }
  source?: string;                // package path, for messages
  sourceAssetId?: string;         // the asset ID an Agent Space folder's descriptor gives (not an ID in the target space)
}

interface LiveAssetRef { assetId: string; assetType: string; metadata: Record<string, unknown> }

interface PackageFile { assetType: string; name: string; path: string; body: string }  // name = DesiredAsset.key

// src/server/validation/types.ts
interface ValidationResult { level: "error" | "warning"; code: string; message: string; assetKey?: string; path?: string }
// assetKey = `${assetType}:${key}` (assetKeyOf); path = file path or "metadata.<key>"
```

`assetIdentity(policy, asset, lookup?)` computes `key` from the type's `identity` template. Recompute it after editing metadata or refs. Reference names (`memoryStore`, `skills`, `memoryStores`) come from `references[].ref` in asset-types.yaml.

## Reading packages

```ts
readPackage(input: string | Buffer | PackageInput, opts?: { policy?; layout? }): Promise<PackageContents>
readPackageFolder(dir, opts?)          // rejects symlinks and special files
readPackageZip(buffer, fileName?, opts?)
readPackageFiles([{ path, data }], name?, opts?)   // browser folder upload
packageFromFiles(name, { path: string | Buffer })  // in-memory packages (tests, drafts)
```

Every path is checked: absolute paths, `..`, `.` and empty segments, backslashes and control characters are rejected. Zips are parsed from the central directory before anything is inflated; symlinks, special files, encryption, ZIP64, duplicate names and mismatched local headers are rejected; each entry inflates with an output cap equal to its declared size and its CRC is checked. Entry count, entry size, total size and archive size come from `limits.packageRead`. Rejected input throws `ValidationFailure` with `results`. Files matching the layout's `ignore` globs (`.DS_Store`, `__MACOSX/`, `__pycache__/`) are dropped. A zip whose files sit under one folder is read from inside it, and that folder becomes the package name.

## Mapping a package to assets

```ts
packageToDesiredAssets(contents, layout?, { policy? }): MappedPackage
// { assets: DesiredAsset[]; results: ValidationResult[]; roles: Map<path, { role, assetKey? }> }
packageToPackageFiles(contents, layout?, { policy? }): PackageFile[]
```

`layout` is a layout object or name; the default is `defaultLayout` (`instruction-folders`). Each file gets a role: `asset`, `build-artifact` (skill zips, memory indexes), `manifest`, `non-asset` (README, `evaluation/`, `reference/`, `enrichment/`, `tools/`, shared section sources), `skipped` or `unmapped` (warned). Mapping with `instruction-folders`:

| Package path | Asset |
|---|---|
| `instructions/<file>.md` | `agents_md`, `agent_type` from `instructions.files` (`global.md` is GENERIC). A file listed with no agent type (`null` in `instructions.files`) is skipped with a warning; a file the layout does not list is unmapped |
| `skills/<name>/` | `skill`; name, description (and agent types, tools, status if present) from SKILL.md frontmatter; otherwise agent types from `skills.agentTypes` (`bySkill`, then `default`). A `skills/<name>.zip` without a folder is read as the skill |
| `memory/<store>/STORE.md` | `memory_store`; `store`, `description`, `agent_types` (for example `Incident Triage, Incident RCA`) from frontmatter; the body becomes `README.md` |
| `memory/<store>/<path>.md` | `memory` named `<path>`, `refs.memoryStore = <store>`; the file keeps its frontmatter |
| `reference/ASSET-METADATA.json` | optional manifest with metadata the files can't carry (status, agent types that differ from the layout default) |

`packageToPackageFiles` returns one entry per UTF-8 file of each asset with its package path and the text that is uploaded (for a memory store, the STORE.md body).

### Agent Space folders (`agent-space-folders`)

A package laid out like the Agent Space, and an Agent Space export, mirror the space: one folder per asset under a folder per type, each with a descriptor. The layout's `assetFolders` names the descriptor (`_asset.json`), the folder index (`INDEX.json`), the type folders and main files (`agents_md/<folder>/AGENTS.md`, `skill/<folder>/SKILL.md`, `custom_agent/<folder>/<name>.md`), files never uploaded, and the descriptor's bookkeeping keys (`version`, `createdAt`, `updatedAt`, `creator`, `editor`). It extends `instruction-folders` for `memory/`, which has no descriptors and maps with the STORE.md rules, plus `memory.storeAssetIdKey` (`asset_id`): the store's asset ID in STORE.md frontmatter, written on export and read back as the store's `sourceAssetId`, so custom agents' store IDs resolve to the package's stores in another space.

| Package path | Result |
|---|---|
| `<type dir>/<folder>/_asset.json` | Role `manifest`. `assetType` must match the type folder; `metadata` becomes the asset's metadata as it is; `assetId` becomes `sourceAssetId`; other keys than the bookkeeping ones are warned about (`package.descriptor-key`) |
| `<type dir>/<folder>/<file>` | A file of that asset, byte for byte (path relative to the folder) |
| a folder without a descriptor | `package.descriptor-missing` warning, files unmapped |
| `INDEX.json` | Role `manifest`; folders it misses, lists wrongly or lists without a folder are `package.index-stale` warnings |

Folders are matched by descriptor, not by name, so `global/` (a package) and `ki-95e4…/` (an export) both work. Two descriptors with one `assetId` are errors. Several assets with one identity (the space allows a skill and its older copy to share a name) keep distinct keys: the one that matches the layout's `duplicates.keep` (`status: ACTIVE`) keeps the identity, the others get `<identity>@<source asset ID>`.

## Aiming a package at a space

```ts
targetPackageAssets(mapped, { policy, layout, live?, includeTypes? }): TargetedPackage
// { assets; leftOut: { asset, reason: "type-not-selected" | "duplicate", message, keptKey? }[]; results }
```

`checkPackage` runs it between the mapping and the set rules. In order: an asset whose `sourceAssetId` is live in the space (same type) gets it as `assetId`; types outside `includeTypes` are left out; a group of assets that share an identity and all have source IDs stays whole when every ID is live, otherwise only the one matching `duplicates.keep` is kept (none when zero or several match) and the others are left out with an `import.duplicate-left-out` warning; references by source ID (custom agent `skills` and `memory_stores`, `memory_store_id`) are remapped: a live ID stays, the ID of another package asset becomes a name in `refs` through that asset's identity (and then every ID of that key becomes a name, because a plan writes names over IDs), and an ID that is neither is a `reference.not-in-package` result on the referring asset: an error for a required reference (a memory's `memory_store_id`), a warning for an optional one (a custom agent's `skills` and `memory_stores`), which is dropped from the asset, so the plan leaves it out. Assets without source IDs pass through unchanged, so the instruction-folders layouts behave as before.

`validateAssetSet` checks an asset without an ID whose identity is live as the update it is, so the type's `createSchema` (for example "the API creates only USER skills") applies only to assets the plan would create.

`validateAssetSet` reports a name that several live assets already share, where each desired member updates one of them by its own ID and keeps its name, as `identity.duplicate-live` (warning) instead of `identity.duplicate`.

## Layout detection

```ts
rankLayouts(contents, policy): LayoutFit[]   // { layout, label, assets, assetFiles, unmappedFiles }, best first
```

Maps the package with every layout. Most files with role `asset` wins; then fewer unmapped files; then the default layout; then YAML order. An Agent Space export ranks `agent-space-folders` first; a package with `instructions/shared/` ranks `instruction-folders-shared` first, and a plain package goes to the default layout.

## Validation

```ts
validateDraftAsset(asset, { policy, previous? }): ValidationResult[]
validateAssetSet(desired, { policy, live?, perAsset? }): ValidationResult[]
validatePackage(contents, layout, { requireArchives?, zipLimits }): PackageValidation
// PackageValidation = { status: "passed" | "failed"; results; summary }  (summary = VALIDATION.json shape)
```

`validateDraftAsset` checks one asset: the metadata JSON Schema (required keys, agent type enums, GENERIC not combined with other agent types on skills, ACTIVE/INACTIVE, name patterns and lengths, 1 to 1024 character descriptions), the warning schema (memory names in kebab-case, GENERIC plus others on memory stores), the create schema (`skill_type` must be USER on create), immutable keys against `previous`, extra name patterns, file paths, the main file, 1.5 MB single text file, 6 MB zip (measured by zipping the files), 25 KB AGENTS.md with a warning above about 120 lines, 100 KB per memory, and frontmatter (SKILL.md must carry name and description for zip uploads and match metadata; AGENTS.md must not have frontmatter).

Frontmatter that isn't valid YAML is an error only where the service reads it (a zip skill: "For zip uploads the service reads `name` and `description` from the `SKILL.md` frontmatter", per the asset guide); for a single-file skill or a memory, whose metadata comes from the request, it is a warning. Results carry the file's `line` and `column` when the check knows them, and a `fix` when a safe change resolves them (`QuickFix` in `src/server/validation/types.ts`): `parseFrontmatter` finds a plain value holding ": " (with its continuation lines), reports the line and column of that colon, and offers the block with those values double-quoted (only when the result parses); a mirror mismatch offers the metadata value in the frontmatter (not for a zip skill, whose frontmatter wins); a memory name outside the service rule ("a `/`-separated path of lowercase kebab-case segments") offers the kebab-case name in its frontmatter and the file renamed to match.

`validateAssetSet` adds the space-wide rules. The resulting space is `live` with each desired asset replacing the live asset with the same `assetId`, or else the live asset of the same type and identity (an update), and the rest added. It checks unique identities (one AGENTS.md per agent type, unique skill, store and custom agent names, unique memory names per store), references (`memory_store_id`, custom agent `skills` and `memory_stores`, by ID against live and desired assets, or by name through `refs`), and counts (200 user skills, LEARNED excluded; 50 stores; 200 memories per store). A count error is reported only when the change adds assets.

A `requiredText` or `forbiddenText` rule names a `file`, or an `asset` (`{ assetType, metadata }`) whose folder's main file is checked, found by descriptor; `missing: skip` skips the rule when the package has no such file. A layout that checks the safety messages in the GENERIC instructions of an Agent Space export does it this way (`anycompany-folders` in `sample-data/policy/package-layouts.yaml`). The default layouts have no text rules.

`validatePackage` runs the package checks: skill frontmatter identity and name pattern, skill zips present and current, memory frontmatter identity, duplicate memory names, memory and index design targets (16 KB, 4 KB), index links inside the store, text patterns, required text, shared sections identical to their source, forbidden text and required files (the last four are the layout's `checks` and `sharedSections`; the default layouts define no text rules). `summary.errors` uses the wording of a Python validation script with package-relative paths. It is stricter than such a script in two ways: a skill zip must match every file in its folder, not only SKILL.md, and problems a script would crash on are reported as errors.

Schema helpers: `resolvedSchema(policy, assetType, kind?)` returns the schema with `$defs` filled in, for generated forms; `x-hint` on a property is the plain message shown when it fails.

## Building and checking

```ts
buildRelease(contents, layout, { zipLimits?, packageZip? }): BuildResult
// { ok; contents; changes: { path, change }[]; validation; results; packageZip: { fileName, data } | null }
checkPackage(contents, { policy?, layout?, live?, includeTypes? }): PackageCheck
// build + package checks + mapping + targetPackageAssets + validateAssetSet; { ok, build, mapped, target, results }
zipPackage(contents, topDir = contents.name): Buffer
```

With `includeTypes`, build, package and mapping results about only the other types (by asset key, by the asset a file belongs to, or by type folder: `isAbout`) are left out, so leaving memory out also leaves out its checks. Results about the whole package always count.

`buildRelease` runs the release build: copy each shared section (`common` in `instruction-folders-shared`) between its markers in the target files, regenerate each store's INDEX.md, rebuild each skill zip, run `validatePackage` and write `reference/VALIDATION.json`, then zip the package under one top folder when the checks pass. Text output follows Python's conventions, so it matches what a Python build script writes; zips have the same entries in the same order. It never writes to disk. Where such a script stops at the first problem, the build records an error, leaves that file unchanged and continues. Use `checkPackage` on every revision save and on import; publishing is blocked while `ok` is false.

## Export

```ts
exportPackageZip(desired, layout?, { policy?, packageName?, base? }): ExportResult
// { ok; contents; zip: Buffer; fileName; results; build }
desiredAssetsToPackage(desired, layout?, opts?): { contents, results }   // placement only, before the build
snapshotsToDesiredAssets(snapshots, policy): { assets, results }        // live AssetSnapshot[] -> DesiredAsset[] with name refs
snapshotsToLiveRefs(snapshots): LiveAssetRef[]
```

Export places each asset in the layout (the inverse of the mapping), recovers shared section sources from the files that embed them, writes metadata the files can't carry to the manifest (values equal to `manifestDefaults` or the layout's skill agent types are left out), then builds and zips the package. The zip is deterministic: entries sorted, fixed timestamps and permissions. With `base` (the revision's current files) the non-asset files are kept and an unchanged STORE.md keeps its own formatting, so exporting the assets of an unchanged package reproduces the built package exactly. Assets the layout has no place for (for example `agents_md` for an agent type with no file name, or custom agents in the instruction-folders layouts) are reported as `export.not-placed` warnings. In `agent-space-folders` each asset of a folder type goes to `<type dir>/<folder>/` with its files and a descriptor (`assetId`, `assetType`, `metadata` with references as asset IDs; a name reference to an asset with no ID yet is an `export.reference-by-name` warning). Folder names come from `types.<type>.folder` and `agentFolders` (`global`, `incident-rca`, `improvement`); a second asset with the same folder name gets `duplicateFolder` (`<name>__<assetId>`). `INDEX.json` lists every folder (the base package's other index keys are kept). Memory goes to `memory/` with the STORE.md rules. Exporting the assets of an Agent Space package and reading the zip back gives the same assets. A layout that requires files a live space can't supply (a shared section's source, optional agent files) fails its checks on an export without a base.

## Tests

Unit tests sit next to the code.

- `packages.test.ts` covers the layouts policy, the build (shared sections, indexes, skill zips), the checks and the export from live snapshots.
- `agent-space.test.ts` covers the folder layout on the synthetic package in `test-support/agent-space.ts`.
- `sample-data.test.ts` covers the sample packages and the sample Agent Space export in `sample-data/`, with the sample policy overlay.
- The default policy has no text rules, so `test-support/policy/package-layouts.yaml` adds two test layouts (`strict-shared` and `strict-folders`) that carry every kind of check with invented names. `testPolicy()` in `test-support/policy.ts` loads them over the app's policy.

Golden tests against a real organization's packages and its Python build and validation scripts are kept outside this repository. They run when copied or linked to `test/private/` (git-ignored), together with a policy overlay that restores that organization's layouts (`DAM_POLICY_OVERLAY_DIRS`).
