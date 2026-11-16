# Policy

Policy is the set of files that hold every rule, limit, layout, label and prompt the app uses. Code reads policy and does not hard-code these values. To change how the app treats your package, your audits or your attribution, you change policy files and restart. You do not change code.

## The files

All files are in [`policy/`](../policy/). Each YAML file is one section, checked against a schema when the app starts. A file starts with comments that explain its keys. Read them before you change a value.

| File | What it controls |
|---|---|
| `roles.yaml` | Roles, their rank, what each may do, and which role inherits from which |
| `agent-types.yaml` | The agent types and their labels ("Incident triage instructions") |
| `asset-types.yaml` | Per asset type: metadata schema, name rules, which files, what the app can edit, managed stores |
| `limits.yaml` | Size and count limits from the AWS DevOps Agent guides, and caps for reading uploads |
| `api.yaml` | AWS call retries, concurrency, role session length, how long a queued job waits before the page warns |
| `history-layout.yaml` | Where each asset, release manifest, audit and revision lives in the history repository |
| `sync.yaml` | Sync interval and schedule, memory store commit policies, commit messages, reconcile safety |
| `attribution.yaml` | How a change is attributed, role name patterns, and the labels shown in the app |
| `plans.yaml` | How apply writes each asset type, apply order, read-back, approval, limits |
| `releases.yaml` | Release name rules, tag and commit messages, what a restore does with added assets |
| `verify.yaml` | The two verification checks: which investigations belong to a release, what to skip |
| `journals.yaml`, `journal-import.yaml` | Journal export, import formats, retention, markdown templates (`journal-templates/`) |
| `analyzers.yaml` | Patterns the memory reads analyzer uses to find listings and paths |
| `output-rules.yaml` | Rules that check agent output and reports, for example masking account IDs |
| `package-io.yaml`, `package-layouts.yaml` | Package import and export, and the layouts that map a package to assets |
| `audits.yaml` | Audit profiles, with `audit-profiles/` and `prompts/` |
| `revisions.yaml` | Revision names, saves, the change record, plan and release templates |

## Layers

The app builds its policy from layers. A later layer wins:

