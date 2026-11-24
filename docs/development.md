# Development

This page is for changing the code or running the app natively. To only try the app, use the demo in [Getting started](getting-started.md).

Conventions that apply to every change (security rules, module contracts, style) are in [`AGENTS.md`](../AGENTS.md). Contribution steps are in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Requirements

- Node.js 22.12 or newer, and pnpm 10 (`corepack enable` picks the version in `package.json`)
- Git
- Podman with a running machine, for the development database (Docker with the compose plugin also works if you change the commands, but the scripts call `podman compose`)

## Run the app natively

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create `.env` with a password for the development database. The file is git-ignored.

   ```sh
   umask 077; printf 'DAM_DEV_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
   ```

3. Start Postgres. It listens on `127.0.0.1:55432` only. If the Podman machine is stopped, run `podman machine start` first.

   ```sh
   pnpm db:dev:up
   ```

4. Put the connection URL in `.env`, so the app, the worker and `pnpm db:migrate` all read it. Write the password literally: the worker's `.env` loader does not expand `${VAR}` references.

   ```sh
   printf 'DATABASE_URL=%s\n' "$(scripts/dev-db-url.sh dam)" >> .env
   ```

5. Create the tables:

   ```sh
   pnpm db:migrate
   ```

6. Start the web app with the dev sign-in bypass. It signs you in as one local user, an Admin unless you set `AUTH_DEV_ROLE`.

   ```sh
   AUTH_DEV_BYPASS=true pnpm dev
   ```

   Open <http://127.0.0.1:3000>. The server refuses to start with the bypass unless it binds a loopback address.

7. In a second terminal, start the worker. Syncs, exports, imports, plan applies and audits run there.

   ```sh
   pnpm dev:worker
   ```

8. Register your Agent Space in the app ("Register a space"). It needs an AWS profile that can reach the space. See [AWS setup](aws-setup.md).

Stop Postgres with `pnpm db:dev:down`. The data stays in a Podman volume. Every setting is listed in [Configuration](configuration.md).

### Work in a git worktree

`.env` is not committed, so a new worktree has none. Pass the main checkout's file to the helper script:

```sh
DAM_ENV_FILE=/path/to/main/checkout/.env scripts/dev-db-url.sh dam_test
```

## Try the sample data natively

`pnpm demo:seed` fills one database with the sample space, built from [`sample-data/`](../sample-data/README.md). Nothing calls AWS or Amazon Bedrock.

1. Create a database whose name starts with `dam_`:

   ```sh
   podman compose -f compose.dev.yaml exec postgres createdb -U dam dam_demo
   ```

2. Migrate it and seed it. The seed also needs a folder for the demo history repository.

   ```sh
   export DATABASE_URL="$(scripts/dev-db-url.sh dam_demo)" DAM_DATA_DIR="$PWD/data/demo"
   pnpm db:migrate
   pnpm demo:seed
   ```

   It takes about a minute and prints every page path it filled.

3. Run the app on the same database and folder, as the space owner:

   ```sh
   AUTH_DEV_BYPASS=true AUTH_DEV_USER_EMAIL=alex@example.com AUTH_DEV_USER_NAME="Alex Rivera" pnpm dev
   ```

The seed empties the database it points at and its history repository under `DAM_DATA_DIR`. It refuses a database whose name does not start with `dam_`, and it refuses `dam`. Run it again to start over. The space names an AWS profile that does not exist, so "Sync now" and "Test connection" fail in the demo, which is expected.

## The four checks

Run these before you open a pull request. CI runs the same commands.

```sh
pnpm typecheck    # runs "next typegen", then tsc
pnpm lint
pnpm test
pnpm build
```

## Tests

| Command | Runs | Needs |
|---|---|---|
| `pnpm test` | Unit tests, `*.test.ts` | Nothing. No database, network or AWS |
| `pnpm test:int` | Integration tests, `*.int.test.ts` | `TEST_DATABASE_URL` |
| `pnpm test:all` | Both | `TEST_DATABASE_URL` |

Tests sit next to the code they test.

To run the integration tests, create a database you do not mind losing, migrate it, and pass its URL. The tests write to it freely and may empty its tables.

```sh
podman compose -f compose.dev.yaml exec postgres createdb -U dam dam_test
export TEST_DATABASE_URL="$(scripts/dev-db-url.sh dam_test)"
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
pnpm test:int
```

Rules for tests:

- No live AWS or Bedrock calls. Use `aws-sdk-client-mock`, the AI SDK's mock models (`ai/test`), and the captured read-only responses in `test/fixtures/api/test-space/`, where the Agent Space ID, account IDs and principals are masked.
- No pushes and no GitHub calls. History repositories in tests are local folders under `DAM_DATA_DIR`.
- Put the data a test needs in `sample-data/` when it is invented, or in `test/private/` when it is not yours to publish.
- Tests commit to real git repositories under `DAM_DATA_DIR` with your `HOME`, so a global `core.hooksPath` hook, such as a secret scanner, runs on those commits too. `pnpm demo:seed` uses a `HOME` of its own and runs no global hooks.

### The sample dataset

`sample-data/` holds the fictional company AnyCompany Tickets: two versions of its instruction package, benchmark and live-run journals, reference audit reviews, the expected numbers, and a policy overlay. Its [`README.md`](../sample-data/README.md) says what each folder holds and which tests use it. `pnpm demo:seed` builds the demo from the same files.

