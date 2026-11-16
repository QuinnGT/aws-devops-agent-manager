# Release verification

Checks 1 and 2 of release verification (replays, check 3, are not built here). Rules live in `policy/verify.yaml` (section `src/server/policy/sections/verify.ts`). Works for any release, whether or not a revision made it.

## Check 1: live state (`verify.live`)

The job runs the reconcile sync a release runs first (`syncSpace(..., { mode: "reconcile" })`, under the space's sync lock; policy `verify.live.syncFirst`), then compares every manifest asset with the live index through the releases module (`driftAgainstIndex`, `buildReleaseTable`). `compareLive` (pure, `live.ts`) gives each asset one outcome:

| Outcome | When |
|---|---|
| `matches` | Same asset ID, same content (content hash, or service version when git has no hash), same metadata including status. A newer version with the same content still matches (`newerVersion: true`) |
| `changed` | `changes` lists `content`, `status`, `metadata` (other keys, with `metadataChanges`) and `recreated` (deleted and created again under the same name) |
| `missing` | In the release, not live |
| `added` | Live, not in the release |

Rows carry the newest recorded change since the release (`lastChange`: source, principal) and `pendingSync`. A sync error from AWS blocks the run as `space-unreachable`; another error as `sync-failed`; a held lock as `sync-busy`.

## Check 2: what the agent read (`verify.reads`)

1. **Package files** (`package-files.ts`): the release's skill and memory files at its source commit, in the deployed-vs-read analyzer's shape: for a memory `name` is the store and `path` the file under it (`db/failover.md` for the memory `db/failover`), so the analyzer's template gives `/aidevops/memory/<store>/<memory>.md`; for a skill, `SKILL.md`. An asset whose asset.json doesn't match the manifest's content hash is skipped (`not-in-git`). Instructions (`agents_md`) and stores have no deployed path (`not-compared`); inactive assets and memories in managed stores are skipped unless policy includes them. `desiredAssetsWithFiles` does the same for a package's desired assets.
2. **Investigations**: journal tasks created in the release's window (`window.ts`, policy `verify.reads.window`), newest first, at most `maxInvestigations`.
3. **Analyzer**: `runAnalyzersJob` with `deployed-vs-read` and the package, so outputs are stored in `analyzer_runs` (the analysis page shows them) and an unchanged rerun is skipped. The job reads them back by the package digest.
4. **Versions**: for a body that isn't the release's (`near` or `different`), the file's other versions from the history repository (`listAssetCommits`, at most `versionsPerFile`, nearest first) are compared with the same journal. A version whose body the analyzer calls a match names what the agent read.
5. **Aggregation** (`reads.ts`, pure): one outcome per investigation and file, then per file counts, matched versions, the first differing lines and example records (`examplesPerFile`), with record IDs for links.

Outcomes, in the order files are listed (a file's verdict is the first one any investigation had): `older-body` (the agent read an earlier version of the file), `other-body`, `newer-body`, `release-body`, `near-release`, `requested-no-body`, `not-requested`. The check's verdict is `failed` when any file has an older, other or newer body, `passed` when bodies were the release's, `inconclusive` when no body came back.

On the four sample live runs with release v2 and v1 as the earlier version (`sample-live-runs.test.ts`, `sample-data/expected/verify-live-runs.json`), the check reports the four memories the agent read in their v1 wording as `older-body` (v1), six other files as `release-body`, and eight files as not requested.

## Running by itself

`withReadsCheckAfter` wraps the `journals.export` and `journals.import` handlers (`src/server/journals/jobs.ts`): when the run added investigations to a space, `queueReadsAfterJournals` queues `verify.reads` for the chosen release (`verify.reads.auto.release`: `latest` or `latest-applied`) when `verify.reads.auto.enabled` is on, the release has investigations in its window, and no check of it is queued or running. Actor `system:verify.reads`; the run records the journal job in `triggeredByRunId`. A failure to queue is logged and never fails the journal job.

## Starting a check and reading results

- `requestVerification({ spaceId, releaseId, kind }, actor, deps?)`: the caller has checked `sync.run` (`VERIFY_PERMISSIONS.start`). Looks the release up in that space, returns an open check of the same kind instead of starting a second, enqueues the job and records `release.verify` in the audit log.
- `loadReleaseVerification(space, releaseName)`: the caller has checked `history.read`. Per check: `latest`, `open` (for polling), `lastResult` with the result, `history`, and `cannotRun` (`no-repo`, `not-cloned`, `manifest-invalid`, `space-unreachable` from the connection status, `no-journals` when the window is empty). Example records carry `href` (`/spaces/<alias>/journals/investigations/<taskId>#rec-<recordId>`). Also the window, the cap, `syncFirst` and the auto settings.

`verification_runs` (`src/server/db/schema/verify.ts`) holds one row per run: release, kind, state (`queued`, `running`, `succeeded`, `blocked`, `failed`, `cancelled`), trigger, who, result JSON (`LiveCheckResult` or `ReadsCheckResult`, `types.ts`), blocked reason and message, the investigations covered, times and the job run.
