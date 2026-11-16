# Page: Release verification

Overrides `MASTER.md` for `/spaces/[alias]/releases/[name]/verification`, a second tab on the release page (`releases.md`). Data from `src/server/verify/`. Screen (example data on release v1.1 of the sample space): the verification tab in light and dark.

The rules cover checks 1 and 2 of verification (live state, and what the agent read). Check 3 (behavior, replay sets) is not in this page: it is Admin-only until replay permissions are designed, and it isn't built, so nothing for it renders (MASTER "Disabled and hidden actions").

## Changes to the release page

- The release header (`releases.md`, "Release detail") stays as it is, with the "Restore this release" wording.
- Under it, `LinkTabs`: "Assets and changes since <N>" (the existing content, `/releases/[name]`) and "Verification" (`/releases/[name]/verification`). The tab shows for every release; a release that no plan applied (created from the live state) still has both checks.

## Layout, top to bottom

1. Release header and tabs, Verification current.
2. One line of context, muted 13 px: "Applied by plan <plan title as a link> on <Time>. The checks compare the live space and what the agent read with this release." For a release made from the live state: "Created from the live space on <Time>. The checks compare the live space and what the agent read with this release."
3. **Live state** card.
4. **What the agent read** card.

## Live state card

- **Header:** `h2` "Live state", "Last checked <Time>, after the <Time> sync" in muted 12 px, and "Run check" (outline, Play).
- **At apply** row (`ValidationList` style): success "At apply, all <N> assets matched. The apply job read every asset back on <Time>." or destructive "At apply, <N> of <M> assets didn't match." with the plan link. From the apply run's read-back (`apply_runs`). Left out for a release no plan applied.
- **Now** counts row: "<N> match", "<N> changed" (warning-fg when above zero), "<N> missing" (destructive-fg), "<N> added since", then "See the <N> differences" (link to the Assets tab with `?show=changed`). The words map to the release page's change words: changed covers content, status and metadata changes; missing is "Deleted".
- "Run check" syncs the space and recomputes the counts against the manifest (the same drift the Assets tab shows), then records when it ran.

## What the agent read card

- **Header:** `h2` "What the agent read", "<N> investigations synced since the release · last checked <Time>", and "Run check" (outline, Play). Run check runs the deployed-vs-read analyzer (`src/server/analyzers/deployed-vs-read.ts`) on every journal synced after the release, against the release's package files.
- **Counts row:** "<N> received the release's body", "<N> received an older body" (warning-fg), "<N> requested, nothing returned" (warning-fg), "<N> never requested".
- **Toolbar:** a `ToggleGroup` "Needs a look <N>" (default) or "All <N>", and a "Type" filter (Instructions, Skills, Memories).
- **Table,** one row per package file, needs-a-look first:

  | Column | Content |
  |---|---|
  | File | Bold display name (`assetLabel`), the type label below ("Memory in chat-tool-use-best-practices", "Skill") |
  | Requested in | "<n> of <N>" investigations, right-aligned |
  | What the agent got | Icon and words from the verdict table, then a muted 12 px reason line |
  | Records | Up to one record link "<investigation title> · R<n>" (opens the journal at that record), then "and <N> more". "None" in muted text |

- **Footer:** "A file the agent never requested isn't a failure on its own: the agent may not have needed it." and "Show all <N> files".

**Verdicts** (from `DeployedVerdict`, summed over the investigations; the worst one wins in the row):

| Analyzer verdict | Words | Tone, icon | Reason line |
|---|---|---|---|
| `matches` | Received the release's body | success, Check | none |
| `near` | Received the release's body, almost exactly | success, Check | "<pkg>% of its lines matched" |
| `different`, matching an older version | Received an older body | warning, TriangleAlert | "Matches v<old>; the release has v<n>" |
| `different`, no older match | Received a different body | warning, TriangleAlert | "<pkg>% of its lines matched" |
| `requested-no-body` | Requested, nothing returned | warning, TriangleAlert | The likely reason when known: "Deleted from the live space since the release", "Inactive in the live space" |
| `not-read` | Never requested | muted, Minus | "Inactive in this release, so it isn't offered" for an inactive asset; "Store <name> was read in <N> investigations" when its store was referenced |

"Needs a look" holds every row that isn't a match, plus never-requested files that are Active in the release.

## States

| State | What shows |
|---|---|
| Loading | Both cards as `Skeleton` blocks under the header |
| Never checked | Each card: `EmptyState` "Not checked yet", body for live state "Check that the live space still matches this release.", for agent reads "Check what the agent read in the <N> investigations synced since this release.", action "Run check" |
| No investigations since | Agent reads card: `EmptyState` "No investigations since this release", body "Journals synced after <Time> show up here. Export journals to pull the latest ones.", action "Export journals" (`journals.export`) |
| Check running | The card's button shows a spinner and "Checking"; `JobProgress` replaces the counts; the page refreshes when the job ends |
| Check failed | Destructive callout in the card with the cause as a plain sentence (`liveErrorMessage`) and `ConnectionNextStep` when an Admin fixes it in settings |
| Stale | When the last check is older than the last sync or a newer journal: a muted line under the header "New journals since the last check" next to "Run check" |
| Read only (Viewer) | Both cards with the last results; no "Run check" |

## Permissions

| Action | Permission |
|---|---|
| See the tab and results | `history.read` (the release page's permission) |
| Run check (both) | `audits.run` until verify defines its own permission (open items) |
| Export journals | `journals.export` |

## Audit log

`verify.live.run` and `verify.reads.run` (release, counts), recorded as "Requested" when the job is accepted (MASTER audit log page).

## Data

- `getReleaseVerification(spaceId, releaseName)`: apply read-back result (plan ID, title, time, matched and total), live drift counts and last-checked time and sync time, the agent-read rows (asset ID, display name, type label, per-verdict investigation counts, the worst verdict, the older version it matched, up to three record references with investigation title, task ID and record number), the counts, the investigations considered and the last-checked time.
- Service functions: `runLiveCheck(spaceId, releaseName, actor)` and `runReadCheck(spaceId, releaseName, actor)`, each enqueuing a job.

## Components

`LinkTabs`, `StatusBadge`, `Callout`, `ConnectionNextStep`, `EmptyState`, `JobProgress`, `Time`, `ValidationList` (the at-apply row), shadcn `Table`, `ToggleGroup`.

## Open items

- **"Received an older body."** The analyzer compares a body with the package only. Saying "older" and naming the version needs the verify module to match the returned body against earlier versions of the same asset in the history repository (`assetContentHash` of each version, or the same line-share test). Without that, the row says "Received a different body".
- **Run check permission.** No `verify.*` permission exists. Editors (`audits.run`) is the current assumption; `sync.run` is the other candidate for the live check.
- **Investigation titles for record links.** The read check returns record numbers per incident; the link text needs the task title and the journal page's record anchor (see `audit-item.md`).
