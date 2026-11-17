# DevOps Agent Manager: UI design spec (MASTER)

This is the source of truth for how the app looks and behaves. It describes the "activity console" design: a sidebar shell, a change feed that leads each page, and color reserved for status and source.

- Page files in `pages/` add rules for one screen. A page file wins over this file for that screen. `AGENTS.md` wins over both.
- There are no mockup files in the repository. This file and the page files are the design, and the "Verification" checks below are the bar for a finished screen.
- Examples in the page files use the fictional AnyCompany Tickets (`sample-data/`).

## How to use this spec

1. Read this file, then the page file for your route. If your route has no page file, use the pattern listed under "Other pages".
2. Build with the shared components (see "Shared components"). Do not build your own badge, callout, time or empty-state variants. If a shared component is missing something, extend it for every page that uses it.
3. For a question this spec doesn't answer, look for a focused UX or shadcn reference. Don't adopt a generated design system wholesale: its palette and fonts contradict the decisions below.
4. Keep changes small: shadcn components before custom ones, no new dependencies beyond those listed here.

## Principles

1. **Changes and who made them come first.** The home page leads with what needs attention and what changed. Connection and sync details are secondary.
2. **Color means status or source, nothing else.** Primary stays neutral black and white. Every color carries an icon or text too.
3. **Use the console's words.** Instructions, Skills, Memory stores, Memories, Custom agents, Artifacts. Never show API type IDs such as `agents_md` as labels.
4. **Every disabled control says why, next to it.** No hover-only explanations.
5. **Show what will change before the button.** No write reaches a space without a plan that shows the diff first.
6. **Dense but readable.** 14 px UI text, 12 px floor, tabular numbers.

## Tokens

Add these to `src/app/globals.css`. Keep every other shadcn token as it is. The light-mode changes to `--muted-foreground` and `--ring` fix measured contrast failures; all values were checked with the theme contrast test described under "Verification".

```css
:root {
  --muted-foreground: oklch(0.5 0 0);      /* was 0.556: 4.35:1 on --muted, needs 4.5 */
  --ring: oklch(0.45 0 0);                 /* was 0.708: 2.58:1 on white, needs 3 */
  --destructive-fg: oklch(0.5 0.2 27);     /* red text on red-tinted rows; --destructive is 4.16:1 there */
  --success: oklch(0.6 0.15 150);  --success-fg: oklch(0.45 0.12 150);
  --warning: oklch(0.72 0.15 70);  --warning-fg: oklch(0.47 0.11 60);
  --info: oklch(0.55 0.16 255);    --info-fg: oklch(0.45 0.15 255);
  --src-agent: oklch(0.48 0.2 295);
  --src-console: oklch(0.47 0.15 245);
  --src-cli: oklch(0.47 0.09 195);
  --src-app: oklch(0.47 0.12 150);
  --src-unknown: oklch(0.5 0 0);
}
.dark {
  --destructive-fg: oklch(0.78 0.14 25);
  --success: oklch(0.72 0.15 150); --success-fg: oklch(0.8 0.13 150);
  --warning: oklch(0.78 0.14 75);  --warning-fg: oklch(0.85 0.12 80);
  --info: oklch(0.72 0.12 255);    --info-fg: oklch(0.8 0.1 255);
  --src-agent: oklch(0.8 0.12 295);
  --src-console: oklch(0.8 0.1 245);
  --src-cli: oklch(0.8 0.08 195);
  --src-app: oklch(0.8 0.12 150);
  --src-unknown: oklch(0.74 0 0);
}
@theme inline {
  --color-destructive-fg: var(--destructive-fg);
  --color-success: var(--success); --color-success-fg: var(--success-fg);
  --color-warning: var(--warning); --color-warning-fg: var(--warning-fg);
  --color-info: var(--info);       --color-info-fg: var(--info-fg);
  --color-src-agent: var(--src-agent); --color-src-console: var(--src-console);
  --color-src-cli: var(--src-cli);     --color-src-app: var(--src-app);
  --color-src-unknown: var(--src-unknown);
}
```

Rules:

