# Page: Incident review, two options

Overrides `MASTER.md` for `/spaces/[alias]/audits/[auditId]/items/[itemId]`, the main working screen of an audit: a person checks one investigation's findings against the ground truth and the journal, then accepts, edits or rejects each one. The rules cover the citation check and findings (journal audits) and model review safety.

Two layouts were designed, and both are specified here. Screens (example data from INCIDENT-20101, shortened):

| Option | Layout |
|---|---|
| 1. Split view | Evidence on the left, every finding card on the right (light, dark and 768 px) |
| 2. One finding at a time | A queue bar and one large finding card, with keyboard shortcuts (light, dark and 768 px) |

Option 2's design shows a later moment than option 1: the diagnosis and the first two fixes have been decided, and the third fix is current.

**Decision: option 1, the split view, with option 2's shortcuts added to it** (also recorded in MASTER "Page index"). Option 2 is not built. A diagnosis finding has six or more fields that are judged against each other and against the ground truth (near miss, reachability, failure modes), so the reviewer needs the confirmed root cause, the agent's answer and the cited record on screen together. Option 1 keeps all three in view and shows every finding of the incident, so the reviewer sees how the fixes follow from the diagnosis. Option 2 is faster for a run of simple fix findings but hides the other findings and shrinks the evidence to summaries. Adding J and K (next and previous finding card) and A, E, R (accept, edit, reject the focused card) to option 1 gets most of option 2's speed.

## What both options share

**Top bar:** breadcrumb "Audits › <audit name> › <incident ID>"; `SyncStatus`.

**Header:**
- `h1` the incident ID, then neutral badges "Score <value>" and "Comparison agent <value>" from the scorecard fields (each only when present).
- The investigation title as the description.
- Meta: "Reviewed <Time> in <steps> steps" · "<N> journal records" · "Primary failure mode proposed: <label>" (option 1).
- Option 1: "<position> of <items>" and "Previous" and "Next incident" (outline) on the right, in the Investigations table order, skipping failed and skipped items.

**Citation check callout** (warning, `role="status"`), when `citationCheck.failed > 0`: title "<f> of <N> citations failed the check", body one sentence per problem: "R<n> doesn't exist: this journal has <N> records." (`missing-record`) or "The text quoted from R<n> isn't in that record." (`quote-not-found`), then "The findings that rely on them are flagged below." A failed citation is never hidden.

**Evidence:**
- **Confirmed root cause:** the ground-truth document of the first required input, rendered through `SafeMarkdown`, collapsed to its first 12 lines with "Show the full document". A warning badge "Partly uncertain" when the review's `ground_truth_uncertain` is true. Footer in muted 12 px: the file name and "uploaded <Time> by <name>". Several inputs (scorecard) get a `ToggleGroup` in the card header: "Confirmed root cause", "Benchmark scorecard".
- **Agent's final answer:** the review's `agent_final_answer`, with the scored summary's record as a citation chip.
- **Journal record** (option 1; in option 2 each evidence row shows its excerpt inline): the record a citation opened. Header "Journal record R<n>", the record type and `Time`, and "Open in journal" (opens the journal page at that record in the same tab). Body: the record's text as plain text in mono, with each quoted span marked (`<mark>`, info tint, underline). Footer: "Opened from the <field> citation. Quoted text is highlighted. Journal text is shown as plain text." and "R<n-1>" and "R<n+1>" buttons.

**Citation chip:** a 24 px mono button "R<n>". Pressing it opens that record in the journal record card and sets `aria-pressed`. A failed citation uses the warning tint with TriangleAlert and an adjacent text reason linked by `aria-describedby` ("Not in this journal (41 records)", "Quoted text not found in R12"); its record card says why it can't show the record, or shows the record without highlights.

**Finding card** (one per finding of the current review, diagnosis first, then by kind and `ordinal`):
- Header badges: the kind label ("Diagnosis", "Fix 2 of 3"), the state (`StatusBadge`: "Proposed" info Clock, "Accepted" success Check, "Rejected" neutral X), "Edited" when `edited`, and "<N> citation(s) failed" (warning) when any of its citations failed. A flagged card has a warning-tint border.
- Title: the filled title template, 14 px semibold (16 px in option 2).
- Fields: a definition list of the extractor's `fields`, labelled in plain words (table below), values from `current`. Citations for a field sit under it as chips. Model text is untrusted: render values as plain text or through `SafeMarkdown`, never as HTML.
- Footer for a proposed finding: "Accept" (primary), "Edit" (outline), "Reject" (ghost). For a decided finding: who and when ("Alex Rivera, 10:02 AM") and "Change decision" (ghost, Undo2). A flagged card adds "Accepting keeps the flag in the record." in muted 12 px.
- **Edit:** turns the extractor's `editable` fields into controls in place: failure mode `Select` (labels from `failureModes`), failure modes as a checkbox group, reachability as a `RadioGroup`, owner `Select` (labels from `fixOwners`), text fields as `Textarea`. Buttons "Save and accept" (primary) and "Cancel". Fields not in `editable` stay read only. Saving keeps `proposed` as it was and writes `current`, `edited: true`.
- **Reject:** a `Popover` with an optional "Why, for the record" note and "Reject".

**Field labels** for the benchmark profile (the page reads labels from the profile; these are the defaults to add to it):

