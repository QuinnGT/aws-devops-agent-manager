# Page: Audit report, export and finalize

Overrides `MASTER.md` for `/spaces/[alias]/audits/[auditId]/report`, the Report tab of the audit page. The header, tiles and tabs are in `audit-detail.md`. Data comes from `src/server/audit-reports/`. Screens (example data): the report with a stale notice, the export refused by the output rules, and the finalize dialog (each in light and dark).

The rules covered are journal audits: cross-incident summary, report and record.

## Model

- Sections come from the profile's `report.sections`, in that order. Each has an `audience`: Internal or Shareable.
- Computed sections (`count-table`, `findings-table`, `metrics-table`, `incident-list`) are built in code from **accepted** findings and analyzer output. The model drafts only `narrative` sections, and a person edits them.
- Edits live in `audits.report` (`ReportDraft`): per section the narrative, its source (`model` or `person`) and `hidden`. `builtAt` is when the computed sections were last rebuilt.
- **Stale:** any finding's `reviewedAt` is later than `builtAt`. Rebuilding recomputes the tables and keeps every narrative edit.

## Layout, top to bottom

1. The shared audit header and tabs (`audit-detail.md`), Report current.
2. **Stale callout** (warning, `role="status"`) when stale: title "The tables are out of date", body "<N> findings changed after the tables were built on <Time>. Rebuild them to count the latest decisions. Your narrative edits are kept.", action "Rebuild tables" (RefreshCw, `audits.run`). A report never built yet shows instead an info callout "The report isn't built yet" with "Build the report".
3. **Two columns** (main plus the 340 px side column):
   - Main: one line of help, "Built from <N> accepted diagnoses and <N> accepted fixes. The <N> proposed findings count once you accept them. Sections appear in the profile's order.", then one card per section.
   - Side: "Export HTML" and "Finalize audit" cards.

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

## Finalize audit card

- Body: "Commits the audit record to <repository>, in <folder>:" then a definition list: `audit.json` "Profile, <N> journal SHA-256s, analyzer and model versions"; `findings.json` "<N> accepted findings with their citations"; `report.md` "The report as shown here". Help: "Findings and the report can't change after this. The journals stay in this app's database."
- Button "Finalize audit" (primary, GitCommitHorizontal, `audits.run`). Disabled reasons:
  - "Rebuild the tables first: <N> findings changed after they were built."
  - "Wait for the reviews to finish." (running)
  - "The history repository isn't set up for this space." with a link to Space settings for Admins
- **Confirm** (`AlertDialog`): title "Finalize <name>?", description "Commits the audit record to <repository>. Findings and the report can't change after this." Facts: Folder (mono), each file with what it holds (`audit.json`: profile and policy digest, journal SHA-256s, analyzer versions, model ID and prompt digest; `findings.json`: accepted findings with record citations and check results; `report.md`: every shown section, each marked Internal or Shareable), "Commit by <name>". When findings are still proposed, a warning callout "<N> proposed findings are left out": "They stay proposed here and can't be accepted after finalizing. Revisions can link only to the <N> accepted ones." Buttons "Cancel" and "Finalize and commit".
- Finalizing runs in the worker (git writes only happen there) and shows `JobProgress` in the dialog. On success the audit page shows the finalized callout with the commit.

## States

| State | What shows |
|---|---|
| Loading | Section card skeletons and the two side cards |
| Not built | Info callout "The report isn't built yet" and "Build the report" (`audits.run`); no section cards |
| No accepted findings | Computed sections show `EmptyState` "Nothing accepted yet" with "Open findings"; narrative "Draft with the model" is disabled with "Accept some findings first." |
| Model draft failed | Destructive callout in the section card with the error as a plain sentence and "Try again" |
| Finalized | Read only: no Edit, Draft, Hide, Rebuild or Finalize; the export card stays (exports of a finalized report read `report.md` from the commit) |
| Read only (Viewer) | Sections and the export card; no section actions, no rebuild, no finalize card |

## Permissions

| Action | Permission |
|---|---|
| See the report | `audits.read` |
| Export HTML | `audits.read` |
| Edit, draft with the model, hide, rebuild | `audits.run` |
| Finalize | `audits.run` |

Export is a read: Viewers already export journals. See open items.

## Audit log

`report.build`, `report.section.edit` (section ID), `report.section.draft` (section ID, model ID, tokens), `report.section.hide` and `report.section.show`, `report.export` (audience, result, rule IDs that matched; never the excerpts), `audit.finalize` (commit, counts).

## Data

- `getReportView(auditId)`: sections in order with audience, kind, hidden, narrative and its source and editor, computed rows, `builtAt`, the stale count, the accepted and proposed counts, and the last export result.
- Service functions (audit-reports module): `rebuildReport`, `saveNarrative`, `draftNarrative` (enqueues the model call), `setSectionHidden`, `exportReport(audience)` returning a file or the violations with section and position, `finalizeAudit`.

## Components

`StatusBadge`, `Callout`, `DisabledReason`, `EmptyState`, `Time`, `SafeMarkdown`, `JobProgress`, `SectionCard`, shadcn `RadioGroup`, `Dialog`, `AlertDialog`, `Textarea`, `Table`.

## Open items

- **Finalize with proposed findings.** The design allowed it and warned that they are left out. Decided: finalizing is blocked until every finding has a decision (MASTER "Page index"), and the finalize dialog lists what is undecided instead of the warning callout described above.
- **Who can export.** Viewers (as for journal exports) or Editors. Viewers is the current rule.
- **Where an output-rule match is.** `checkOutputText` returns a character offset in the checked text. The export needs a section ID and a row or paragraph, so the audit-reports module checks section by section and maps offsets to rows.