1. **The app's policy folder**, `DAM_POLICY_DIR` (default `./policy`).
2. **Overlay folders**, listed in `DAM_POLICY_OVERLAY_DIRS`, separated by `:`, in order. In the container stack, run `./scripts/stack.sh up --policy <folder>`: it mounts the folder read-only at `/app/policy-overlay`, sets `DAM_POLICY_OVERLAY_DIRS` to that path in the web and worker containers, and saves the choice in `.env` as `DAM_POLICY_OVERLAY_HOST_DIR`. `--policy none` removes it. See [Getting started](getting-started.md#change-the-policy-of-the-containers).
3. **The history repository's own `policy/` folder**, at the working copy `DAM_DATA_DIR/history/<name>/policy/`. This layer applies to that repository's space only.

Merging works per file. Objects merge key by key. Arrays and plain values replace what was below, so an overlay that changes an array must list every item. A folder or a file that is missing is skipped. Text files, such as prompts and templates, come from the last layer that has the path.

Two limits to know:

- Permissions come from the app's policy folder and overlays only. A `roles.yaml` in a history repository changes nothing, so a repository cannot grant itself access.
- The app reads the working copy and never pulls from the remote into it. A change to `policy/` that you push from another clone does not reach the app unless you also change the working copy.

The app reads the app layers once, at start. After you change a file in `DAM_POLICY_DIR` or an overlay folder, restart the web server and the worker. A repository's `policy/` folder is read from its working copy each time it is needed, so a change there applies without a restart.

## Write an overlay

An overlay is a folder with the same file names as `policy/`, holding only the keys you change. Use it to describe your own package. The sample in [`sample-data/policy/package-layouts.yaml`](../sample-data/policy/package-layouts.yaml) is a worked example: it adds three layouts for the fictional AnyCompany Tickets.

1. Create a folder, for example `my-policy/`, and a file `my-policy/package-layouts.yaml`.
2. Add a layout that extends one of the base layouts and lists only what differs:

   ```yaml
   layouts:
     my-package:
       extends: instruction-folders
       label: My instruction package
       description: Instruction folders with my tool-call check and safety response.
       checks:
         textPatterns:
           - code: package.dotted-invocation
             dirs: [instructions, skills, memory]
             glob: "**/*.md"
             pattern: "\\b(?:my_logs|my_metrics)\\.[a-z_]+"
             message: Unsupported dotted invocation example
         requiredText:
           - code: package.safety-message
             file: instructions/global.md
             texts: ["[READ-ONLY]: This agent gives advice only."]
             message: Existing safety response changed or missing
   ```

3. To make it the default for imports and exports, add `defaultLayout: my-package` at the top of the file.
4. Set `DAM_POLICY_OVERLAY_DIRS` to the folder's absolute path in `.env`, then restart the web server and the worker. A path that does not exist is skipped with a warning in the log, so check the log if nothing changes. In the container stack, do not set the variable: run `./scripts/stack.sh up --policy <folder>` instead (see [Layers](#layers)).
5. Open Plans, then "Import package", and upload a package. The Layout card shows which layout matched the most files, and "Read again" lets you pick another.

What a layout can set, and what each key means, is written in the comments of [`policy/package-layouts.yaml`](../policy/package-layouts.yaml):

| Key | Meaning |
|---|---|
| `extends` | The parent layout, merged first |
| `instructions`, `skills`, `memory` | Folders, main files, file names per agent type, and frontmatter keys |
| `nonAssets` | Package files that are kept in a revision and never uploaded |
| `sharedSections` | Text copied between markers into several files by the build. The `source`, the `targets` and the `begin` and `end` markers |
| `build` | Generated files: skill zips, memory indexes, a validation result, the package zip |
| `checks` | Limits, `textPatterns` (text that must not appear), `requiredText`, `forbiddenText` and `requiredFiles` |
| `assetFolders` | For layouts that store one folder per asset with an `_asset.json` descriptor |

The check `code` values appear in the app as "Details: package.safety-message" under the message, so choose codes a reader can search for.

## Audit profiles and prompts

[`policy/audits.yaml`](../policy/audits.yaml) defines the profiles an audit can use: `benchmark` ("Benchmark against ground truth") and `before-after` ("Before and after a revision"). A profile holds:

- **Inputs.** The files a person uploads as ground truth, with a file name pattern and the fields the app reads from them (the benchmark's score, verdict and comparison score).
- **Analyzers.** Which analyzers run before the review.
- **Review.** The runner settings (step limit, maximum output tokens, concurrency, time limit), and the paths of the prompt files, all relative to a policy folder: `systemPrompt`, `promptTemplate`, `finalStepPrompt` and `outputSchema`.
- **Failure modes and fix owners.** The lists the model chooses from, with the labels the app shows.
- **Findings.** For each kind of finding: which part of the review output it comes from (`from`), its title template, its fields, which fields a person may edit, and whether a revision may link to it (`linkable`).
- **Report.** The sections, whether each is shareable or internal, and the prompts for the sections a model drafts.

The prompt files are markdown with `{{placeholders}}` that the app fills in, for example `{{incident_id}}`, `{{condensed_trace}}`, `{{failure_modes}}` and `{{step_limit}}`. The output schema is a JSON Schema (draft 2020-12). The review must match it, and the app rejects an answer that does not.

To add a profile:

1. Copy a profile block in an overlay's `audits.yaml` and give it a new key. Arrays replace, so copy the whole block.
2. Copy `audit-profiles/benchmark/` to `audit-profiles/<yours>/` in the overlay, and change the brief, schema and report prompts. Point the profile at them.
3. Restart. The profile appears on "New audit".

An audit stores a copy of its profile when it is created, so a policy change never alters an audit that has already started.

No model ID is set in policy. The review model is chosen on the audit, or as the space default in Space settings. A profile may set `review.modelId` as a last fallback. See [AWS setup](aws-setup.md) for the Amazon Bedrock permissions that a model needs.

## When policy has an error

A policy that fails its schema is rejected as a whole. The app never runs with part of a file applied.

| Where | What you see |
|---|---|
| Web server | It starts, but every request answers `500 Internal Server Error`. The server log has `PolicyError: Policy rejected: N problem(s)` followed by an `issues` list. Each issue names the section, the file and the key, for example `intervalMinutes: Invalid input: expected number, received string` |
| Worker | It prints `[worker] fatal PolicyError` with the same `issues` list and exits. In the container stack the worker container stops, and `./scripts/stack.sh logs` shows the message |
| A repository's `policy/` | The pages and jobs that read that repository's policy fail with the same error |

Fix the key the log names, then restart. YAML that does not parse fails with the parser's own message and a line number.