| Field | Label | Value |
|---|---|---|
| `primary_failure_mode` | Primary failure mode | `failureModes` label |
| `failure_modes` | Also seen | Chips, the primary left out |
| `reachability`, `reachability_reason` | Within reach | "Reachable", "Partly reachable", "Out of reach", then the reason |
| `near_miss` | Near miss | Text, or "None" |
| `scorecard_fair`, `scorecard_notes` | Scorecard fair | "Yes", "Mostly", "No", "Not applicable", then the notes |
| `owner` | Owner | `fixOwners` label |
| `fix` | Fix | Text |
| `evidence` | Evidence | Citation chips |

**Bulk:** "Accept the <N> without problems" above the cards (option 1) accepts proposed findings of this incident whose citations all passed, the same rule as the Findings tab.

## Option 1: split view

- Two columns, 5 : 6 (evidence : findings), aligned to the top. Each column scrolls with the page.
- Left: Confirmed root cause, Agent's final answer, Journal record (opens the first citation of the first proposed finding by default).
- Right: `h2` "Findings" with "<N>: <a> accepted, <p> proposed", the bulk button, then the finding cards.
- Below 1280 px the columns stack, evidence first (DOM order and reading order are the same). Below 1024 px the journal record opens in a `Sheet` from the right instead of the card, so a citation doesn't scroll the page away from the finding.

## Option 2: one finding at a time

- **Queue bar** (a card under the header): "Finding <i> of <n> in this incident · <j> of <m> proposed findings in the audit", a meter of the audit's decided share, and a step group of this incident's findings (decided ones in the success tint with Check, the current one filled, `aria-current="step"`).
- **Two columns** (main plus the 340 px side column): the current finding card large on the left; Confirmed root cause (summary with "Show the full document"), Agent's final answer and Keyboard on the right.
- **Evidence** inside the card: one row per citation with its check result, the record type and `Time`, and the cited excerpt in mono with the quote marked. A failed citation says what is wrong and what to do: "This journal has 41 records, so R43 can't be checked. Accept only if R19 alone supports the fix, or edit the evidence."
- **Footer:** "Accept A", "Edit E", "Reject R", then "Previous K" and "Skip J". After a decision the next proposed finding opens, crossing to the next incident when this one is done (the URL changes, so Back works).
- Below 1280 px the side column moves under the card.

## Keyboard shortcuts (designed for option 2, adopted by option 1)

| Key | Action |
|---|---|
| A | Accept the current (focused) finding |
| E | Edit its fields |
| R | Reject, with an optional note |
| J | Next proposed finding |
| K | Previous finding |
| O | Open the cited record |

- Single-key shortcuts work only while focus is in the review area and not in a text field, and a switch "Single keys on" in the Keyboard card turns them off (WCAG 2.1.4). The setting is stored per user in local storage.
- Each button shows its key in a `kbd`. The keys also appear in the Keyboard card, which is the only place that explains them.

## States

| State | What shows |
|---|---|
| Loading | `loading.tsx`: header skeleton, two cards on the left and three finding-card skeletons on the right |
| Review running | `EmptyState` "This investigation is being reviewed" with `LiveJobProgress`; the evidence column still shows |
| Review failed | Destructive callout "The review failed: <reason>" with "Rerun review" (`audits.run`); no finding cards. The evidence column still shows |
| Skipped | Neutral callout with `stateReason` ("Missing a Benchmark scorecard") and "Upload it on the audit's inputs" for a draft audit |
| Schema failed | The review is `failed` with `schemaErrors`: a destructive callout listing the first three errors in mono 12 px |
| Every finding decided | Success callout "Every finding in <ID> has a decision" with "Next incident" |
| Finalized audit | Read only: no Accept, Edit, Reject or Change decision |
| Read only (Viewer) | The same evidence and cards; no footers, no bulk button, no shortcuts |
| Older reviews | When the item has more than one review, a "Reviews" `Select` in the header ("Current: Oct 28, 9:41 AM", "Oct 28, 9:12 AM, failed") shows an older one read only |

## Permissions

| Action | Permission |
|---|---|
| See the page | `audits.read` |
| Accept, edit, reject, change decision, bulk accept | `findings.review` |
| Rerun the review | `audits.run` |

## Audit log

`finding.accept`, `finding.edit` (the edited field names, not their values), `finding.reject` (with the note), `finding.reopen` (change decision), `finding.bulk-accept`.

## Data

- `getAuditItem(auditId, itemId)`: incident ID, title, cohort, state and reason, the current review (output fields used here, `citationCheck`, steps, finished time, model ID), older reviews (ID, time, state), the ground-truth docs (kind, label, file name, uploader, time, body), the item's position and the previous and next item IDs.
- `getRecordText(spaceId, taskId, n)`: one normalized record by its 1-based number, as plain text, for the journal record card and the evidence excerpts. It reads only this item's journal.
- The finding cards read `findings` rows for the current review (`proposed`, `current`, `citations`, `state`, `edited`, reviewer).

## Components

`StatusBadge`, `Callout`, `EmptyState`, `LiveJobProgress`, `Time`, `SafeMarkdown`, `Checkbox`, shadcn `Card`, `Select`, `RadioGroup`, `Textarea`, `Popover`, `Sheet`, `ToggleGroup`, `Switch`. New, local to the page: `CitationChip`, `FindingCard`, `RecordExcerpt`.

## Open items

- **Opening a record in the journal page.** Citations use the record number (`NormRecord.n`); the journal page pages by record and anchors by `recordId`. "Open in journal" needs the journal page to accept `?record=<n>` and jump to its page and anchor, or a loader that maps n to the page and `recordId`.
- **Which document is "Confirmed root cause".** The page shows the first required input. A profile field (`groundTruthInput`) would make it explicit.
- **Field labels** are not in the profile. Add an optional `fieldLabels` map to each finding extractor (audits module).
