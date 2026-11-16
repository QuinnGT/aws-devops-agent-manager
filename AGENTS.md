<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# DevOps Agent Manager: conventions for every contributor

DevOps Agent Manager manages an AWS DevOps Agent Space from outside the Operator Web App: assets with a full git history, plans and releases, journal export and analysis, audits, revisions and release verification. Each server module in `src/server/<module>/` has a README that says what it does; read it, and the page file in `design-system/devops-agent-manager/pages/` for a screen, before changing either.

## Stack (pinned, see package.json)

Next.js 16.4 App Router + React 19.3, TypeScript strict (`noUncheckedIndexedAccess` on), Postgres + Drizzle 0.45, pg-boss 12, Better Auth 1.7, AWS SDK v3 `@aws-sdk/client-devops-agent` 3.1166, simple-git 4, Zod 4, shadcn/ui (radix-nova) + Tailwind 4, Vitest 5. pnpm. Local containers run on Podman (`pnpm db:dev:up` uses `podman compose`).

Say why in the pull request when you add a dependency. Edit `package.json`, run `pnpm install`, and pin exact versions.

## Commands

- `pnpm typecheck` (runs `next typegen` first), `pnpm lint`, `pnpm test` (unit), `pnpm test:int` (integration, needs `TEST_DATABASE_URL`), `pnpm build`.
- All four of typecheck, lint, unit tests and build must pass before you finish.
- `CONTRIBUTING.md` describes the contribution process. CI (`.github/workflows/ci.yml`) runs the same four checks, plus the integration tests, `pnpm demo:seed` on a fresh database, a container build and a secret scan.
- `pnpm demo:seed` fills one database with the sample space so you can click through every page without AWS (see `README.md`).

## Rendering

`cacheComponents` is off: every page reads the signed-in user and live data. Pages are server components that call the DAL; `getCurrentUser()` calls `connection()` so they are always rendered per request. Use Server Actions for mutations and Route Handlers for downloads and polling.

Keep Server Actions and Route Handlers thin: check auth with the DAL, parse input with Zod, then call a service function in `src/server/<module>/` that takes the actor (`{ email }`) as a parameter. Test the service functions; the DAL needs a Next.js request and can't run in Vitest.

## Security rules (non-negotiable)

- **Every** Server Action, Route Handler and data-reading page calls the DAL (`src/server/auth/dal.ts`): `requirePermission(permission, spaceId)` for actions and handlers, `requireUserOrRedirect()` plus `can(...)` for pages. Permissions are listed in `src/server/policy/sections/roles.ts`; a new permission goes there and in `policy/roles.yaml`, and the pull request says so.
- Never trust IDs from the client to imply access: look up the space, then check permission for that space ID.
- Content from an Agent Space, a journal or a model is untrusted. Render markdown only with `src/components/safe-markdown.tsx`. Never use `dangerouslySetInnerHTML`.
- Journal text, ground-truth documents and model output are untrusted input to a model call as well. A review's tools read only that investigation's records, and nothing a model returns is executed, fetched or used as a path.
- No server listens on anything but `127.0.0.1` outside a container. Use `DAM_HOST`, never `HOSTNAME` (some shells set `HOSTNAME` to a machine ID).
- No credentials in code, fixtures, logs or commits. AWS access only through `src/server/aws/clients.ts` (`devOpsAgentClient(space, "read" | "write", actor)`). Write mode works only in the worker (`DAM_PROCESS=worker`).
- Tests make no live AWS or Bedrock calls. Use `aws-sdk-client-mock` and the captured responses in `test/fixtures/api/test-space/` (read-only responses from a test Agent Space, with the Agent Space ID, account IDs and principals masked), and the AI SDK's mock models (`ai/test`).
- Tests never push or call GitHub. History repositories in tests are local directories under `DAM_DATA_DIR`.
- Zip input: reject absolute paths, `..` segments and symlinks.
- Model calls go through `bedrockModel` in `src/server/ai/bedrock.ts` only. The model ID is never set in code or in the shipped policy: it comes from the audit, the space setting or the profile (see `src/server/ai/models.ts`).
- Every user action that changes something calls `recordAuditEvent`, and every finding, report and revision change records who did it.

## Cross-module contracts

