# Page: Releases, release detail and restore preview

UI text says "Restore", never "roll back" (MASTER "Copy"). Route names, code identifiers and audit actions (`rollback.plan`) keep "rollback".

Overrides `MASTER.md` for `/spaces/[alias]/releases`, `/spaces/[alias]/releases/[name]` and `/spaces/[alias]/releases/[name]/rollback`. Screens (example data): the releases list, the create release dialog, release detail (light and dark) and the restore preview.

The package export dialog opens from these pages; it is specified in `package-import.md`.

The rules cover version history, releases and rollback.

## What a release is

- An annotated git tag `<space-alias>/<name>` in the space's history repository.
- A manifest `releases/<space-alias>/<name>.json` in the tagged commit. It holds, per asset, the asset ID, service version, content hash (`assetContentHash`) and metadata, including `status`.
- The manifest stores metadata itself, because a status change doesn't create a new version.

## Releases list

**Layout, top to bottom.**

1. **Top bar:** breadcrumb "<space name> › Releases"; `SyncStatus`.
2. **`PageHeader`:**
   - Title "Releases".
   - Description: "A saved snapshot of every asset that you can restore later." (`RELEASE_SENTENCE`)
   - Actions: "Export package" (outline, Download icon, `history.read`), which opens the export dialog with the latest commit selected. "Create release" (primary, Tag icon, `releases.create`).
3. **Card:**
   - Header: `h2` "<N> releases", and "Saved in the history repository <repository>" with the repository name in mono.
   - Table:

     | Column | Content |
     |---|---|
     | Release | Bold name linked to the detail page, a "Latest" badge on the newest, the tag in mono 12 px below |
     | Assets | Count in the manifest, right-aligned |
     | Changes since | Recorded asset changes after the tagged commit, right-aligned |
     | Created by | Name |
     | Created | `Time`, right-aligned |

   - Order: newest first. Over 50 rows, "Show more".

**Empty state.** `EmptyState` "No releases yet", body "Create one before a risky change, and you can go back to it in one plan." (the header already carries the release sentence), action "Create release" (with `releases.create`).

## Create release dialog

A shadcn `Dialog` (not an `AlertDialog`: nothing is written to the space).

- **Title:** "Create a release". **Description:** "A saved snapshot of every asset that you can restore later." then "Saves the current state of <space name> so you can compare with it and restore it later."
- **Name:** `Input`, required. Help: "Letters, numbers, dots and hyphens. The git tag is <tag>.", where the tag updates as the user types. The name rule goes in `policy/releases.yaml`. Field errors, under the field with `role="alert"`:
  - "A release named <name> already exists."
  - "Use letters, numbers, dots and hyphens."
- **Notes:** optional `Textarea`. Help: "Saved in the tag message and shown on the release page."
- **Facts,** a definition list:
  - Pins: "<N> live assets, each with its version, content hash and metadata".
  - Manifest: the path, in mono.
  - Repository: the repository name, in mono.
- **Info callout:** "The app syncs the space first, so the release matches the live space at this moment."
- **Buttons:** "Cancel" (outline) and "Create release <name>" (primary, Tag icon).
- **Disabled reasons** for the create button:
  - "Enter a name."
  - "Plan <title> is applying. Create the release after it finishes."
- **Confirming** starts a job (sync, manifest, commit, tag) and shows `JobProgress` in the dialog. When the job finishes, go to the new release page. If it fails, a destructive callout in the dialog gives the error and keeps the form. When the error is one an Admin fixes in Space settings (`liveErrorNeedsSettings`), `ConnectionNextStep` follows it.
- **While the connection is down:** a release of HEAD syncs first (`releases.syncBeforeCreate`), so when `connectionView(space, sync)` is `failed` or `rejected`, "Create release" is disabled up front through `DisabledReason`: "A release starts with a sync, and the app can't reach the space." then the cause, then `ConnectionNextStep` when `needsSettings`. The dialog doesn't open. A release of a given commit (tag after apply) doesn't sync and stays enabled. The server action is unchanged.

## Release detail