After you edit a sample package, check the generated files in it: the memory indexes, the shared section copies and `reference/VALIDATION.json`. `src/server/packages/sample-data.test.ts` fails when one no longer matches what the package build produces. Regenerate it with `buildRelease` (`src/server/packages/build.ts`) and commit the result.

### Private test data

`test/private/` is git-ignored. Copy or link tests and data there when they need files you cannot publish, such as a real package. Files named `*.test.ts` and `*.int.test.ts` in that folder run with the others, and are never committed.

To run the benchmark suites on another dataset with the layout of `sample-data/`, set these variables. The suites then skip the assertions on the sample's exact numbers and check what they can derive from your data.

| Variable | Points at |
|---|---|
| `DAM_BENCHMARK_JOURNALS_DIR` | A folder with one subfolder per incident, laid out like `sample-data/journals/benchmark` |
| `DAM_BENCHMARK_AUDIT_DIR` | A reference audit laid out like `sample-data/audit` (`reviews/`, `metrics.json`, `memory_usage.json`) |
| `DAM_LIVE_RUNS_DIR` | A folder of journals in the record-created format, like `sample-data/journals/live-runs` |
| `DAM_TEST_POLICY_OVERLAY_DIRS` | Policy overlay folders to run the suites with. The suites otherwise clear `DAM_POLICY_OVERLAY_DIRS`, so a setting in your shell cannot change a result |

`scripts/compare-reviews.ts <audit-id>` compares an audit's model reviews with reference reviews and prints the difference. It reads the database and makes no model calls. Pass `--reference-dir <dir>` or set `DAM_REFERENCE_REVIEWS_DIR` for a set other than the sample.

## Database changes

A new table goes in its module's file under `src/server/db/schema/` and is registered with one line in `src/server/db/schema/index.ts`. Generate the migration with `pnpm db:generate` and commit it. For a throwaway database, `DATABASE_URL="$TEST_DATABASE_URL" pnpm db:push` pushes the schema without migration files.

## The design spec

The UI follows [`design-system/devops-agent-manager/MASTER.md`](../design-system/devops-agent-manager/MASTER.md), then the page file for the route in [`design-system/devops-agent-manager/pages/`](../design-system/devops-agent-manager/pages/). A page file wins over MASTER for its screen. MASTER says how to use colors, shared components, copy and the word list, and ends with the checks a finished screen must pass, including the contrast test in `src/app/theme.test.ts`. Use the shared components in `src/components/common/` and `src/components/app-shell/`.

Each server module in `src/server/<module>/` has a `README.md` where the module is not obvious from its names.

## Screenshots

`pnpm screenshots` captures the images in `docs/images/` from a running app that holds the sample data. Capture from a production build, because the development server shows an overlay.

1. Seed a database as in "Try the sample data natively".
2. In the same shell as the seed, so `DATABASE_URL` and `DAM_DATA_DIR` are still set, build, then serve the build on the seeded database. Use a loopback address and the bypass as Alex Rivera:

   ```sh
   pnpm build
   DAM_HOST=127.0.0.1 PORT=3921 AUTH_DEV_BYPASS=true AUTH_DEV_USER_EMAIL=alex@example.com \
     AUTH_DEV_USER_NAME="Alex Rivera" pnpm start
   ```

3. In another terminal, run the script with the app's URL. The output folder defaults to `docs/images`.

   ```sh
   pnpm screenshots http://127.0.0.1:3921
   ```

4. Stop the server.

The script drives your installed Google Chrome through `playwright-core`, which downloads no browser. Set `CHROME_PATH` to use another Chrome or Chromium. It finds the pages from the app itself, so it works on any database the seed filled, and `--space <alias>` picks a space other than the first one listed. It writes nine images, all in the dark theme so the docs look the same throughout, and exits with an error when one is over 400 KB. Run it soon after seeding: the sync status line reads "Synced 3 min ago" and turns to a warning once the last sync is old. Look at every image before you commit it.

| Image | Page | Used in |
|---|---|---|
| `space-home` | The space home page | README |
| `audit-flow` | The audit with the most investigations, with its flow strip | README, Concepts |
| `plan-review` | The first open plan | README, Concepts |
| `findings` | The Findings tab, on a finding the revision below lists | README |
| `revision-editor` | The revision with the most findings to address, whose build passed, on a file it edited | README, Concepts |
| `review-files` | An audit reviewed with review files | README |
| `audit-record` | The Report tab of an audit whose record is saved | README |
| `release-verification` | The newest release's Verification tab | README, Concepts |
| `asset-history` | The asset with the most versions, comparing its two newest | README |

## Where things are

| Path | What it holds |
|---|---|
| `src/app/` | Pages, Server Actions and Route Handlers. They are thin: check access, parse input, call a service |
| `src/server/` | One folder per feature (assets, sync, plans, releases, journals, audits, revisions and more), plus auth, AWS, git, jobs and policy |
| `src/worker/` | The job worker, the only process that writes to git or uses a write role |
| `src/components/`, `src/lib/` | Shared UI and code that has no server dependency |
| `policy/` | Default [policy](policy.md) |
| `drizzle/` | Database migrations |
| `scripts/` | Build, seed, smoke and helper scripts |
| `sample-data/` | The invented dataset used by tests and the demo |
| `design-system/` | The UI design spec |
