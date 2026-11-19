# Page: Audit report, export and save the audit record

Overrides `MASTER.md` for `/spaces/[alias]/audits/[auditId]/report`, the Report tab of the audit page. The header, tiles and tabs are in `audit-detail.md`. Data comes from `src/server/audit-reports/`. Screens (example data): the report with a stale notice, the export refused by the output rules, the "Save the audit record" dialog, and the card after the record is saved (each in light and dark).

The rules covered are journal audits: cross-incident summary, report and record.

**Saving the record never changes the Agent Space.** It writes three files to the space's history repository and says where. Changes to the space happen only through a revision and its plan (`audit-detail.md`, "What happens next"). The audit's state is `finalized` in code and the database; people read "Record saved", and the action is "Save the audit record", never "Finalize".

## Model

- Sections come from the profile's `report.sections`, in that order. Each has an `audience`: Internal or Shareable.
- Computed sections (`count-table`, `findings-table`, `metrics-table`, `incident-list`) are built in code from **accepted** findings and analyzer output. The model drafts only `narrative` sections, and a person edits them.
- Edits live in `audits.report` (`ReportDraft`): per section the narrative, its source (`model` or `person`) and `hidden`. `builtAt` is when the computed sections were last rebuilt.
- **Stale:** any finding's `reviewedAt` is later than `builtAt`. Rebuilding recomputes the tables and keeps every narrative edit.

## Layout, top to bottom

1. The shared audit header, flow strip and tabs (`audit-detail.md`), Report current.
2. **Stale callout** (warning, `role="status"`) when stale: title "The tables are out of date", body "<N> findings changed after the tables were built on <Time>. Rebuild them to count the latest decisions. Your narrative edits are kept.", action "Rebuild tables" (RefreshCw, `audits.run`). A report never built yet shows instead an info callout "The report isn't built yet" with "Build the report".
3. **Two columns** (main plus the 340 px side column):
   - Main: one line of help, "Built from <N> accepted diagnoses and <N> accepted fixes. The <N> proposed findings count once you accept them. Sections appear in the profile's order.", then one card per section.
   - Side: "Export HTML" and "Save the audit record" cards. The record card stays after the record is saved, for everyone who can read the audit.

## Section card

- **Header:** the section number in mono muted 12 px, `h2` the section title, an audience badge (neutral, no color: "Shareable" with Users, "Internal" with Lock), and "Hidden" (neutral, EyeOff) when hidden. Actions on the right (ghost, small).
- **Meta row** (muted 12.5 px): the kind and source, for example "Narrative · Drafted by the model Oct 30, 2:48 PM, edited by Alex Rivera at 2:55 PM", "Counted from 16 accepted diagnoses · Built Oct 30, 3:02 PM", "From the run metrics analyzer, minutes from the first record".
- **Body by kind:**

  | Kind | Body |
  |---|---|
  | `narrative` | The text through `SafeMarkdown` (72 characters per line). Empty: `EmptyState` "Not drafted yet" with "Draft with the model" |
  | `count-table` | Table: the field's label (from `labels`: failure modes or fix owners, else the value in plain words), count, share. Sorted by count, then label. Right-aligned numbers |
  | `findings-table` | One row per accepted finding, `columns` as labelled columns, plus the incident ID in mono. Show 3 rows, "Show all <N>" |
  | `metrics-table` | One row per incident, `columns` with plain labels (`span_min` "Span", `first_summary_min` "First summary", `finalize_min` "Finalize", `tool_calls_lead` "Lead tool calls", `n_inv_summaries` "Summaries"), then a bold median row. Show 3, "Show all <N> incidents" |
  | `incident-list` | Collapsed by default: "Show <N> incidents". Open, one block per incident: the ID, title, primary failure mode and the one-line reason |