**Layout, top to bottom.**

1. **Top bar:** breadcrumb "Releases › <name>"; `SyncStatus`.
2. **Header** (the asset page header pattern):
   - Icon box with Tag, `h1` the name, and "Latest" on the newest release.
   - The notes as the description (72 characters per line), else "A saved snapshot of every asset that you can restore later."
   - Meta: "Created <Time> by <name> · <N> assets · Tag <tag in mono> · Commit <short hash in mono>".
   - Actions: "Export as package" (outline, Download, `history.read`), which opens the export dialog with this release selected. "Restore this release" (primary, Undo2, `plans.create`), which opens the restore preview. Opening the preview writes nothing.
3. **Stat tiles,** "Changes since this release":

   | Tile | Value | Detail |
   |---|---|---|
   | Unchanged | count | "Same version, content and metadata" |
   | Changed | count | Breakdown: "2 content, 1 status, 1 metadata" |
   | Deleted since | count, in destructive-fg when above zero | "Restore creates it again with a new ID" |
   | Added since | count | "Restore sets it Inactive" |

4. **"Assets in this release and changes since" card:**
   - Header: the manifest path in mono 12 px, and a `ToggleGroup` "Changed <n>" or "All <n>" (`?show=changed|all`; default `changed`).
   - Table:

     | Column | Content |
     |---|---|
     | Asset | Bold name over the type label |
     | In release | `VersionBadge` and status word; the short content hash below in mono 12 px ("sha 9c2e41a"), the full hash in a tooltip. "Not in this release" for added assets |
     | Live now | `VersionBadge` (or `deleted`) and status word. For metadata changes, a second line: "Key added: <key>", "Key removed: <key>" or "<key> changed" |
     | Change | Icon and text from the table below |
     | Last change | `SourceBadge` and `Time` of the newest change since the release. Empty for "Same" |

   - Footer: "Show <N> unchanged assets", which switches to All.

**Change words,** in priority order (the first that applies):

| Change | Tone, icon | When |
|---|---|---|
| Deleted | destructive, CircleX | In the manifest, not live |
| Added since | success, CirclePlus | Live, not in the manifest |
| Content changed | info, SquarePen | Content hash differs |
| Status changed | agent color, Power | Only `status` differs |
| Metadata changed | agent color, SquarePen | Other metadata keys differ (`metadataHash`) |
| Same | muted, Equal | Shown only in All |

Drift compares the manifest with the asset index as of the last sync. The meta line says nothing about live freshness; `SyncStatus` in the top bar covers it.

**Empty and edge states.**
- **Nothing changed:** the Changed view shows `EmptyState` "The live space matches this release", body "Every asset has the version, content and metadata pinned in <name>." The restore button is disabled through `DisabledReason` with "Nothing to restore: the live space matches <name>."
- **Release not found:** the Next.js `notFound()` page.

## Restore preview

A read-only page that shows what a restore plan will do before the plan exists. It writes nothing and records nothing.

**Layout, top to bottom.**

1. **Top bar:** breadcrumb "Releases › <name> › Restore"; `SyncStatus`.
2. **`PageHeader`:** title "Restore release <name>". Meta: "Compared with the live space as of the last sync, <RelativeTime>. Nothing is written until the plan is applied."
3. **Callouts,** most severe first:

   | When | Tone | Title | Body | Action |
   |---|---|---|---|---|
   | Some assets can't be restored | warning | "<N> asset(s) can't be restored yet" | Names and reason, for example  "categories/testing-mcp-servers: The DevOps Agent maintains memories in managed stores, so a release restore leaves it as it is. To go back to an older version, restore it from its Versions tab. The plan leaves it at v3." | none |
   | The last sync is stale or failed (MASTER sync states) | warning | "This preview may be out of date" | "Last sync <Time>. The plan re-checks the live space, but sync first to preview it accurately." | "Sync now" (`sync.run`) |

4. **Two columns:** "What the plan will do" on the left; "Create the restore plan" on the right (340 px, the plan review width).

