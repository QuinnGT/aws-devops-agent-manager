# Concepts

This page explains the ideas behind the screens, using the words the app shows. The examples come from the sample space, AnyCompany Tickets (see [`sample-data/README.md`](../sample-data/README.md)). To see each screen while you read, run the demo (see [Getting started](getting-started.md)).

Contents: [Agent Space assets](#agent-space-assets), [History and sync](#history-and-sync), [Drafts, plans and apply](#drafts-plans-and-apply), [Releases and restore](#releases-and-restore), [Release verification](#release-verification), [Journals and analyzers](#journals-and-analyzers), [Audits](#audits), [Revisions](#revisions).

## Agent Space assets

AWS DevOps Agent keeps the configuration of an Agent Space as [assets](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent-managing-assets.html). The app shows them in the console's words:

| In the app | What it is |
|---|---|
| Instructions | One AGENTS.md file per agent type, for example "Global instructions" and "Incident triage instructions" |
| Skills | A folder of files with a `SKILL.md` that holds a name, a description and the steps for a task |
| Memory stores and Memories | A store groups memories. A memory is one markdown file, for example `services/seat-map-service` in the store `service-catalog` |
| Custom agents | An agent definition with its own instructions |
| Artifacts | Assets the service lists but does not let you create through the API. The app shows them and does not edit them |

Each asset has a name, metadata, one or more files, a version number that the service raises on every change, and, for skills, memory stores and memories, a status of Active or Inactive.

Four memory stores (`understanding-agent-space`, `chat-tool-use-best-practices`, `monitors` and `reflections`) are managed: the DevOps Agent maintains them. A release restore leaves them alone. [`policy/asset-types.yaml`](../policy/asset-types.yaml) holds the asset types, their metadata rules and which of them the app can edit.

A space in the app is one registered Agent Space: an alias, an AWS Region, an account, the Agent Space ID, and the AWS access the app uses (a local profile, or a read role and a write role). See [AWS setup](aws-setup.md).

## History and sync

Each space writes to a **history repository**, a git repository on the machine that runs the app (`DAM_DATA_DIR/history/<name>`). An Admin can add a remote and a deploy key in App settings so the app pushes it. Without a remote the home page warns that the history exists only on this machine.

A **sync** reads the space and records what changed:

1. It lists the assets updated since the last sync, with a few minutes of overlap.
2. It reads each new version of those assets.
3. It commits one change per version to the history repository, under `spaces/<alias>/`, with the time of the version.
4. It works out who made the change (below) and puts that in the commit.

Syncs run every 15 minutes by default (`policy/sync.yaml`), when someone selects "Sync now", and as a daily full reconcile that also finds deleted assets. Releases, revisions and verification run a reconcile first, so they match the live space at that moment.

A person can add a reason to any change ("Add reason" on History or the Versions tab). The reason is stored as a git note on the commit, so it travels with the history.

### Change attribution

Every change shows who made it. The source comes from CloudTrail, which records the write calls against the space:

| Source | Meaning |
|---|---|
| This app | A plan this app applied. The app sends a client token with each write and matches it to the CloudTrail event |
| Web app | The DevOps Agent's [Operator Web App](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent-what-is-a-devops-agent-web-app.html). Matched by the role name pattern in `policy/attribution.yaml` |
| CLI or SDK | A write event from any other principal |
| DevOps Agent | A version with no matching write call. The app shows it as made by the agent, because CloudTrail recorded no API call for it |
| Unknown | The lookup failed, the change is older than CloudTrail keeps, or the event has not arrived yet |

CloudTrail's `LookupEvents` covers [the last 90 days and allows two requests per second per account and Region](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html). The app uses one request per second. A change that is only a few minutes old and has no event yet is marked provisional, and a later sync attributes it again.

## Drafts, plans and apply

The app never writes to a space directly. Every write goes through a plan that shows the difference first.

1. **Draft.** On an asset, "Edit as draft" opens an editor. A draft is one person's saved edit of one asset, checked against the asset rules (name, size limits, required fields). Nothing reaches the space.
2. **Plan.** A plan collects changes to one or more assets. It comes from drafts, from an uploaded package (Plans, then "Import package"), from a restore, or from a revision. Making a plan checks it against the live space: it re-reads each asset and marks an item "Skip: live changed" when the asset changed after the plan was made.
3. **Review.** The plan page lists each change ("Update content", "Set Inactive"), shows the diff, and asks for a change reason. A space can also require approval from a second person.
4. **Apply.** Applying hands the plan to the worker, the only process with the write role. The worker sends each change once, even if the job retries, reads every asset back, and checks that it matches the plan. It then records the result in the history repository with your reason.

Plan states: Checking, Ready, Waiting for approval, Approved, Applying, Applied, Failed, Discarded.

Space settings control three rules: whether a change reason is required (on by default), whether a second person must approve (off), and whether a plan may delete assets (off). Who may draft, approve and apply depends on the role. See [Security](security.md).

## Releases and restore

A **release** is a saved snapshot of every asset that you can restore later. It is an annotated git tag, `<alias>/<name>`, on a commit that adds a manifest file listing each asset at that point with its content hash.

- "Create release" on the Releases page snapshots the live space (after a sync). On an applied plan, "Create release" tags the commit that the apply made, with no sync.
- A release page lists its assets, and what changed in the space since.
- **Restore this release** makes a plan. It does not write anything until the plan is applied. The restore sets assets back to the release's content and metadata, and recreates assets deleted since. A skill added after the release is set to Inactive (not deleted). Managed memory stores are left alone, and a single memory can be restored from its Versions tab.
- "Restore this version" on an asset's Versions tab makes a plan for one asset.

## Release verification

A release records what the space should contain. It does not show that the agent used it. The Verification tab of a release runs two checks:

1. **Live state.** It syncs the space, then compares every asset in the release with the live space. Each asset is a match, changed, missing, or added since. "At apply" reports what the apply job read back when the plan ran.
2. **What the agent read.** It runs the deployed-vs-read analyzer over the investigations created after the release and before the next release. For each skill and memory file it asks whether the agent requested it, and whether the body that came back is the release's. The verdicts are "Received the release's body", "Received an older body", "Received a newer body", "Requested, nothing returned" and "Never requested". An older body means the agent worked from a version the release replaced.

The sample space shows both outcomes on release v1.1: one memory that the agent still read in its v3 wording, and one skill that it read as released. Check 2 reads journals the app already has. Check 1 syncs the space first.

## Journals and analyzers

A **journal** is the record of one investigation: its messages, tool calls, tool results and summaries, one record after another.

- **Export.** Choose task types, statuses and priorities (or a list of IDs) and the app walks the space's tasks and executions through the read role. Records are cached in Postgres. A zip of markdown and raw JSON is available for 14 days.
- **Import.** Upload journal markdown or a zip. The app reads the formats in `policy/journal-import.yaml`, and the zip an export made. Ground-truth files in a zip are listed in the report and not imported as journals.
- **Analyzers.** An analyzer reads a journal and writes a result you can compare across runs:

| Analyzer | What it reports |
|---|---|
| Run metrics | Tool calls by name, error classes, time to the first summary, and how long the run took |
| Memory reads | Which memory index listings the agent saw, which memory paths it asked for, and which were not found |
| Condensed trace | A short trace for a reviewer: the agent's own text in full and tool results as previews |
| Output rules | Checks the agent's final text against `policy/output-rules.yaml`, for example account IDs that are not masked |
| Deployed vs read | What a release's check 2 uses, described above |

## Audits

An **audit** reviews a set of investigations and turns what it finds into changes you can trace. A reviewer writes each review: a model in Amazon Bedrock, a coding agent you run yourself on review files, or a chat in the Agent Space.

1. **New audit.** Choose a profile, the investigations and the reviewer. The profile "Benchmark against ground truth" compares each run with a confirmed root cause and a scorecard that you upload. "Before and after a revision" compares two groups of runs and needs no ground truth. The reviewers on offer, and their options, are policy ([Policy](policy.md#reviewers-and-review-files)). For the Amazon Bedrock reviewer, choose the review model here, or set a space default in Space settings. No model is built in.
2. **Analyze.** The analyzers run on each investigation.
3. **Review.** The reviewer reads the prompt, the analyzer results, the ground truth and the journal's records, and returns a structured result: for the benchmark profile, one **Diagnosis** (primary failure mode, whether the cause was within reach, near miss, scorecard fairness) and a list of **Fix** findings, each with an owner. How the reviewer reads the records depends on the kind:
   - **Amazon Bedrock model.** The app sends the investigation to the model, which uses tools that read only that investigation's records, up to the profile's step limit.
   - **Review files.** The app writes a folder for each investigation (the reviewer's instructions, the brief, every record, the output schema, a manifest and a README). You run the folders with an agent your company has approved, such as the Kiro CLI or Claude Code, which writes a `review.json` beside them. You import the reviews as a zip of the folders, or one `review.json` on an investigation's page, and type who or what wrote them. The app needs no model access for this. The files hold journal text from your Agent Space, so a person with the Viewer role can download them, and each download and import is written to the audit log. A review made from an older version of the journal, or for another audit, is refused with the reason.
   - **DevOps Agent chat.** The app attaches the same review files to a chat in an Agent Space and reads the review from the reply.
4. **Citation check.** Every record the review cites (`R3`, with a quote) is checked against the journal, whichever reviewer wrote it. A quote that is not in that record is flagged. An imported review must also match the output schema before it is stored.
5. **Findings.** Each finding starts as Proposed. On the audit's Findings tab, a list of findings and the selected finding side by side, a person accepts, edits or rejects it. The detail shows the whole finding, its evidence (each cited record with the quoted text and whether the check found it) and who decided. Every change records who made it.
6. **What happens next.** Each finding says where it goes. A diagnosis is recorded and counted in the report. A fix whose owner changes the instruction package (a memory or an instruction, `changesPackage` in the profile's `fixOwners`) is a **package fix**: **Add to revision…** puts it on an open revision's to-address list, or starts a revision with it, and the finding then links to each revision it went to, with that revision's plan and release. Any other fix is an action for the people its owner names, listed in the report. A rejected finding is left out. Accepting a fix does not apply it, and a fix in a revision is only queued: it reaches the agent after someone edits the files in the revision, saves, and applies the revision's plan. Nothing in the Agent Space changes until then. The audit page names the revisions still waiting, and warns when accepted package fixes are in no revision. That warning doesn't stop you saving the audit record: a person may decide a fix won't be made.
7. **Report.** The report has a summary, counts by failure mode and fix owner, the fixes, a list of incidents and the run metrics. The summary is drafted by a model and a person edits it. Each section is marked shareable or internal, and the report downloads as HTML for either audience. An export runs the output rules over its text first and is refused when a rule at error level matches.
8. **Save the audit record.** When every finding has a decision, "Save the audit record" commits `audit.json`, `findings.json` and `report.md` to the history repository under `audits/<alias>/<audit>`, on the repository's branch. It changes nothing in the Agent Space. Before saving, the card shows the repository, branch, folder, which files are new or replace one, and whether the commit will be pushed (it is only when the repository has a remote and pushing is on). After saving, it shows the commit, the files and whether it was pushed, or the push error.

The flow strip at the top of the audit shows the five steps, Reviews, Decide, Fix in a revision, Report and Record, with what is left at each.

The audit states are Draft, Running, Reviewing findings, Record saved and Cancelled. The profiles, prompts and schemas are policy files. See [Policy](policy.md).

Journal text and ground-truth documents are untrusted input to the reviewer, and nothing a reviewer returns is run, fetched or used as a path. A zip of reviews is read with the same checks as any zip the app takes: no absolute paths, no `..`, no symbolic links, and size limits from policy. See [Security](security.md).

## Revisions

A **revision** is a proposed new version of the instruction package, built from audit findings.

1. **Start.** Choose a base, the live space or a release, and a name (for example `v2.4`). The app creates a git branch `revision/<alias>/<name>` in the history repository and commits the package there, in one of the package layouts in `policy/package-layouts.yaml`. The working copy stays on the main branch, so syncing continues.
   A revision can also keep a **to-address list**: accepted package fixes sent to it from an audit ("Add to revision…"), either added to an open revision or used to start a new one from the live space. The list holds findings that no save has linked yet; the save dialog ticks them, and a save that links a finding takes it off the list in the same step. A finding on the list that is reopened or rejected on its audit stays there, marked as no longer accepted, and can't be linked until it is accepted again.
2. **Edit and save.** The editor lists the package files. Each save is one commit. A save links the accepted findings that justify it, or states a reason when none applies. The app rebuilds the generated files (skill zips, memory indexes, shared sections) and runs the package checks. A save whose build fails is still kept, and it blocks the plan and the download until fixed.
3. **Change record.** Every save rewrites a section of `reference/CHANGELOG.md` in the package: each change, its files, and the finding and cited evidence it links to.
4. **Plan.** "Create plan" turns the package at the branch head into a plan against the live space. Only assets the revision changed are planned.
5. **Apply and release.** When the plan is applied with no failed item, the app tags a release with the revision's name. Verification then shows whether the agent used the new text.

"Export package zip" downloads the package from any revision, release or commit. The same zip can be imported again with Plans, then "Import package".

An import with problems to fix can move to a revision: "Fix in a revision" on the import starts a revision from the live space whose first save is the uploaded files. The revision shows every pending change, each error and warning by file, and makes the plan once its checks pass.