- **Actions:**

  | Action | On | Does |
  |---|---|---|
  | "Edit" (SquarePen) | Narrative | Turns the body into a `Textarea` with "Save" and "Cancel". Saving sets `narrativeSource: "person"` |
  | "Draft with the model" (Bot) | Narrative | Runs a `report-narrative` model call with the section's prompt over accepted findings. If a person edited the text, an `AlertDialog` first: "Replace your edits with a new draft? Your current text is lost." The button shows a spinner while it runs and the result lands as an unsaved edit to review and save |
  | "Hide" (EyeOff) | Any | Sets `hidden`. The card shows the title, badges and "Hidden by <name> <Time>. Left out of every export." with "Show section" (outline, Eye) |

## Export HTML card

- **Audience:** a radio group of cards. "Shareable": "<N> sections. Leaves out <internal section titles>, which is internal." "Internal": "<N> sections, internal ones marked." Help: "Hidden sections are left out of both."
- **Button:** "Check and export HTML" (outline, Download). Help: "One file with inline styles and data, and no external requests. It must pass the output rules first."
- **Last result,** under the button: "Last export refused <Time>: <N> output rule errors." with "See what was found" (opens the dialog with that result), or "Last exported <Time> by <name> for <audience>".

**Export dialog** (`Dialog`):
- Title "Export HTML"; description "<Audience> audience, <N> sections. The export is checked against the output rules before the file is built."
- While checking: `JobProgress` or a spinner, under 300 ms shows nothing.
- **Passed:** the file downloads, the dialog closes, and a toast confirms "Exported <file name>". With warnings only, the file still downloads and the dialog stays open with a success callout "Exported with <N> warnings" above the same table as below, warnings only.
- **Refused** (any error-severity rule matched, scope `report`): destructive callout `role="alert"` "Export refused: <N> output rule errors", body "Fix these in the report or the finding, then check again. Warnings don't block an export." Then a table:

  | Column | Content |
  |---|---|
  | Rule | "Error" (destructive, CircleX) or "Warning" (warning, TriangleAlert), the rule's description in plain words, the rule ID in mono 12 px |
  | Where | A link to the place ("Summary, paragraph 2", "Fixes, row 12") that closes the dialog and scrolls to it, with the incident ID in mono 12 px when the text came from a finding |
  | Found | The excerpt from `checkOutputText`, already redacted (account IDs masked to the last 4 digits), mono 12 px |

  Footer note: "Account IDs are masked here too. Each excerpt shows up to <excerptChars> characters on each side of the match." Buttons "Close" and "Check again" (ShieldCheck).

## Save the audit record card

An anchor (`#report-record`) the flow strip's Record cell links to.

- **Before saving.** One sentence: "Saves what this audit found, as files in the space's history repository. Nothing in the Agent Space changes." Then a definition list of the facts, read from the repository now:

  | Label | Content |
  |---|---|
  | Repository | The repository's name in bold, "branch <default branch>" in mono |
  | Folder | `audits/<space alias>/<audit ID>/` in mono |
  | Files | Each file in mono with "(new)" or "(replaces the file that is there)", and under it what it holds: `audit.json` "profile, <N> journal SHA-256s, analyzer and model versions"; `findings.json` "<N> accepted findings with their citations"; `report.md` "the report, <N> sections" |
  | Push | A chip: "Pushes to <remote>" (success), "Local only: this repository has no remote" or "Local only: pushing is off for this repository" (warning) |

  Help: "Findings and the report can't change after this. The journals stay in this app's database." The button is "Save the audit record" (primary, GitCommitHorizontal, `audits.run`). Disabled reasons:
  - "<N> findings still need a decision." with a link to them
  - "Wait for the reviews to finish." (running)
  - "The history repository isn't set up for this space." with a link to Space settings for Admins
  - "Resolve the items above first." in the dialog, while it lists a refusal