- Text and icons use the `-fg` variant (`text-warning-fg`). The base token is for fills, borders and dots.
- Tinted fills use these opacities: source chip 12%, callout background 7%, status badge 12%, added diff line 14%, deleted diff line 10%, diff hunk header 8%. Callout and badge borders use 40 to 45%.
- With Tailwind 4, write tints as opacity modifiers (`bg-src-agent/12`). Check the computed color in the browser once per component: the theme test assumes these exact percentages.
- Never write a raw hex, oklch or palette class (`bg-green-50`) in a component.

## Typography

- Keep the system font stacks already in `globals.css`. No Google Fonts: builds must work offline.
- Page title (one `h1` per page): 22 px, semibold, tight tracking. Section and card titles (`h2`): 14 px semibold.
- Body, tables and controls: 14 px (`text-sm`), line height 1.5. Meta text: 12 px (`text-xs`). Nothing smaller than 12 px.
- Monospace (`font-mono text-xs`) for IDs, hashes, file paths and repository names. Version numbers use the version badge.
- Counts, times, sizes and versions use `tabular-nums`. Right-align numeric table columns.
- Prose (descriptions, rendered markdown) stops at 72 characters per line.

## Spacing and layout

- 4 px grid. Page content sits in `mx-auto max-w-7xl` with 24 px side padding (16 px below 640 px) and 20 px top padding.
- Gaps: 16 px between page sections, 12 px between stat tiles, 8 px inside toolbars and button groups.
- Cards use the shadcn `Card` defaults. Card header: 48 px minimum height, 16 px side padding, bottom border. List rows: 8 px vertical padding.
- Two-column pages: main column plus a 320 px side column (360 px on the asset page), stacked into one column below 1280 px.

## Shell

Every page under `src/app/(app)/` gets the shell from the layout.

