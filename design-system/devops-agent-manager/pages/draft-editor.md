# Page: Draft editor

Overrides `MASTER.md` for `/spaces/[alias]/assets/[assetId]/draft`. Screens (example data): instructions, a skill, and a managed memory (status only), in light and dark, with the instructions screen also at 768 px. Code: drafts live in `src/server/drafts/`.

## Model

- A draft is one person's pending edit of one asset: files, metadata, and the live version and `updatedAt` it started from (its base). Each person has at most one open draft per asset.
- "Edit as draft" on the asset page opens this route. With no draft yet, the editor starts from the live version, and the first "Save draft" creates the draft.
- The status switch on the asset page writes to the same draft (asset-detail.md), so a status-only draft opens here too.
- `?draft=<draftId>` opens another person's draft of the asset, read only.
- A draft never touches the space. Only an applied plan does.

## Layout, top to bottom

1. **Top bar:** breadcrumb "Assets › <Type plural> › <parent name, if any> › <name> › Draft"; `SyncStatus` on the right.
2. **Header** (the asset page header pattern from `asset-detail.md`, without the status control):
   - Icon box with the asset-type icon, `h1` asset name, the type badge, "Managed store" when it applies, and an info-tone "Draft" badge with SquarePen.
   - Meta line: "Your draft, based on live v<N>" (or "Draft by <name>, based on live v<N>"), then "Last saved <Time>", then "Unsaved changes" in `text-warning-fg` while the form is dirty.
   - Actions on the right (table below), with "Nothing changes in the space until a plan is applied." under them in muted 12.5 px text.
3. **Callouts:** zero to three, in the order of the table below.
4. **Tabs:** shadcn `Tabs` held in client state, not links, so unsaved text survives a tab switch. Labels: "Edit", "Preview", "Changes" with the "+N −M" counts in the tab's count pill (or "status" for a status-only change). Managed memories get "Content" (read only) and "Changes" instead.
5. **Two columns:** the tab panel on the left; "Validation" and "Details" cards on the right (360 px, the asset page width). Below 1280 px the cards move under the editor, two across (MASTER "Responsive").

## Edit tab

- **Card header:** the file path in mono and the format in muted 12 px ("Markdown", "Markdown with YAML frontmatter").
- **Several files:** up to four files use a `ToggleGroup` of file paths in the card header; more than four use the existing `PathTree` on the left of the editor. Deleting or adding files is not part of the editor.
- **Size meter (instructions only):** the existing `SizeMeterView` under the card header ("4.4 KB of 25 KB · 95 lines (about 120 recommended)"), with the tones from `asset-detail.md`. It recalculates in the browser from the policy limits the page passes in (`agentsMdMaxBytes`, `agentsMdRecommendedLines`). Its text sits in one `role="status"` `aria-atomic` region that updates after typing pauses for 1 s, so screen readers don't hear every keystroke.
- **Editor:** a shadcn `Textarea`: `font-mono`, 13 px, line height 1.6, soft wrap (`whitespace-pre-wrap`, long words break), `spellCheck={false}`, at least 520 px tall, vertical resize only, a visually hidden label "<file> content". Long lines wrap, as in diffs (MASTER "Diffs"): prose in memories and instructions is often one long line per paragraph. The revision editor uses the same editor. The focus ring is drawn inset (`outline-offset: -2px`) because the card clips it.
- **Footer help:** "Plain markdown. Tab moves focus out of the editor, so indent with spaces."
- **Unsaved changes:** leaving the page while dirty triggers the browser's `beforeunload` prompt. No custom dialog.

## Preview tab

The draft's main file rendered through `SafeMarkdown`, with YAML frontmatter as a definition list, exactly as the asset page's Rendered view. Card header: "<file> · your draft, rendered".

## Changes tab

- Live version against the draft, in the MASTER "Diffs" style, using the existing `FileDiffView`. Card header: "Live v<N> → your draft", the +N and −M counts, and a Content or Metadata `ToggleGroup`. Metadata uses the existing `ValueChanges`.
- With several files, the header's file `ToggleGroup` shows each file's counts ("SKILL.md +6 −1", "references/checklist.md, no change").
- A status-only draft shows a three-column table: Key, Live, Draft.

## Validation card

