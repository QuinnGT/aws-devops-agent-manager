# Page: New audit

Overrides `MASTER.md` for `/spaces/[alias]/audits/new` and for a draft audit (`/spaces/[alias]/audits/[auditId]` while `state` is `draft`, which renders this form). Screens: the benchmark profile with incident IDs and the ground truth match report; the before and after profile with a date range and cohorts (each in light and dark).

Rules covered here: journal audits (inputs, analyzers) and model review safety (inference runs in the space's own account).

## Model

- The first "Save draft" or upload creates an `audits` row in `draft` with the profile snapshot. Until then nothing is stored.
- Inputs are the investigations (`audit_items`, one per journal task) and the ground truth (`evidence_docs`, per incident and kind, kept per space so later audits reuse them).
- "Start audit" moves the audit to `running` and enqueues the `audits.run` job: analyzers first, then one review per item, `review.concurrency` at a time.

## Layout, top to bottom

1. **Top bar:** breadcrumb "Audits › New audit" (a draft shows its name instead); `SyncStatus`.
2. **`PageHeader`:** title "New audit" (or the draft's name), description "Choose the investigations and add their ground truth. Nothing runs until you start the audit." Actions: "Discard" (ghost; for a saved draft it opens an `AlertDialog` "Discard <name>? Its uploads stay in this space for later audits.") and "Save draft" (outline).
3. **Two columns** (`cols ws`: main plus a 360 px side column, stacked below 1280 px): the input cards on the left; "Readiness" and "Start the audit" on the right.

## Name and profile card

- **Name:** `Input`, required. Field error: "Enter a name."
- **Profile:** a radio group of cards, one per profile in `policy/audits.yaml`, in file order, `defaultProfile` selected. Each card shows the `label` in bold, the `description`, and a "Needs" line built from the profile: "Needs per incident: <input labels>" for required `inputs`, "Needs: two cohorts" when `cohorts` is not empty. A Radix `RadioGroup` with a 24 px radio.
- Changing the profile of a draft with uploads keeps the uploads (they belong to the space) and rebuilds the match report.

## Investigations card

A `ToggleGroup` in the card header picks the mode. The chosen investigations are the same `audit_items` whichever mode added them.

| Mode | Controls | Result rows |
|---|---|---|
| Incident IDs | `Textarea` "Incident IDs". Help: "Numbers or full IDs, separated by spaces, commas or new lines. The space's incident ID rule turns 20101 into INCIDENT-20101." (the rule is `incidentIdTemplate`) | Success row "<N> investigations found in the cached journals". One destructive row per ID with no cached journal: "<ID> has no cached journal, so it is left out. Export its journal first, or remove it from the list." with "Export journals" (`journals.export`) |
| Date range | From and To date pickers (shadcn `Calendar` in a `Popover`), Status select (the journals list's status values) | "<N> investigations match, all with cached journals." Times are in the viewer's time zone, said once |
| Pick from journals | The journals table in a `Dialog` with `Checkbox` selection and the journals filters | "<N> investigations selected" |

- An investigation with several executions uses the one the analyzers use (the latest finished execution). Say so in a muted line when any have more than one: "<N> have more than one execution; the latest finished one is used."
- Over `maxItemsPerAudit` (500): a field error "An audit holds at most 500 investigations. Narrow the range or split it."

## Ground truth card (profiles with `inputs`)

- **Header:** `h2` "Ground truth" and "Per incident: <required input labels>".
- **Upload:** a compact drop zone: "Drop files or a zip here", "Up to <maxEvidenceUploadBytes> MB. File names are matched with the profile's patterns, for example <example>.", and "Choose files". Zip entries follow the AGENTS.md zip rules (no absolute paths, no `..`, no symlinks); a rejected zip is a destructive callout naming the entry.
- **Counts row:** files uploaded, matched, not matched, reused from earlier uploads (with the date), and incidents still missing a document. Warning tone on the last two when above zero.
- **Matched by incident** table, one row per investigation:

  | Column | Content |
  |---|---|
  | Incident | ID in mono |
  | One column per input, in profile order | "Matched" (success, Check) with the file name in mono 12 px; "Reused" with "Uploaded <Time> by <name>"; "Replaces an older upload" when this upload supersedes one; or a destructive "Missing" badge for a required input |
  | Read from the <input label> | The input's `fields` values with their labels ("Score 2/5 · Comparison 5/5", "Verdict: Miss"). A field whose pattern found nothing: "<label> not found" in warning text |

  Show 5 rows with "Show <N> more incidents", and missing ones first.
- **Not matched:** one warning row per file, with the reason and a code in mono:

  | Code | Text |
  |---|---|
  | `evidence.name-unmatched` | "<file>: the name matches neither input. Rename it, for example to <pattern example>, and upload it again." |
  | `evidence.incident-not-in-audit` | "<file>: incident <n> isn't in this audit." |
  | `evidence.too-large` | "<file> is larger than <limit>." |
  | `evidence.not-text` | "<file> isn't a text or markdown file." |

- **Still missing:** one destructive row per incident: "<ID> has no <input label>. The review needs it, so this investigation is skipped unless you upload one." An incident with a missing required document becomes a `skipped` item with that `stateReason`.
- Document bodies are untrusted. This card shows names and extracted field values only, never the body.

## Cohorts card (profiles with `cohorts`)

- Help: "Each investigation goes to the cohort for when it started. You can move one by hand below."
- **Split at:** a select of releases ("Release v1.1 applied, Nov 2, 4:15 PM", newest first) or "A time you enter".
- **Counts row:** "<N> <cohort label> (release <name>), <date range>" per cohort.
- **Table:** Investigation, Started (`Time`), Cohort (a `Select` per row). A row moved by hand shows "Moved by hand" in muted 12 px. Show 3, then "Show all <N>".
- Readiness needs at least one investigation in each cohort.

## Readiness card

One `ValidationList`-style row per check, success or warning or destructive:

| Check | Passes when | Otherwise |
|---|---|---|
| Name and profile | Both set | "Enter a name" |
| Investigations | At least one with a cached journal | "Choose at least one investigation" (destructive) |
| IDs without journals | None | "<N> IDs have no cached journal and are left out" (warning) |
| Ground truth | Every investigation has every required input | "<N> investigations are missing a <label> and are skipped" (warning) |
| Cohorts | Each cohort has an investigation | "<cohort> has no investigations" (destructive) |
| Analyzers | Always | Lists the profile's analyzers by readable name |

## Start the audit card

- **Facts** (`kv` list):
  - Reviews: "<N>, one per investigation, <concurrency> at a time". Skipped items are not counted.
  - Model: the profile's `review.modelId` in mono.
  - Step limit: "<stepLimit> per review".
  - Runs in: "This space's AWS account, <masked account>, through its read role. Inference runs in <inferenceRegion> and is billed to that account." When the space's inference setting points at another account, say that account instead.
- **Button:** "Start audit with <N> reviews" (primary, Play). It calls the audits start service, records the audit event, and goes to the audit page, which shows progress.
- **Help:** "Analyzers run first, then the reviews. Each review reads only its own investigation's records, and nothing counts until you accept it."
- **Disabled reasons** (`DisabledReason`):
  - "Choose at least one investigation."
  - "Every investigation is missing ground truth. Upload it first."
  - "<cohort> has no investigations."
  - "The app can't reach Bedrock with this space's read role." then `ConnectionNextStep` when the space's connection is failed.

## States

| State | What shows |
|---|---|
| Loading | `PageSkeleton` with two cards on the left and two on the right |
| Upload in progress | The drop zone shows `Progress` and the file count; the rest of the form stays usable |
| Upload failed | Destructive callout in the card: what failed and "Try again" |
| Start failed | Destructive callout above the columns with the error and a next step; the form keeps its values |
| Read only | A Viewer who opens the route sees `EmptyState` "Starting an audit is for Editors" with a `RoleNote` linking to "Who can do what". A Viewer opening a draft audit sees the audit page instead |

## Permissions

All writes need `audits.run` (Editors and up): create, save, discard, upload ground truth, choose investigations, start. "Export journals" needs `journals.export`.

## Audit log

`audit.create`, `audit.inputs.update` (counts only), `evidence.upload` (file names, SHA-256s, matched and unmatched counts), `audit.start` (item count, model ID, region), `audit.discard`.

## Data

- Loader: profiles (label, description, inputs, cohorts, analyzers, review model, concurrency, step limit), the draft's items and evidence match report, the space's inference account and region, releases for "Split at".
- Service functions (audits module): `createAuditDraft`, `setAuditItems` (IDs, range or task IDs), `uploadEvidence` (returns the match report), `setCohorts`, `startAudit`.

## Open items

- **Cohort assignment.** The schema has `audit_items.cohort` but no rule for how investigations get there. This page splits at a release's apply time with manual moves. The audits module needs to confirm the rule.
- **Match report shape.** `evidence_docs` stores matched documents only. The not-matched files and their reasons need a return type from `uploadEvidence` (not stored), or an upload log if they should survive a reload.
