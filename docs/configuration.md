# Configuration

The app reads a small set of environment variables. Everything else is [policy](policy.md) (files) or a per-space setting in the app (stored in Postgres). The variables are parsed once, in [`src/server/env.ts`](../src/server/env.ts). A bad value, such as `PORT=abc`, stops the process with a message that names it.

How to set them:

- Native run: put them in `.env` at the repository root. `pnpm dev`, `pnpm start`, `pnpm dev:worker`, `pnpm db:migrate` and `pnpm demo:seed` all read `.env` and `.env.local`. Write values literally: the worker's loader does not expand `${VAR}` references.
- Container stack: `./scripts/stack.sh` writes the values the containers need. See [Getting started](getting-started.md).
- Booleans accept `true`, `false`, `1`, `0` or an empty value.

## Database and files

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | Postgres connection URL. Required by the web app, the worker, `pnpm db:migrate` and `pnpm demo:seed` |
| `DATABASE_URL_FILE` | none | Path to a file that holds the URL. Wins over `DATABASE_URL` when both are set |
| `DAM_DATA_DIR` | `./data` | Where the app keeps files: history repositories (`history/<name>`), journal exports and imports (`exports/`, `imports/`) and package uploads (`package-imports/`). The web app and the worker must see the same folder |

## Web server and worker

| Variable | Default | Meaning |
|---|---|---|
| `DAM_HOST` | `127.0.0.1` | Address the web server binds. Use this and not `HOSTNAME`, which some shells set to a machine ID. In a container the entrypoint passes it to Next.js |
| `PORT` | `3000` | Port the web server listens on |
| `DAM_PROCESS` | `web` | `web` or `worker`. The worker sets it to `worker` itself. Writes to git and to an Agent Space (the write role) are refused in any process but the worker |
| `DAM_LOOPBACK_PUBLISH_ONLY` | `false` | Set to `true` only inside a container whose port is published to `127.0.0.1` only. It lets the dev sign-in bypass run while the server binds `0.0.0.0` in the container. `compose.yaml` sets it next to the port mapping. See [Security](security.md) |
| `DAM_ALLOWED_ORIGINS` | none | Comma-separated origins, for example `https://dam.example.com`. Needed when a reverse proxy changes the `Host` header. It is the sign-in library's trusted origins and the list of origins Server Actions accept. With `pnpm start` it is read at start. In the container image, Next.js bakes the Server Actions list into the build, so set it when you build the image as well |

## Policy

| Variable | Default | Meaning |
|---|---|---|
| `DAM_POLICY_DIR` | `./policy` | The default policy folder (the container image sets `/app/policy`) |
| `DAM_POLICY_OVERLAY_DIRS` | empty | Folders merged over `DAM_POLICY_DIR`, separated by `:` (`;` on Windows), later ones winning. A history repository's own `policy/` folder is merged last. A folder that does not exist is skipped, with one warning in the log. See [Policy](policy.md). In the container stack, `compose.yaml` sets it to `/app/policy-overlay`; use `./scripts/stack.sh up --policy <folder>` to fill that folder |

## Sign-in

With no OIDC provider and no bypass, the app rejects every request.

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_DEV_BYPASS` | `false` | Signs in one local user on every request. The server refuses to start with it on unless it binds a loopback address, or `DAM_LOOPBACK_PUBLISH_ONLY` is `true`. The container stack turns it on and passes `AUTH_DEV_USER_EMAIL` and `AUTH_DEV_ROLE` from `.env`. Never use it on a shared host |
| `AUTH_DEV_USER_EMAIL` | `local@localhost` | Email of the bypass user. The demo uses `alex@example.com` |
| `AUTH_DEV_USER_NAME` | `Local user` | Display name of the bypass user |
| `AUTH_DEV_ROLE` | `admin` | Role of the bypass user: `viewer`, `editor`, `publisher` or `admin` |
| `OIDC_ISSUER` | none | Issuer URL of your OIDC provider. The app reads `<issuer>/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` | none | Client ID of the app in the provider |
| `OIDC_CLIENT_SECRET` | none | Client secret. Prefer the `_FILE` form |
| `OIDC_CLIENT_SECRET_FILE` | none | Path to a file that holds the client secret |
| `OIDC_PROVIDER_ID` | `oidc` | Provider ID. The redirect URI to register with your provider is `<BETTER_AUTH_URL>/api/auth/callback/<id>` ([Better Auth docs](https://better-auth.com/docs/plugins/generic-oauth)) |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim in the ID token that lists the user's groups, used to bind groups to roles |
| `BETTER_AUTH_URL` | none | Public base URL of the app, for example `https://dam.example.com` |
| `BETTER_AUTH_SECRET` | none | Secret that signs sessions. Prefer the `_FILE` form |
| `BETTER_AUTH_SECRET_FILE` | none | Path to a file that holds the session secret. With OIDC configured and the bypass off, the server will not start unless this or `BETTER_AUTH_SECRET` is set |

OIDC counts as configured when the issuer, the client ID and the client secret are all set.

## Secrets

Three values have a `*_FILE` form: `DATABASE_URL`, `OIDC_CLIENT_SECRET` and `BETTER_AUTH_SECRET`. When both forms are set, the file wins. The app trims whitespace around the file's content. A file keeps the value out of the process list and out of `podman inspect`. Use a container secret or a file with mode `0600`.

## AWS access