- **Header badge:** "Passed" (success, Check), "<N> errors" (destructive, CircleX) or "<N> warnings" (warning, TriangleAlert). Errors win.
- **Rows:** one per `ValidationResult`, errors first: tone icon, the message, then `code` or `path` in mono 12 px.
- **When it runs:**
  - Metadata is checked in the browser as the user edits, with `ajv` (already a dependency) against `resolvedSchema(policy, assetType)`. Field errors appear under their fields as well.
  - Files are checked on save with `validateDraftAsset` and `validateAssetSet` (identity and count rules against the live space).
- **Footer help:** "Details are checked as you edit. Files are checked when you save." With no errors, the single row reads "No errors or warnings" plus "Checked at your last save, <Time>."
- Saving is allowed with errors, because a draft is work in progress. The drafts screen blocks a plan that includes a draft with errors.

## Details card

The form is generated from the asset type's `metadataSchema` in `policy/asset-types.yaml`, so a new asset type needs a schema entry, not new code.

| Schema shape | Control |
|---|---|
| `status` on a type with `supportsStatus` | `Switch` with its label, "Active" or "Inactive". Help: "Live is <status>. Switching a <type> off doesn't create a new version." when it differs from live |
| Array of `#/$defs/agentType` | Checkbox group, two columns, labels from `policy/agent-types.yaml` in that file's order |
| `#/$defs/description` | `Textarea` with a live count "<n> of 1,024 characters" (max from `limits.descriptionMaxChars`) |
| Other string | `Input` |
| Array of strings (`enable_tools`, `tools`) | `Input`; help "Separate values with commas." |
| A key listed in the type's `references` (`memory_store_id`, `skills`, `memory_stores`) | A picker by asset name; the app writes the asset IDs |
| The identity key of `agents_md` (`agent_type`), `skill_type`, and any `immutableKeys` | Read-only text in a definition list |

- **Labels:** the property's JSON Schema `title`, or else the key in sentence case ("enable_tools" becomes "Enable tools").
- **Help and errors:** the property's `x-hint` is the help text under the field. When the field fails, the same text turns into the error, shown in `text-destructive-fg` with CircleX and `role="alert"`.
- **Read-only facts** under the form, in a definition list: live version and date, and the short asset ID in mono.
- **Instructions:** only the read-only "Agent type" row, plus "Each agent type has its own instructions file, so a draft can't change which agent type this file is for."

## By asset type

| Type | Edit tab | Details |
|---|---|---|
| Instructions | `AGENTS.md`, size meter | Agent type (read only) |
| Skill | `SKILL.md` and its files (file toggle or `PathTree`) | Name, description, agent types, status, enable tools, skill type (read only) |
| Memory store | `README.md` | Name, description, agent types, status |
| Memory, user store | The memory file | Name, description, status, store (picker) |
| Memory, managed store | The memory file, like a user store | Name, description, status. When plans.yaml `managed` turns editing off: no Edit tab, status switch only |
| Custom agent | `AGENT.md` | Name, tools, skills and memory stores (pickers by name) |
| Artifact, attachment, feedback | Not editable (`editable: false` or no text content). "Edit as draft" is not shown | |

The API writes a managed memory's content and description (tested on a test Agent Space), so plans.yaml `managed` allows both by default.

## Callouts

| When | Tone | Title | Body | Action |
|---|---|---|---|---|
| The asset was deleted from the space after the draft was made | destructive | "Deleted from the space on <Time>" | "Discard the draft, or restore the asset as a plan from its page." | "Open asset" |
| Live moved past the draft's base | warning | "Live moved from v<a> to v<b> at <Time> (<source>)" | "The Changes tab now includes their change. A plan skips this draft until it is based on v<b>." | "Use v<b> as the base" (keeps your text; the diff then shows what your text replaces) |
| The draft is in an open plan | info | "This draft is in plan <title>" | "Discard the plan to edit the draft again." | "Open plan" |
| A managed memory, when plans.yaml turns editing off | info | "Only the status can change" | "Editing memories in managed stores is turned off in this app's plan rules. You can still switch them on or off." | none |
| Someone else has an open draft of this asset | info | "<name> also has a draft of <asset>" | "Saved <Time>, based on v<N>. Plans apply one at a time, so the second plan to reach <asset> skips it and asks for a re-check." | "Open drafts" |

## Buttons by role and state

Show the first row that applies. Without `drafts.write` the route redirects to the asset page; other people's drafts are read only for everyone.

