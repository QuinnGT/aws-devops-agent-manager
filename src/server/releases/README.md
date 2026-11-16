# Releases and rollback

Version history, releases and rollback; releases are tags and manifests in the history repository, and every action goes to the audit log. Rules live in `policy/releases.yaml` (section `src/server/policy/sections/releases.ts`).

## Releases

A release is an annotated tag `{spaceAlias}/{release}` (historyLayout.releaseTag) on a commit that adds `releases/{spaceAlias}/{release}.json` (historyLayout.releaseManifest). The manifest lists every asset under the space root at its **source commit** (HEAD when requested, or the commit of an apply):

```ts
interface ManifestAsset { assetId; assetType; key; name; serviceVersion; serviceUpdatedAt; contentHash; metadataHash; metadata; gitPath }
interface ReleaseManifest { format: 1; space: { alias; agentSpaceId; region }; release: { id; name; tag; createdBy; createdAt; note; planId }; sourceCommit; assets }
```

`contentHash` is `assetContentHash(asset.json files)` and `metadataHash` is `metadataHash(metadata)` from `src/server/history/content-hash.ts`. `serializeManifest` writes deterministic JSON (keys sorted, assets sorted by type, key and ID).

- `requestCreateRelease({ spaceId, name, note?, commit?, planId? }, actor)` validates (name pattern from policy plus git ref rules, duplicates in Postgres and in tags, case-insensitive by default) and enqueues `releases.create`. Pass `commit` and `planId` to tag the commit an apply made.
- When the release is of HEAD (no `commit`) and `releases.syncBeforeCreate` is on (default), the job first runs an incremental sync of the space through `syncSpace` with the deps the sync job builds (`sync-first.ts`); `syncSpace` takes the space's sync lock. A failed, skipped (lock held) or cancelled sync fails the job with "The release wasn't created because ...". A release of a given commit (tag after apply) never syncs. The job doesn't retry automatically (`retryLimit: 0`), so a failure the dialog reported can't turn into a release later.
- The worker job commits the manifest (author: the user; committer: `releases.committer`; trailers `Release-Id`, `Release`, `Source-Commit`, `Space`, `Plan-Id`), creates the tag, pushes when the repository allows it, inserts the `releases` row and records `release.create`. A retried job finds its own commit or tag by `Release-Id` and finishes the same release.

## Rollback

`createRollbackPlan({ spaceId, target, reason? }, actor, deps?)` builds the items and calls `createPlan` with `origin: { kind: "rollback", target }`. Targets: `{ kind: "release", releaseId }`, `{ kind: "commit", commit }` (abbreviated hashes are resolved) or `{ kind: "version", assetId, version }`.

| Case | Plan item |
|---|---|
| Asset still exists (same ID) | Update with the target's metadata and files; `baseVersion: null` |
| Deleted since, and nothing took its name | Create (no `assetId`), note `recreated` |
| Deleted since, and a new asset took its name | Update the new asset, note `replaced` |
| Reference to an asset that is created again | Its ID is dropped from metadata; `refs` carries every reference by name, so apply resolves the new ID |
| Metadata keys added after the target | `removeMetadataKeys` (minus `rollback.keepMetadataKeys` and the type's `immutableKeys`) |
| Added after the target (release or commit only) | Per `rollback.addedAfterTarget`: skills `deactivate` (the current files with status INACTIVE, `baseVersion` set to the current version so the plan check flags later changes), other types `keep` (preview row only), or `delete` (plan `deletes`) |
| Managed stores and their memories | Skipped when `rollback.managed: skip` |
| Types with `editable: false` | Skipped |
| A file git doesn't hold, or a version git never recorded | Read with GetAsset, ListAssetFiles and GetAssetContent with `assetVersion` through the read role (`deps.fetchVersion` or `deps.client` in tests); a file is used only when its SHA-256 matches git |
| Content in neither git nor the service | Error problem: `createRollbackPlan` refuses, the preview shows it |

Items are ordered so referenced types come first (stores and skills before memories and custom agents).

## Loaders

- `loadReleaseList(space)`: releases, repository state, the name rule for the form.
- `loadReleaseDetail(space, releaseId)`: manifest table with drift per asset against the current index, drift counts, tag presence.
- `loadReleaseCompare(space, fromId, toId)`: diff of two manifests.
- `loadRollbackPreview(space, target, actor, deps?)`: what the plan will contain (rows, counts, problems, validation), without file contents.
- `loadReleasePage(space, name)`: the detail by name, plus `table` (manifest assets and assets added since, each with its change word, versions, status, metadata key changes and the newest change since) and `counts` (`views.ts`, `buildReleaseTable`).
- `loadRollbackPage(space, name, actor)`: the preview of a release grouped as on the page (`groupRollbackRows`: restore content, restore status, restore metadata, recreate, set Inactive, remove metadata keys, delete, left out, and the rows that already match).
- `loadLatestRelease(space)`: the newest release with `changesSince`, for the Releases card on Home.
- "Changes since" a release counts recorded asset changes whose service time is after the newest `serviceUpdatedAt` in its manifest (`releaseAnchor`).

Permissions (`RELEASE_PERMISSIONS`): read pages with `history.read`, create releases with `releases.create`, create a rollback plan with `plans.create`; applying it needs `rollbacks.apply` (`applyPermissionFor`).