**What the plan will do.** One table with group header rows (`bg-muted`, 12 px semibold, colspan). Show each group only when it has rows, in this order:

| Group | Live now | After apply | Why (stored as the plan item's `note`) |
|---|---|---|---|
| Restore content | `v<now>` | "v<release> content, written as v<now + 1>" | "<source> changed it <Time>." |
| Restore status | `v<N>` and status | `v<N>` and the release's status | "Status only, so no new version." |
| Recreate | `deleted` | "v<release> content and metadata", `new` | "Gets a new asset ID." plus "No custom agent references it." or "Custom agents <names> reference it; their IDs are remapped." |
| Set Inactive | `v<N>` Active | `v<N>` Inactive | "Added after the release: set Inactive instead of deleting." |
| Remove metadata keys | "<key> set" | "<key> removed" | "Added after the release. plans.yaml `write.metadataRemoval` decides how a key is removed." |
| Left out | as live | "v<N>, unchanged" | The reason, from the rules below |

- Header count: "<rows> of <manifest plus added> assets".
- Footer: "Show <N> assets that already match".

**Rules,** for the rollback edge cases:

- **Restore content:** the plan item's desired state is the release's files and metadata, read from git at the tag. The write creates a new service version; history is never rewritten.
- **Recreate:** a create item with `refs`, so custom agents that reference the asset get the new ID.
- **Added since:** types with `supportsStatus` in `asset-types.yaml` are set Inactive. Other types (instructions, custom agents, artifacts) go to "Left out" with "Left as it is: <type plural> can't be set Inactive, and deletes are off."
- **Metadata keys added since:** listed in the item's `removeMetadataKeys`.
- **Managed-store memories:** content restores go to "Left out" with "The DevOps Agent maintains memories in managed stores, so a release restore leaves it as it is. To go back to an older version, restore it from its Versions tab." (`releases.yaml` `rollback.notes.managed`).

**Create the restore plan card.**
- Plan title: an `Input`, default "Restore <space alias> to release <name>" (`releases.yaml` `rollback.titles`; a version restore is "Restore <asset name> to v<N>").
- Facts: Changes "<N> assets"; Approval (the space setting, worded as in `plan-review.md`); Apply needs "The Publisher role" (`rollbacks.apply`).
- Button: "Create restore plan" (primary, GitPullRequest, `plans.create`). It calls `createPlan` with `origin: { kind: "rollback", target: { kind: "release", releaseId, name } }` and goes to the plan page in "checking".
- Help: "The plan re-reads the live space. You review each diff and apply it on the plan page, like any plan."
- Disabled reason: "Nothing to restore: the live space matches <name>."

The same preview can serve a commit target ("Restore <space alias> to commit <short hash>"). Where a commit rollback starts is not designed.

## Permissions

| Action | Permission | Without it |
|---|---|---|
| See releases and the preview | `history.read` | Nav item hidden (MASTER) |
| Create release | `releases.create` | Button hidden |
| Restore this release (preview and plan) | `plans.create` | Button hidden |
| Apply the restore plan | `rollbacks.apply` | Shown on the plan page (`plan-review.md`) |
| Export | `history.read` | |

## Audit log

Record `release.create` (name, tag, commit, asset count, result) and `plan.create` (origin `rollback`, the release). The export dialog records `package.export` (`package-import.md`).

## Data

- Loaders:
  - `listReleases(spaceId)`: name, tag, commit, asset count, changes since, author, created.
  - `getRelease(spaceId, name)`: the manifest, the drift rows above, and the counts.
  - `previewRollback(spaceId, name)`: the grouped rows, the plan items, and the left-out reasons.
- Service functions for the Server Actions: `createRelease(input, actor)` and `createRollbackPlan(spaceId, name, title, actor)`.

## Open items

- **Release name rule.** The original design doesn't give one. This page assumes letters, numbers, dots and hyphens, which git tag names accept. Keep the rule in `policy/releases.yaml`.
- **Sync before release.** The dialog says the app syncs first, so the manifest matches the live space. The cheaper alternative is to pin the last synced state and show its age. Syncing first is the current behavior.