- **Sidebar.** shadcn `Sidebar` (`pnpm dlx shadcn@4.23.0 add sidebar`), `variant="sidebar"`, `collapsible="offcanvas"`, default width 16rem. `SidebarTrigger` sits at the left of the top bar; Cmd+B / Ctrl+B toggles it. Below the hook's mobile breakpoint (check `src/hooks/use-mobile.ts` after adding; the shadcn template uses 768 px) it becomes a sheet.
- **Sidebar header.** Space switcher (DropdownMenu listing spaces with region and connection dot, then "All spaces", and "Register a space" for Admins), then a Search button that opens the command dialog (Cmd+K).
- **Navigation.** Groups and items, each with a lucide icon and a text label. Hide an item when the user lacks its read permission. A group left with one visible item joins the group above (a Viewer's All spaces sits under Investigations), so no heading sits over a lone item. Items for later phases stay visible with a dashed "Planned" badge, whose tooltip says "Planned for phase <N>", and their route shows the phase placeholder (see "Patterns").

| Group | Item | Route | Icon | Read permission | Phase |
|---|---|---|---|---|---|
| Space | Home | `/spaces/[alias]` | House | assets.read | 1 |
| Space | Assets | `/spaces/[alias]/assets` | Layers | assets.read | 1 |
| Space | History | `/spaces/[alias]/history` | RotateCcwClock | history.read | 1 |
| Space | Plans | `/spaces/[alias]/plans` | GitPullRequest | assets.read | 2 |
| Space | Releases | `/spaces/[alias]/releases` | Tag | history.read | 2 |
| Space | Who can do what | `/spaces/[alias]/roles` | Users | assets.read | 2 |
| Investigations | Journals | `/spaces/[alias]/journals` | NotebookText | journals.read | 1 |
| Investigations | Analysis | `/spaces/[alias]/analysis` | ListChecks | audits.read | 1 |
| Investigations | Audits | `/spaces/[alias]/audits` | Microscope | audits.read | 3 |
| Investigations | Revisions | `/spaces/[alias]/revisions` | GitBranch | audits.read | 4 |
| Admin | Space settings | `/spaces/[alias]/settings` | Settings | spaces.manage | 1 |
| Admin | All spaces | `/spaces` | Folder | (any signed-in user) | 1 |
| Admin | Audit log | `/audit-log` | ScrollText | auditlog.read | 1 |

- **Sidebar footer.** Avatar initials, name, the user's role for this space, and "local sign-in bypass" when `devBypass` is on. It opens a menu with Theme (Light, Dark, System) and Sign out.
- **Top bar.** 52 px tall: SidebarTrigger, a vertical separator, then a shadcn `Breadcrumb` whose last item has `aria-current="page"`. The right side holds space-wide controls only: `SyncStatus` and "Sync now" on space pages. Page actions go in the page header, not the top bar.
- **Theme.** Add a `next-themes` `ThemeProvider` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`, `disableTransitionOnChange`) to the root layout. `next-themes` is already installed and `sonner.tsx` already reads it.
- **Skip link.** First focusable element: "Skip to main content", visible on focus, pointing at `<main id="main" tabIndex={-1}>`.
- **The `/` route** stays a list of spaces (the All spaces page).

## Shared components

These live in `src/components/common/` unless noted. Pages use them as they are.

| Component | Props | Behavior |
|---|---|---|
| `AppSidebar`, `SpaceSwitcher`, `CommandSearch` (in `app-shell/`) | spaces, current alias, user, role | As in "Shell". Command search lists "Pages and actions" first, from the one table `COMMAND_PAGES` in `app-shell/command-pages.ts`, matched by everyday words (global, instructions, snapshot, release, undo, restore, history, roles, settings, import, approve) and filtered by the user's permissions. Then asset types, then assets by display name, still found by their stored name ("GENERIC"). |
| `TopBar` (in `app-shell/`) | `crumbs: {label, href?}[]`, `right?: ReactNode` | Replaces the breadcrumb part of `assets/page-header.tsx`. |
| `PageHeader` | `title`, `description?`, `meta?: ReactNode[]`, `badges?`, `actions?`, `icon?` | `h1` plus one muted line of meta joined by " · ". Actions sit at the right and wrap below on narrow screens. |
| `SyncStatus` (client) | `lastCompletedAt`, `status`, `error?`, `intervalMinutes` | States in the table below. Re-renders its relative time every 30 s. One polite live region announces state changes. A shadcn Tooltip shows the exact time, the interval and the stale rule. |
| `SourceBadge` | `source: ChangeSource`, `principal?: string \| null` | Icon plus short label on a 12% tint of the source token. Short labels come from policy (see below). The tooltip shows the long policy label and the principal. |
| `VersionBadge` | `version: number \| "new" \| "deleted"` | Monospace `v24`, `new` or `deleted` on `bg-muted`. |
| `Time` (server) | `value`, `format: "time" \| "date" \| "datetime" \| "day"` | `<time dateTime>`. Formats in the viewer's time zone (below). The tooltip shows UTC, for example `2026-11-10 23:38:13 UTC`. |
| `RelativeTime` (client) | `value` | "12 min ago". Use only for freshness (sync, connection check), never for history rows. |
| `Callout` | `tone: "info" \| "warning" \| "destructive" \| "success"`, `title`, `children`, `action?` | Built on shadcn `Alert`. Icon in the `-fg` color, 7% tint, 40% border. Warning and destructive callouts use `role="alert"` only when they appear after a user action; otherwise `role="status"`. |
| `StatTile` | `icon`, `label`, `value`, `detail?`, `action?` | Card with a 12 px label, 22 px value, 12 px detail and an optional small button. |
| `EmptyState` | `title`, `children`, `action?` | Bold title, one or two sentences, and one action if the user can act. |
| `DisabledReason` | `reason`, one child button | Renders the child disabled, puts the reason text beside or below it with a lock icon, and links them with `aria-describedby`. |
| `PhasePlaceholder` | `phase`, `title`, `description` | The page for a nav item whose phase isn't built: the "Planned" badge in the header, then an `EmptyState` whose title says what the page will do and whose body says "This part of the app isn't built yet." The phase number appears only in the badge's tooltip. |
| `ChangeFeed`, `ChangeRow` | `items: FeedItem[]`, `limit?`, `showFilters?`, `canWriteReasons` | Groups items, adds day headers and row actions as in `pages/space-home.md`. Filters read and write URL search params. Used by Home and History. |
| `StatusBadge` | `tone`, `icon?`, `label` | One badge for plan states and validation; presets in `STATUS`. 12% tint, 40 to 45% border, `-fg` text. |
| `ChangeChip` | `word`, `label?` | Icon plus text for plan-item, drift and import change words; the word table is `CHANGE_WORDS`. |
| `ValidationList` | `results: ValidationResult[]`, `emptyHelp?` | One row per result, errors first, with icon and message. The rule code (and path) follows as a muted "Details: <code>" line, so the message reads on its own. |
| `Checkbox` | shadcn props | 24 px target and a `border-muted-foreground` border, so it reaches 3:1. Use it instead of `ui/checkbox`. |
| `LinkTabs` | `items: {key, href, label, count?}[]`, `current`, `label` | Tabs that are links, with `aria-current="page"`. Asset page tabs and Plans or Drafts. |

Supporting pieces the shared components rely on:

- `FeedItem` in `src/lib/assets/types.ts`: `{ assetId, assetType, name, parentName, version, kind: "created" | "baseline" | "content" | "metadata" | "deleted", source: ChangeSource, principal, at, commit, provisional, hasReason }`, returned by a query in `src/server/assets/` from `asset_changes` joined to `asset_index`.
- `shortLabels` in `policy/attribution.yaml` and its section schema: `app: This app`, `console: Web app`, `cli: CLI or SDK`, `agent: DevOps Agent`, `unknown: Unknown`. The existing `labels` stay as the long form.
- An optional `environment` field (free text such as "Test" or "Production") in `src/server/spaces/settings-schema.ts`. The space switcher shows it under the space name ("Test · us-west-2"), and the home page header uses it. When it is unset, show only the region.
- shadcn components: `sidebar`, `toggle-group`, `alert-dialog`, `collapsible`.

### Change sources

| Source | Chip text (policy `shortLabels`) | Icon | Token |
|---|---|---|---|
| `agent` | DevOps Agent | Bot | `--src-agent` |
| `console` | Web app (the long label "Operator Web App" is the DevOps Agent's own web app) | Monitor | `--src-console` |
| `cli` | CLI or SDK | Terminal | `--src-cli` |
| `app` | This app | UserCheck | `--src-app` |
| `unknown` | Unknown | CircleQuestionMark | `--src-unknown` |

A change whose attribution is provisional shows the chip with a dashed border and "(checking)" in the tooltip until re-attribution finishes.

A table column that shows the principal (the IAM role, user or session name behind a change) is headed "Changed by", never "Principal".

### Sync status states

| State | When | Dot or icon | Text |
|---|---|---|---|
| ok | Last sync finished less than 2 × interval ago | success dot | "Synced 12 min ago" |
| stale | Last sync finished 2 × interval ago or more | warning dot | "Last sync 2 h ago" |
| running | A sync job is running | spinner (motion-safe) | "Syncing" |
| failed | Last sync failed | destructive icon | "Sync failed", error in the tooltip |
| never | No sync has finished | muted dot | "Not synced yet" |

The interval is the space's `syncIntervalMinutes` setting, or `intervalMinutes` in `policy/sync.yaml` (15) when that is unset, so stale starts at 30 minutes by default. The text always accompanies the dot.

### Time zone

A small client effect in the shell writes the browser's time zone to a `tz` cookie. `Time` reads it with `cookies()` and falls back to UTC, adding "UTC" to the text when it does. Formats: a time today is "3:38 PM"; a date this year is "Nov 10, 3:38 PM"; an older date is "Nov 10, 2025"; feed day headers are "Monday, Nov 10".

## Patterns

**Statuses.** Use one word set everywhere:

| Status | Tone | Icon | Words |
|---|---|---|---|
| Connected / connection failed | success / destructive | CircleCheck / CircleX | "Connected", "Connection failed" |
| Plan states | warning, info, success, destructive | Clock, Loader, CircleCheck, CircleX | "Waiting for approval", "Applying", "Applied", "Failed" |
| Plan item | info / agent / warning / muted | SquarePen, PowerOff, TriangleAlert, Equal | "Update content", "Set Inactive", "Skip: live changed", "No change" |
| Validation | success / destructive / muted | Check / CircleX | "Passed", "Failed", "Not checked" |
| Asset status | neutral | Switch | Active / Inactive switch with its label, never a colored word alone |

**Attention callouts.** At most three per page, most severe first. Each says what happened and offers one next step. Toasts (sonner) only confirm work the user just started ("Sync requested"); they never carry errors or anything the user must act on.

**Disabled and hidden actions.**
- Hide an action the user's role can never perform.
- Disable an action the current state blocks, and show the reason with `DisabledReason`.
- Don't render actions for features that don't exist yet. The nav item and its `PhasePlaceholder` cover that.

**Empty states.** Use `EmptyState`. Say what will appear and how to get it, for example: "No investigations cached yet." plus "Export journals".

**Loading.**
- Each route has a `loading.tsx` whose `Skeleton` blocks match the page layout.
- Use `Suspense` only around a panel that waits on a slow live call (for example a live-space check).
- Background jobs use the existing `JobProgress`.
- Don't show a spinner for work that usually finishes in under 300 ms.

**Errors.** A field error sits under the field with `role="alert"` and says how to fix it. A page-level failure is a destructive `Callout` with the next step. Never show only a red border.

**Tables.** Use shadcn `Table`.
- The row's name is the link; don't make the whole row clickable.
- Use sticky headers on long tables.
- Over 50 rows, use "Show more" or pagination.
- Don't add TanStack Table unless a page needs column sorting.

**Filters.** A toolbar of `DropdownMenu` checkbox menus ("Source: All", "Type: All", "Last 30 days") plus a name `Input`. The toolbar wraps on narrow screens. Filter state lives in URL search params so links and Back keep it.

**Diffs.**
- Unified by default, with a `ToggleGroup` for Unified or Split (Split only at 1024 px and wider). Plan review adds Words, its default there: a reworded line shows once, with the removed words struck through and the added words marked (`plan-review.md`).
- Show old and new line numbers, hunk headers, and the +N and −M counts.
- Long lines wrap, in Unified and Split. A wrapped line keeps one line number, aligned to its first row, and keeps the leading +, − or space marker on that row only. Words too long for the column break anywhere. Prose in memories and instructions is often one long line per paragraph, so the changed part must be visible without scrolling.
- A Content or Metadata toggle switches to the metadata diff (the existing `ValueChanges`).

**Confirmation.** Applying a plan, restoring and discarding a plan open an `AlertDialog`. The dialog names the space, gives the counts ("3 changes to AnyCompany Tickets (sample)") and repeats the change reason. Writes to a space have no undo toast: a restore is a new plan.

**Untrusted content.** Memory bodies, skills, instructions and journals render only through `SafeMarkdown` (AGENTS.md).

**Icons.**
- Use `lucide-react` only, at the default stroke width.
- Sizes: 16 px in controls, 14 px in meta lines, 20 px in page icons.
- Decorative icons get `aria-hidden`. Icon-only buttons need an `aria-label`.

**Motion.** Only color and background transitions, 150 to 200 ms. No layout animation. Wrap anything else in `motion-safe:`.

## Copy

- Plain, specific sentences. No em dashes. Sentence case for labels and headings.
- Buttons start with a verb and name the thing: "Sync now", "Add reason", "Export journals", "Apply 3 changes".
- Name counts and versions ("4 memories updated", "v23 and v24"), not "some" or "recent".
- An error says what happened and what to do next.
- Use allowlist and denylist, primary and replica (AGENTS.md).
- **Asset names.** Show the display name from `assetLabel()` (`src/server/history/display-name.ts`) wherever an asset is named: the asset list, the asset page header and crumbs, the change feed and History, command search, and the release, import and plan tables. Instruction files are "Global instructions" (agent type `GENERIC`) and "<agent type short label> instructions" (`policy/agent-types.yaml`, for example "Incident triage instructions"); their agent type ID appears only in mono meta text. An artifact whose stored name is only its ID shows `metadata.title`. The stored name stays the identity for history paths and matching.
- **Word list.** Use these words in UI text:

  | Instead of | Say |
  |---|---|
  | Roll back, rollback | Restore: "Restore v13 as a plan", "Restore this version", "Restore this release", plan titles "Restore <name> to v13" and "Restore <space> to release <name>". Code identifiers and audit action names keep "rollback". |
  | GENERIC (as a name) | Global instructions |
  | Managed store: content editing | Managed memories can be edited. When plans.yaml turns it off: "Editing memories in managed stores is turned off in this app's plan rules. You can still switch them on or off." |
  | Phase 3, Phase 4, "arrives with phase N" | Badge "Planned" (tooltip "Planned for phase N"); placeholder "This part of the app isn't built yet." |
  | client token | Each change is sent once, even if apply is retried. |
  | compares content hashes | Reads every asset back and checks it matches the plan. |
  | git note, commit, manifest, tag (copy for non-admins) | The effect first: "Saved with this change in the history", "Saved in the history repository". The technical name stays in Admin settings and mono meta. |
  | Principal (column) | Changed by |
  | Release, unexplained | Release, with "A saved snapshot of every asset that you can restore later." (`RELEASE_SENTENCE` in `src/server/releases/views.ts`) |
  | Raw AWS SDK errors | `liveErrorMessage()` in `src/server/assets/live.ts`: a plain sentence with a next step |
  | Subject type, IdP group | "A person, by email", "A group from your sign-in provider" |
  | Policy default, commit policy | "Default" (the app's setting), "Versions kept" |

- **Roles.** Each role's `description` in `policy/roles.yaml` says what that role can do on its own, without pointing at another role. The "Who can do what" page (`/spaces/[alias]/roles`, for anyone with `assets.read`) lists each role, its description, who can approve and apply plans, the caller's role, and who holds each role in this space, global bindings and the local sign-in bypass user included. Holders (emails and group names) are shown to every role. For Admins, Space settings starts with the same card and edits the bindings; for anyone else, Space settings shows "Space settings are for Admins" with a link to the page. Every "Ask an Admin" next step and every role note links to the page. "Require approval from a second person" shows a warning while it is checked and fewer than two people can approve and apply plans.

## Accessibility

- Text contrast is at least 4.5:1. Text of 24 px or more, or 18.66 px or more in bold, needs 3:1.
- Focus rings, control borders and meaningful icons need 3:1.
- Focus ring: 2 px `--ring` outline with a 2 px offset on every control. Never remove it.
- Every pointer target is at least 24 by 24 px (WCAG 2.2 AA). Breadcrumb links, feed titles and switches count. Small buttons are 28 px.
- Color is never the only signal: dots carry text, and chips carry icon and text.
- One `h1` per page and `h2` for sections. Landmarks: `nav` for the sidebar and breadcrumbs, `main` for content.
- Keyboard: Tab order follows the visual order. Esc closes dialogs and menus and returns focus to the trigger. Cmd+K opens search and Cmd+B toggles the sidebar.
- Truncated text (names, paths) stays available in full through the link target or a tooltip that also opens on keyboard focus.

## Responsive

| Width | Behavior |
|---|---|
| 1280 px and up | Sidebar open; two-column pages side by side; four stat tiles in a row. |
| 1024 to 1279 px | Side column moves below the main column, its cards two across. |
| 768 to 1023 px | Same as above; Split diff not offered. |
| Below the sidebar breakpoint (768 px) | Sidebar becomes a sheet opened by the trigger. Stat tiles two across. Feed rows stack: source and time on top, then the title, then the actions. |
| Below 640 px | Side cards one across. Callout actions drop below the text. Breadcrumbs keep only the last two items. |

## Verification (done means all of these pass)

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` (AGENTS.md).
2. **Theme contrast test.** `src/app/theme.test.ts` parses `globals.css` and checks every pair in the "Tokens" rules, in both themes, at the listed tint percentages: text on background, card, muted and sidebar accent; each `-fg` on its callout and badge tint; each source on its chip; diff text on its line tint; and the ring on background and card. Changing a token means running this test.
3. **Screenshots.** Start the app on a free port (`DAM_HOST=127.0.0.1`, `AUTH_DEV_BYPASS` on loopback). Capture with headless Chrome:
   ```
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
     --window-size=1440,900 --screenshot=<file>.png http://127.0.0.1:<port>/<route>
   ```
   Capture 1440 px in light and dark, plus 768 px. Headless Chrome won't lay out narrower than 500 px, so skip phone width unless you load the page in a 390 px iframe. Check each screen against its page file (and this file, for a screen without one), and put the screenshots in your report. Stop the server when done.
4. **Keyboard pass.** Tab from the top of the page: the skip link, then sidebar, top bar and main content. The focus ring is visible on every stop. Dialogs keep focus inside and return it on close.
5. No dependencies beyond the shadcn components listed in "Shared components".

## Page index

| Route | Pattern |
|---|---|
| `/spaces` and `/` (All spaces) | `PageHeader` plus a `Table`: name, region, connection, `SyncStatus` (compact), changes in the last 7 days, history repository. Admins get "Register a space". |
| `/spaces/[alias]/assets` | Tabs or sections by asset type in console order (Instructions, Skills, Memory stores, Memories, Custom agents, Artifacts). Table: name, status switch, `VersionBadge`, last change (`SourceBadge` plus `Time`). Memories use the existing `PathTree` for folder names. |
| `/spaces/[alias]/history` | Full-page `ChangeFeed` with the filter toolbar and "Show older changes". |
| `/spaces/[alias]/journals`, `/analysis` | Keep the current flows; move them into the shell, `PageHeader`, filter toolbar, `Table`, `EmptyState` and `JobProgress`. |
| `/spaces/[alias]/plans` | See [pages/plans.md](pages/plans.md). "New plan" lives on the drafts screen, not here. |
| `/spaces/[alias]/releases` | See [pages/releases.md](pages/releases.md): the list, the Create release dialog, release detail with changes since, and the rollback preview. |
| Asset editor and drafts | See [pages/draft-editor.md](pages/draft-editor.md) and [pages/drafts.md](pages/drafts.md). |
| Package import | See [pages/package-import.md](pages/package-import.md), which also covers the package export dialog. |
| `/spaces/[alias]/audits` | See [pages/audits.md](pages/audits.md), [pages/audit-new.md](pages/audit-new.md), [pages/audit-detail.md](pages/audit-detail.md) (Investigations and Findings tabs), [pages/audit-item.md](pages/audit-item.md) and [pages/audit-report.md](pages/audit-report.md). |
| `/spaces/[alias]/revisions` | See [pages/revisions.md](pages/revisions.md) and [pages/revision-detail.md](pages/revision-detail.md). |
| Release verification | A tab on the release page; see [pages/release-verification.md](pages/release-verification.md). |
| `/audit-log` | Filter toolbar plus a `Table`: `Time`, actor, action (readable name such as "Settings changed", with the code in mono below), target, result badge. An accepted request (`sync.request`, `*.requested`, `plan.recheck`) reads "Requested", not "Succeeded". |
| Settings pages | Forms with labels above fields, help text under them, inline errors, one Save button per section, and a toast on save. |

Routes without a page file follow the pattern in this table. The page files cover the screens of phases 2 to 4. These decisions apply to them, and where they differ from a page file, they win:

- **Incident review:** the split view (evidence on the left, every finding card on the right), with the keyboard shortcuts (A, E, R, J, K, O) on the focused finding card, scoped to the review area and switchable off. The one-finding-at-a-time layout is not built.
- **Revision detail:** the editor layout, with the change list as its "Saves" tab. The edit sheet is not built.
- **Finalize:** every finding of the current reviews needs a decision (accepted or rejected) before an audit can be finalized. "Finalize with a warning" is not built; the finalize dialog lists what is still undecided instead.
- **Models:** no model ID is set in code or in the shipped policy. The space default is set in Space settings ("Model review"), and New audit lets the audit choose its own, defaulting to the space default.

## Decisions not taken

- **A generated indigo palette.** Color stays reserved for status and source. Indigo would also clash with the DevOps Agent chip.
- **Outfit and Work Sans (Google Fonts).** Builds must work offline.
- **GSAP page transitions.** Not needed at this motion level, and it would add a dependency.
- **44 px touch targets.** That is a native mobile rule. For web it points to WCAG's 24 px, which this spec uses.

## Open items

- **Version attribution note.** A memory version can be labeled Console even though its content change has no API call: the console's status switch overwrote the timestamp of the agent's earlier content change. The attribution module needs to decide how to detect it, because `ListAssetVersions` gives every version the asset's own `createdAt`. Until that is decided, don't show a note for this case.
- Each page file lists its own open items.