| Who | State | Buttons |
|---|---|---|
| Someone else's draft (`?draft=`) | any | None. Meta reads "Draft by <name>, read only" |
| Author | New, not saved yet | "Save draft" (primary), "Cancel" (ghost, back to the asset page) |
| Author | In an open plan | "Save draft" disabled through `DisabledReason`: "This draft is in plan <title>." |
| Author | Asset deleted from the space | "Save draft" disabled: "The asset was deleted from the space." "Discard draft" (ghost) |
| Author | Saved, no unsaved changes | "Save draft" disabled: "No unsaved changes". "Discard draft" (ghost) |
| Author | Unsaved changes | "Save draft" (primary), "Discard draft" (ghost) |

- **Discard confirmation:** an `AlertDialog` titled "Discard your draft of <name>?", body "Your edits are deleted. The live space is not affected.", buttons "Discard draft" (destructive) and "Cancel". Then go to the asset page.
- **Save:** no toast. The meta line changes to "Last saved <Time>", and one polite live region announces "Draft saved. <N> errors, <M> warnings."
- Save sends changed files only. Server Actions accept 1 MB request bodies by default (Next.js `serverActions.bodySizeLimit`), and a single text file may be up to 1.5 MB (`singleTextFileMaxBytes`). Raise the limit or save large files through a Route Handler.

## Loading

`loading.tsx`: header skeleton, a tab row, one 520 px block for the editor, and two side cards.

## Audit log

Record `draft.save` (asset ID, base version, which files and metadata keys changed) and `draft.discard` (AGENTS.md: `recordAuditEvent`).

## Data

- A loader returns:
  - the live snapshot (files, metadata, version, `updatedAt`, managed flag);
  - the user's draft, or null;
  - the other open drafts of the asset (author, saved time, base version);
  - the open plan that holds the draft, if any;
  - the resolved schema, the size limits, and the agent type labels.
- Server Actions: `saveDraft` and `discardDraft`. They call the drafts service with the actor.

## Open items

- **Editor: plain `Textarea` or Monaco.** The original stack table lists Monaco "to choose at build time", and MASTER allows no new dependencies. The `Textarea` is what is built. The comparison:

  | | `Textarea` | Monaco (`@monaco-editor/react` 4.7.0 with `monaco-editor` 0.57.0) |
  |---|---|---|
  | Dependencies | None. The shadcn `Textarea` is installed | Two new packages |
  | Bundle size | Nothing added | The editor chunk alone is 2.5 MB minified (`min/vs/editor-*.js` in the 0.57.0 file listing on jsDelivr), plus 0.4 MB of CSS. The npm package unpacks to 102 MB. Markdown needs no language worker |
  | Diff view | The Diff tab uses the existing `FileDiffView`, so it matches the plan review and compare screens | Built-in `DiffEditor` (side by side or inline). It would look unlike the plan review and compare diffs unless those move to Monaco too |
  | Offline build | Nothing to fetch | `@monaco-editor/react` loads Monaco from `cdn.jsdelivr.net` by default. Offline use needs `loader.config({ monaco })` with the npm package bundled, and its README warns this may need extra bundler setup. This repo builds with Next.js 16 and Turbopack; that setup is untested here |
  | Rendering | Server-rendered form control | Browser only: it needs `document`, so it loads with a client-only dynamic import (README, Next.js note) |
  | Editing | No line numbers, no syntax colors, browser find only. Tab leaves the field, which keeps keyboard use simple | Line numbers, markdown highlighting, find and replace, multiple cursors. Tab indents inside the editor, so the keyboard pass must check how a user leaves it (not verified here) |

  Recommendation: start with the `Textarea`. It adds no dependency, keeps one diff style, and builds offline. Revisit Monaco if editing long instructions (more than 120 lines) proves slow in practice. Sources: the [monaco-react README](https://github.com/suren-atoyan/monaco-react) for the CDN default, `loader.config` and the Next.js note; the npm registry for versions and unpacked size; the [jsDelivr file listing for monaco-editor 0.57.0](https://data.jsdelivr.com/v1/packages/npm/monaco-editor@0.57.0?structure=flat) for chunk sizes.
- **Field labels.** `asset-types.yaml` has no `title` on its properties, so labels fall back to the key in sentence case ("Agent types", "Enable tools"). Add `title` where the fallback reads badly.
- **"Use v<b> as the base"** keeps the user's text and drops the newer live change unless they merge it by hand. A three-way merge is not in scope; confirm this is acceptable.