- **Dialog** (`AlertDialog`): title "Save the audit record?", description "Saves what <name> found. Nothing in the Agent Space changes. Findings and the report can't change after this." The same facts as above, then "Commit by <name>". Callouts: the other reasons the server refuses (an investigation not reviewed, a shareable summary nobody approved, each with a link), "The record stays on this machine" (warning, with "Repository settings" for Admins) when the push is local only, and "The report was built before the latest decisions" when it is stale. Buttons "Cancel" and "Save the record". Saving runs in the worker (git writes only happen there) and shows `JobProgress` in the dialog; when it succeeds a toast says "Saved the record of <name>".
- **After saving.** The card's chip says "Saved". It says "Saved <Time> by <name>. Nothing in the Agent Space changed." Then the commit (the short hash in mono with a Copy icon; pressing it copies the full hash), the same list with the repository, the branch and the folder it was saved to, each file with "(new)" or "(replaces the file that is there)", and the push result: "Pushed to <remote>" (success), "Saved here, but the push to <remote> failed: <error> The next push carries it." (destructive), "Local only: this repository has no remote" or "Not pushed: pushing was off for this repository" (warning). A record saved before the result was kept says "The push result wasn't kept for this save." There is no link to History: History lists changes to assets, and an audit record is not one.
- Where the facts come from: before saving, the repository's settings and the files under the folder at its HEAD (`loadRecordInfo`). After saving, the `audit.finalize` audit event the worker writes (commit, folder, branch, remote, `pushed`, `pushError`, and each file's status from the commit's diff), so no column was added.

## States

| State | What shows |
|---|---|
| Loading | Section card skeletons and the two side cards |
| Not built | Info callout "The report isn't built yet" and "Build the report" (`audits.run`); no section cards |
| No accepted findings | Computed sections show `EmptyState` "Nothing accepted yet" with "Open findings"; narrative "Draft with the model" is disabled with "Accept some findings first." |
| Model draft failed | Destructive callout in the section card with the error as a plain sentence and "Try again" |
| Record saved | Read only: no Edit, Draft, Hide, Rebuild or Save; the export card stays (exports of a saved report read `report.md` from the commit), and the record card shows what was saved |
| Read only (Viewer) | Sections and the export card; no section actions, no rebuild, no record card until the record is saved, then the card without a button |

## Permissions

| Action | Permission |
|---|---|
| See the report | `audits.read` |
| Export HTML | `audits.read` |
| Edit, draft with the model, hide, rebuild | `audits.run` |
| Save the audit record | `audits.run` |

Export is a read: Viewers already export journals. See open items.

## Audit log

`report.build`, `report.section.edit` (section ID), `report.section.draft` (section ID, model ID, tokens), `report.section.hide` and `report.section.show`, `report.export` (audience, result, rule IDs that matched; never the excerpts), `audit.finalize` (the action name stays; its details hold the commit, folder, branch, remote, push result, files and counts).

## Data

- `getReportView(auditId)`: sections in order with audience, kind, hidden, narrative and its source and editor, computed rows, `builtAt`, the stale count, the accepted and proposed counts, and the last export result.
- Service functions (audit-reports module): `rebuildReport`, `saveNarrative`, `draftNarrative` (enqueues the model call), `setSectionHidden`, `exportReport(audience)` returning a file or the violations with section and position, `finalizeAudit` (the worker job behind "Save the audit record"), and `loadRecordInfo` for the facts the card shows.

## Components

`StatusBadge`, `Callout`, `DisabledReason`, `EmptyState`, `Time`, `SafeMarkdown`, `JobProgress`, `SectionCard`, shadcn `RadioGroup`, `Dialog`, `AlertDialog`, `Textarea`, `Table`, and `SaveRecordCard` and `CopyCommit` (local to the audit pages).

## Open items

- **Saving with proposed findings.** The design allowed it and warned that they are left out. Decided: saving is blocked until every finding has a decision (MASTER "Page index"), and the dialog lists what is undecided instead of a warning callout.
- **The commit message** still reads "Finalize audit <name> of <space>" (`report.commitMessage` of the audit profile, whose default is in the audits policy section). Change it there to match the new wording.
- **Who can export.** Viewers (as for journal exports) or Editors. Viewers is the current rule.
- **Where an output-rule match is.** `checkOutputText` returns a character offset in the checked text. The export needs a section ID and a row or paragraph, so the audit-reports module checks section by section and maps offsets to rows.