- `src/lib/journal/types.ts`: `JournalBundle`, `StoredTask`, `StoredExecution`, `StoredRecord`, `RecordContent`, `parseRecordContent`.
- `src/lib/assets/types.ts`: `AssetSnapshot`, `AssetJson` (asset.json in the history repo), `TRAILERS`, `ChangeSource`, `FeedItem`.
- `src/server/history/layout.ts`: where each asset lives in the history repo (`assetDir`, `assetJsonPath`).
- `src/server/journals/markdown-import/index.ts`: `parseJournalMarkdown`.
- `src/server/attribution/index.ts`: `attributeChanges`.
- `src/server/spaces/queries.ts`: `getSpaceByAlias`, `getSpaceById`, `listSpaces`, `toAwsConfig`, `getHistoryRepoForSpace`, `toHistoryRepoConfig`.
- `src/server/spaces/settings-schema.ts`: per-space settings.
- `src/server/plans/contract.ts`: `createPlan(input, actor)` (implemented in `src/server/plans/index.ts`; releases and package import call it for rollbacks and imports), `PlanOrigin`, `RollbackTarget`, `PlanItemInput`, `applyPermissionFor`. Every write to a space goes through a plan.
- `src/server/history/content-hash.ts`: `assetContentHash(files)` and `metadataHash(metadata)`, used by plan verification and release manifests.
- `src/server/packages/types.ts`: `DesiredAsset` is the shape of every planned asset.
- `src/server/audits/contract.ts`: the shapes shared by audits, reviews and reports (`RunReview`, `ExtractFindings`, `CitationCheck`, `FindingInput`, `LinkableFinding`, `ReportDraft`).
- Jobs: `defineJob` in `src/server/jobs/registry.ts`, list them in your module's `jobs.ts`; enqueue with `enqueue(job, input, { actor, spaceId })`. Handlers are plain functions; unit-test them with `testJobContext()`.
- Git: `HistoryRepo` in `src/server/git/history-repo.ts`. Writes only in the worker.
- Audit log: `recordAuditEvent` for every user-initiated change, export and import.
- Policy: `getAppPolicy()` / `getPolicyForRepo(workingDir)`. Never hardcode a rule, limit, layout, mapping, label or prompt that belongs in policy.
- Database: a new table goes in its module's file under `src/server/db/schema/`, registered with one line in `src/server/db/schema/index.ts`. Generate migrations with `pnpm db:generate` and commit them. For a throwaway test database, `DATABASE_URL="$TEST_DATABASE_URL" pnpm db:push` pushes the schema without migration files.
- A new module also registers its policy section in `src/server/policy/sections/index.ts` and its job handlers in `src/worker/handlers.ts` (one line each).

Do not change a contract's exported signature. You may add optional fields or new exports.

The AI SDK and the Bedrock provider ship their docs in `node_modules/ai/docs/` and `node_modules/@ai-sdk/amazon-bedrock/docs/`. Read them before changing a model call; the API differs from older versions.

## Policy, sample data and tests

- Policy lives in `policy/` (YAML, JSON and markdown). A history repository's own `policy/` is merged over it. `DAM_POLICY_OVERLAY_DIRS` adds more overlay folders: zero or more folders separated by `:`, merged over `policy/` before a history repository's own `policy/`. The test setup clears it so a shell setting cannot change the suites; set `DAM_TEST_POLICY_OVERLAY_DIRS` to run them with an overlay on purpose.
- Tests sit next to the code they test (`*.test.ts` for unit tests, `*.int.test.ts` for integration tests).
- `sample-data/` is the dataset for tests and for `pnpm demo:seed`: a fictional company (AnyCompany Tickets), two instruction package versions, benchmark and live-run journals, and reference audit reviews. Everything in it is invented. Its `README.md` says what each folder holds and which tests use it.
- `test/private/` is git-ignored. Put tests there when they need data you cannot publish, such as a real customer package. They run with the other tests when the folder exists.

## Local services

- Dev Postgres (Podman, `compose.dev.yaml`) listens on `127.0.0.1:55432`. `pnpm db:dev:up` starts it; the password is `DAM_DEV_POSTGRES_PASSWORD` in `.env`.
- Create a database for your work, for example `podman compose -f compose.dev.yaml exec postgres createdb -U dam dam_test`, then `export TEST_DATABASE_URL="$(scripts/dev-db-url.sh dam_test)"`. In a git worktree, pass `DAM_ENV_FILE=<main checkout>/.env` to the script, because `.env` is not committed.
- To run the app for a manual check, build and use the bounded smoke script (`DATABASE_URL=... node scripts/smoke.mjs <port>`) or start `next dev` with `DAM_HOST=127.0.0.1`. Stop any server you start before you finish.

## Style

- Plain, specific UI text. No em dashes in UI copy or docs.
- Inclusive language: allowlist/denylist, primary/replica.
- Keep functions small and pure where possible; put API and DB access at the edges so logic is unit-testable.

## UI design

- Follow `design-system/devops-agent-manager/MASTER.md`, then the page file for your route in `design-system/devops-agent-manager/pages/`. A page file wins over MASTER for its screen; this file wins over both. MASTER's "Page index" lists the routes without a page file and the decisions that apply to the audit, revision and verification pages.
- There are no mockup files in the repository. The page file and MASTER's "Verification" checks are the bar for a finished screen.
- Use the shared components in `src/components/common/` and `src/components/app-shell/`. Don't create local variants. To extend a shared component, add optional props only. A component used by one route lives in that route's `_components/` folder until a second route needs it.
- Status words for a module's states go in that module's components folder (for example `src/components/audits/words.ts`), in the style of `src/components/plans/words.ts`. Labels come from MASTER and the page file.
- UI work is done when the MASTER "Verification" checks pass, in addition to the four commands above.