The app has no AWS variables of its own. A space names either an AWS profile, or a read role and a write role to assume (see [AWS setup](aws-setup.md)). With neither, the AWS SDK default credential chain applies, so the [standard AWS environment variables](https://docs.aws.amazon.com/sdkref/latest/guide/environment-variables.html) work, for example `AWS_PROFILE`.

| Variable | Set by | Meaning |
|---|---|---|
| `AWS_PROFILE` | you | The profile to use when the space names none. `./scripts/stack.sh up --profile <name>` uses it as the profile, but leaves it out of the containers unless it mounts `~/.aws` (`--mount-aws-dir`) |
| `AWS_CONFIG_FILE` | `compose.yaml` | The AWS config file in the containers. `/data/.aws-bridge/config` with the credential bridge, `/home/app/.aws/config` otherwise |
| `AWS_SHARED_CREDENTIALS_FILE` | `compose.yaml` | The AWS credentials file in the containers. With the credential bridge it names a file that does not exist, so no stray credentials file is read. Otherwise `/home/app/.aws/credentials` |
| `AWS_SDK_LOAD_CONFIG` | `compose.yaml` | Makes the SDK read the AWS config file as well as the credentials file |
| `AWS_EC2_METADATA_DISABLED` | the test setup, `pnpm demo:seed` and the demo stack | Stops the SDK from calling the instance metadata service, which a laptop does not have |

The container stack never passes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or `AWS_SESSION_TOKEN` to the containers. See [AWS credentials in containers](getting-started.md#aws-credentials-in-containers).

## Container stack

`./scripts/stack.sh` and the compose files read these. [Getting started](getting-started.md) is the reference for them.

| Variable | Default | Meaning |
|---|---|---|
| `DAM_PORT` | `3000` | Host port of the real stack |
| `DAM_DEMO_PORT` | `3001` | Host port of the demo stack |
| `DAM_IMAGE` | `localhost/devops-agent-manager:dev` | Image to run. Set a published image to pull it and skip the local build. When you set it to a `localhost/` name, the script neither pulls nor builds it, so that image must already exist |
| `DAM_CONTAINER_CLI` | Podman if present, else Docker | `podman` or `docker` |
| `DAM_AWS_LOGIN_COMMAND` | none | A command that signs you in to AWS, for example `okta-aws-cli web --profile <name>`. `up` runs it when the AWS CLI has no credentials, and `login` always runs it, instead of `aws sso login`. It runs in a shell on your computer, with `AWS_PROFILE` set to the profile. Set it in the shell or in `.env` |
| `DAM_SKIP_MEMORY_CHECK` | none | Set to `1` to skip the check that the container engine has 3.5 GiB of memory before it builds the image |
| `DAM_POLICY_OVERLAY_HOST_DIR` | none | Host folder that the containers mount read-only at `/app/policy-overlay` as a [policy overlay](policy.md#layers). `up --policy <folder>` writes it to `.env`, and `up --policy none` removes it |
| `DAM_AWS_DIR` | `~/.aws` | Folder mounted read-only into the real stack's containers as `~/.aws`. Used only with `--mount-aws-dir` or when the AWS CLI is not installed. The credential bridge replaces it with an empty folder |
| `DAM_POSTGRES_PASSWORD` | generated into `.env` | Password of the real stack's Postgres |
| `DAM_DEMO_POSTGRES_PASSWORD` | generated into `.env` | Password of the demo stack's Postgres |

## Development and tests

| Variable | Used by | Meaning |
|---|---|---|
| `DAM_DEV_POSTGRES_PASSWORD` | `pnpm db:dev:up`, `scripts/dev-db-url.sh` | Password of the development Postgres in `compose.dev.yaml`. Keep it in `.env` |
| `DAM_ENV_FILE` | `scripts/dev-db-url.sh` | Path of the `.env` that holds `DAM_DEV_POSTGRES_PASSWORD`. Set it in a git worktree, where `.env` is not present |
| `TEST_DATABASE_URL` | `pnpm test:int` | A disposable database that the integration tests may empty. The tests refuse to run without it |
| `TEST_DATA_DIR` | `pnpm test:int` | Data folder for the integration tests. Default `data/test-int` |
| `DAM_TEST_POLICY_OVERLAY_DIRS` | `pnpm test`, `pnpm test:int` | Overlay folders to run the suites with on purpose. The suites clear `DAM_POLICY_OVERLAY_DIRS` so a shell setting cannot change them |
| `DAM_BENCHMARK_JOURNALS_DIR` | tests | Runs the benchmark suites on another journal set with the layout of `sample-data/journals/benchmark` |
| `DAM_BENCHMARK_AUDIT_DIR` | tests | Runs the benchmark suites against another reference audit with the layout of `sample-data/audit` |
| `DAM_LIVE_RUNS_DIR` | tests | Runs the live-run suites on another folder of journals in the record-created format |
| `DAM_REFERENCE_REVIEWS_DIR` | `scripts/compare-reviews.ts` | Reference reviews to compare an audit with. Default `sample-data/audit/reviews` |
| `CHROME_PATH` | `scripts/screenshots.mjs` | Chrome or Chromium binary for the screenshot script. Default: the installed Google Chrome |

Setting `DAM_BENCHMARK_JOURNALS_DIR` or `DAM_BENCHMARK_AUDIT_DIR` turns off the assertions on the sample dataset's exact numbers. The suites then check what they can derive from your data. See [Development](development.md).
