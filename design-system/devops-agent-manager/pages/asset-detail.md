# Page: Asset detail and version compare

Overrides `MASTER.md` for `/spaces/[alias]/assets/[assetId]`. Code: `src/app/(app)/spaces/[alias]/assets/`, `history/`, `src/components/assets/`. Screens: the asset page (Content tab) and the version compare view.

## Routes

- One page with tabs in the URL: `?tab=content` (default), `versions`, `metadata`, `files`.
- Compare is the Versions tab with `from` and `to`: `?tab=versions&from=23&to=24`.
- The routes `history/[assetId]` and `history/[assetId]/diff` redirect to these URLs with `redirect()`, so old links keep working. `historyHref` and `diffHref` in `src/components/assets/format.ts` build the new URLs.

## Header (all tabs)

**Top bar breadcrumb:** "Assets › <Type plural> › <parent name, if any> › <name>". On the compare view it adds "› Compare v<from> and v<to>".

**`PageHeader`:**

- Icon box (40 px) with the asset-type icon:

  | Type | Icon |
  |---|---|
  | Instructions | FileText |
  | Skill | Puzzle |
  | Memory store | Database |
  | Memory | Brain |
  | Custom agent | Bot |
  | Artifact | Package |

- Title: the asset's display name (`assetLabel()` in `src/server/history/display-name.ts`): "Global instructions" and "<agent type> instructions" for instruction files, an artifact's `metadata.title` when its stored name is only its ID, else the stored name. The same name is used in the crumbs, the change feed, History, command search and the release and import tables. An instruction file adds "Agent type: <short label>" to the meta line, styled like a skill's agent types (`agentTypeLabel()`, "Global"); the agent type ID (`GENERIC`) appears only in its tooltip.
- Badges: the type label, then "Managed store" with a Lock icon when the existing `ManagedLabel` says so.
- Status control:
  - With `drafts.write`: a `Switch` labeled "Active" or "Inactive". Toggling it adds a status change to the user's draft, and a toast says "Added to your draft. Create a plan to apply it."
  - Without `drafts.write`: the same words with a Power or PowerOff icon, not a switch.
- Description: `metadata.description`, max 72 characters per line.
- Meta line: "Version <N> · Updated <Time> by <short source label> · Created <date>". A skill adds "Agent types: <short label>" chips (`agentTypeLabel()`, "Global") and "Tools: <tool>" chips in mono. Then a ghost button showing the short asset ID in mono (`ki-9184fa09`). Its tooltip says "Asset ID in the Agent Space. Click to copy.", its accessible name is "Asset ID in the Agent Space: <full ID>. Copy", and it copies the full ID.
- Actions:
  - "Add reason" (`reasons.write`) adds a reason to the latest change.
  - "Edit as draft" (`drafts.write`) is primary. Memories in managed stores can be edited (the API writes them). When plans.yaml `managed` turns editing off, it is disabled through `DisabledReason` with "Editing memories in managed stores is turned off in this app's plan rules. You can still switch them on or off."
- Deleted asset: a warning `Callout` above the tabs says "Deleted from the space on <Time>. Its history stays in the history repository.", with "Restore as a plan" (`plans.create`).

**Tabs:** shadcn `Tabs` rendered as links. Labels: "Content", "Versions <count>", "Metadata", "Files <count>".

## Content tab

Two columns: content card on the left, versions summary on the right (360 px, stacked below 1280 px).

**Content card.**
- Header: "<main file> · <size> · <lines> lines" in mono, and a `ToggleGroup` with "Rendered" and "Source".
- Rendered: YAML frontmatter shows as a definition list. A frontmatter value that is a list of objects (such as memory `claim` entries) shows as a small table whose columns are the object keys, with long text wrapping. The markdown body renders through `SafeMarkdown`.
- Source: the raw file in a monospace block that scrolls sideways.

**By asset type.**

| Type | Extra content |
|---|---|
| Instructions | The existing `SizeMeterView` above the content: size against the 25 KB limit and lines against the recommended 120, both from policy limits. Tones: success under the recommended lines, warning above, destructive over the limit. |
| Skill | When it has more than one file, a `PathTree` of files on the left of the content. Frontmatter fields `agent_types` and `enable_tools` show as badges in the meta line. |
| Memory store | A table of its memories (name linked, status, `VersionBadge`, last change) under the store file. |
| Custom agent | The skills and memory stores it references, by name, each linked. |
| Artifact | The file list with download links. No rendered view. |

**Versions summary card.**
- Header "Versions", with "Compare v<N−1> and v<N>".
- Cadence line, only when one source made five or more versions: "<Source> updated this <type> <count> times, about every <median interval>."
- The four newest versions: `VersionBadge`, `SourceBadge`, date, and an optional note line (reason, principal, or the attribution note in MASTER "Open items").
- Footer: "Show all <N> versions" opens the Versions tab.

## Versions tab and compare

**Version strip.** Shown when the asset has 60 versions or fewer. One button per version, colored with its source token at 22% plus a 1 px border in the source color. A selected version uses the full color with a 2 px ring. Each button has `aria-label="Version <n>, <source>"` and `aria-pressed`. Picking two versions sets `from` and `to`. Under the strip: labels every 5 versions, and the first and last dates. A legend lists only the sources that appear.

**Version table** (always shown, below the strip). Columns: version, source, "Changed by" (the principal), `Time`, kind, reason. Row actions: "View" (that version's content), "Compare with previous", and "Restore this version" (`plans.create`, editable types) on the newest entry of each version other than the current one (every version once the asset is deleted). It creates the same plan as "Restore v<N> as a plan". A line above the table says "Restoring a version creates a plan. Nothing changes in the space until the plan is applied."; when the managed-store reason applies, the buttons are disabled and that line reads "Restore is off: <reason>" with a Lock icon, linked to each button by `aria-describedby`.

**Compare panel** (when `from` and `to` are set).
- Bar: from and to as `VersionBadge`, `SourceBadge` and date, with an ArrowRight between them; "+N" in success-fg and "−M" in destructive-fg; a Content or Metadata `ToggleGroup`; and Unified or Split (Split only at 1024 px and up).
- Attribution note `Callout` (info), only once the open item in MASTER is decided.
- Diff: the existing `FileDiffView` restyled to MASTER "Diffs": line numbers, hunk headers, tint percentages from the tokens rules, sideways scrolling.
- Metadata: the existing `ValueChanges`.
- Footer: "Restoring an older version creates a plan. Nothing changes in the space until the plan is applied." and "Restore v<from> as a plan" (`plans.create`). Disabled through `DisabledReason` with the same managed-store reason when it applies.

## Metadata tab

A key and value table of the current metadata. Below it, "Changed in v<N>" with `ValueChanges` against the previous version.

## Files tab

Table: path (mono, linked to download through `fileDownloadHref`), size (right-aligned), SHA-256 (short hash, full value in a tooltip), committed (yes or no).
