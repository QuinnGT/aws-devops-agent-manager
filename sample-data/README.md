# Sample data: AnyCompany Tickets

Everything in this folder is invented. AnyCompany Tickets is a fictional company that sells tickets for concerts, sports and theater on AWS in `us-west-2`. Its DevOps Agent runs in the Agent Space `AnyCompany-Tickets-Sample` (ID `00000000-0000-4000-8000-0000000000aa`, account `111122223333`), and its instruction package has two versions: v1 and the audited v2. Times in journals are UTC.

| Folder | What it holds | Used by |
|---|---|---|
| `policy/` | A sample policy overlay: layouts `anycompany-v1`, `anycompany-v2` and `anycompany-folders`, the AnyCompany tool-call pattern and the two safety responses. It is merged over the app's `policy/` the way a history repository's `policy/` is | `samplePolicy()` in `test/helpers/fixtures.ts`, the package and verification tests |
| `packages/v1/` | Instruction package v1 in the instruction folders layout (`instructions/`, `skills/`, `memory/`, `reference/`) | `src/server/packages/sample-data.test.ts` |
| `packages/v2/` | Package v2: the same layout plus `instructions/shared/handoff.md`, a shared section the build copies into the triage and RCA files | the same test, and `src/server/verify/sample-live-runs.test.ts` |
| `packages/agent-space-export/` | The v2 content as an Agent Space export (`agent-space-folders` layout): one folder per asset with `_asset.json`, an `INDEX.json`, two custom agents and an older INACTIVE copy of the `cache-path-check` skill | `src/server/packages/sample-data.test.ts` |
| `journals/live-runs/` | Four live investigations (`INCIDENT-20201` to `INCIDENT-20204`) from 2026-11-03, in the record-created export format, newest record first | `src/server/verify/sample-live-runs.test.ts` |
| `journals/benchmark/` | Eight audited investigations (`INCIDENT-20101` to `INCIDENT-20108`) with their ground truth: a root cause document and a scorecard each | the analyzer, journal import, audit and review tests |
| `audit/` | The reference audit of the eight benchmark runs: one review per incident and the golden analyzer outputs | the analyzer, audit, review and report tests |
| `expected/` | What the tests expect: `packages.json` (asset counts, check results, the v1 to v2 comparison, the export), `verify-live-runs.json` (check 2 on release v2) and `benchmark.json` (the benchmark and audit numbers) | the tests above |

## Benchmark journals and audit

Eight investigations the DevOps Agent ran between 2026-10-26 and 2026-11-01, while package v1 was live. Each was scored against a person's confirmed root cause, and auditing them produced the changes that became v2.

| Incident | Title | Score | Primary failure mode |
|---|---|---|---|
| INCIDENT-20101 | Seat holds released early during an on-sale | 1/5 | F_premature_ruleout |
| INCIDENT-20102 | Card payments declining for one acquirer | 2/5 | C_change_anchoring |
| INCIDENT-20103 | Order confirmation emails delayed | 2/5 | D_wrong_component |
| INCIDENT-20104 | Mobile sign-in failures | 1/5 | B_access_failure |
| INCIDENT-20105 | New events missing from search | 3/5 | H_ran_too_early |
| INCIDENT-20106 | Price at checkout differs from the event page | 2/5 | I_memory_or_skill_misled |
| INCIDENT-20107 | Checkout error-rate alarm at 03:10 PT | 3/5 | K_chronic_noise |
| INCIDENT-20108 | Venue maps not loading for some users | 4/5 | J_summary_mismatch |

Each `journals/benchmark/INCIDENT-201xx/` folder holds:

- `INCIDENT-201xx_full_journal.md`: the journal in the numbered-record export format (33 to 44 records). A memory read or skill load returns the whole v1 file as it is in `packages/v1`.
- `201xx_actual_rca.md`: the person's root cause document (summary, timeline in PT, root cause, trigger, fix, follow-ups). INCIDENT-20101 is partly uncertain: nobody knows why the cache setting was removed.
- `INCIDENT-201xx_scorecard.md`: the score, the verdict and the comparison agent's score, the three fields the benchmark audit profile reads.
- `INCIDENT-201xx_devops_journal.md`: the agent's own condensed answer. Ground-truth matching must report it as a file that matches no input.

`audit/` holds the reference audit of the eight runs:

- `reviews/INCIDENT-201xx.json`: one reference review per incident. Records are cited as `R<n>` with the quote inline, and every quote was checked against the record it cites. The fixes use every fix owner the benchmark review schema allows.
- `metrics.json` and `memory_usage.json`: golden outputs for the run metrics and memory reads analyzers. They were produced by an independent Python implementation of those analyzers (a journal parser and a memory usage pass), not by the app's TypeScript code, so the tests compare two implementations. The Python scripts are not part of this repository.

`expected/benchmark.json` lists the numbers tests may assert: records per journal, scores, failure modes, citations checked per review, findings per review by kind, and report counts.

## How the package and the overlay fit together

Package v1 uses the layout `anycompany-v1` and v2 uses `anycompany-v2`. Both extend the app's base layout for the instruction folders (see `extends` in `policy/package-layouts.yaml`) and replace its tool-call pattern and its required safety responses with AnyCompany's. `anycompany-v2` adds the `handoff` shared section. The export uses `anycompany-folders`, which extends `agent-space-folders` the same way. Pass the overlay's policy to the package functions, for example:

```ts
const policy = samplePolicy();                       // app policy plus sample-data/policy
const contents = await readPackageFolder(samplePackageDir("v2"), { policy, layout: "anycompany-v2" });
const check = checkPackage(contents, { policy, layout: "anycompany-v2" });
```

## Skill zips are built, not committed

A skill folder has no `.zip` beside it, because binary files stay out of the repository. The layouts ask for `skills/<name>.zip` (`requireArchives`), so a check on the raw folder reports `package.archive-missing` for each skill. `checkPackage` and `buildRelease` create the zips in memory before they check, so read the folder and call `checkPackage` (or `exportPackageZip` to get a zip). The other generated files are committed and current: each store's `INDEX.md`, the shared section copies in `instructions/incident-triage.md` and `instructions/incident-rca.md`, and `reference/VALIDATION.json`. The tests fail if the build would change any of them, so after you edit a package, run the build on it and commit the files it changes.

## The memory files

Each memory file has frontmatter (`name`, `description`), the body, then two closing lines that are the same in v1 and v2:

```
Memory: <store>/<name>
Review this memory when an incident shows it is wrong.
```

The deployed-vs-read analyzer needs at least two matching lines of 25 or more characters to tell which version of a memory a journal shows, and several bodies are one short sentence. The closing lines supply those two lines. Journals that return a memory body, such as the live runs, return the whole file, closing lines included.

## Live runs and check 2

Release v2 was sent on 2026-11-02, yet the four live runs show the agent reading the v1 bodies of `services/seat-map-service`, `patterns/cache-evictions`, `change-feed-windows` and `log-query-limits`. It reads `roles/on-call-routing` and the skills in their v2 wording. `expected/verify-live-runs.json` lists what check 2 reports: the four memories as read in v1, six other files as the release's body, and eight files not read.
