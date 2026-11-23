# Troubleshooting

Each entry starts with what you see. Commands that start with `./scripts/stack.sh` are for the container stack. Commands that start with `pnpm` are for the native run described in [Development](development.md).

Contents: [Containers](#containers), [Database](#database), [Ports and startup](#ports-and-startup), [AWS access](#aws-access), [Policy](#policy), [Sync and the space connection](#sync-and-the-space-connection), [Jobs that never finish](#jobs-that-never-finish), [Audits](#audits).

## Containers

### "Cannot connect to Podman"

The full message is `Cannot connect to Podman. Please verify your connection to the Linux system using podman system connection list, or try podman machine init and podman machine start`. On macOS and Windows, Podman runs containers in a virtual machine, and that machine is stopped.

1. Run `podman machine list`. The `LAST UP` column says whether it runs.
2. Run `podman machine start`. See [`podman machine start`](https://docs.podman.io/en/latest/markdown/podman-machine-start.1.html).
3. Run `podman ps` to check the connection, then repeat your command.

If `podman machine list` shows no machine, run `podman machine init` first.

### `podman compose` reports no compose provider

`podman compose` is a thin wrapper that runs [another tool](https://docs.podman.io/en/latest/markdown/podman-compose.1.html), `docker-compose` or `podman-compose`. Install one of them. `./scripts/stack.sh` and `pnpm db:dev:up` both use it.

### The image build stops with "Killed" or exit code 137, or `up` says the engine has too little memory

The build step `next build` needs about 3.5 GiB. A new Podman machine has 2 GiB, and the kernel kills the build when memory runs out. `./scripts/stack.sh` reads the engine's memory before it builds and stops with the fix. The fix depends on the engine:

1. Podman on macOS: run `podman machine stop`, then `podman machine set --memory 4096` ([`podman machine set`](https://docs.podman.io/en/latest/markdown/podman-machine-set.1.html), in MiB), then `podman machine start`.
2. Docker Desktop: raise the memory limit under Settings, then Resources.
3. WSL 2: set `memory=6GB` under `[wsl2]` in `%UserProfile%\.wslconfig`, run `wsl --shutdown` in PowerShell and open the Linux shell again. See [Microsoft's description of `.wslconfig`](https://learn.microsoft.com/windows/wsl/wsl-config#configure-global-options-with-wslconfig).

Then run `up` or `demo` again. `DAM_SKIP_MEMORY_CHECK=1` skips the check, for an engine that reports its memory in a way the script misreads. A published image (`DAM_IMAGE`) needs no build and no check.

### The containers run, but the app cannot use my AWS profile

With the AWS CLI installed, `up` passes renewing credentials to the containers, and every profile type works. See [AWS credentials in containers](getting-started.md#aws-credentials-in-containers). Without the AWS CLI (or older than 2.9.6), `up` falls back to mounting `~/.aws` read-only. A profile that signs in through IAM Identity Center (SSO) then needs a token cache that a read-only mount cannot refresh, and a profile with `credential_process` runs a program the container does not have. Install the AWS CLI and run `up` again. The app's message when this happens is "This app has no AWS credentials for this space, so it can't reach AWS", or "The space's AWS credentials had expired".

## Database

### `DATABASE_URL or DATABASE_URL_FILE must be set`

The process found no database URL. For a native run, put it in `.env`:

```sh
printf 'DATABASE_URL=%s\n' "$(scripts/dev-db-url.sh dam)" >> .env
```

`scripts/dev-db-url.sh` reads the password from `.env`. In a git worktree, `.env` is not present, so pass `DAM_ENV_FILE=<path to your main .env>`.

### `ECONNREFUSED 127.0.0.1:55432`

The development Postgres is not running. Run `pnpm db:dev:up`. If the Podman machine is stopped, start it first (above). Check with `podman ps`.

### `password authentication failed for user "dam"`

The password in `.env` is not the one the database was created with. The Postgres image applies `POSTGRES_PASSWORD` [only when its data folder is empty](https://hub.docker.com/_/postgres), so changing `.env` later does not change the password inside an existing volume.

1. Put the original password back in `.env`, if you still have it. This is the safe fix.
2. Or discard the database. This **deletes every database in that volume**. Run `pnpm db:dev:down`, then `podman volume rm dam-dev_dam-dev-pg`, then `pnpm db:dev:up`, `createdb` for each database you need, and `pnpm db:migrate`.

The container stack keeps its own volumes. `./scripts/stack.sh down --volumes` removes them. See [Getting started](getting-started.md).

### `database "dam_demo" does not exist`

Create it, then migrate it:

```sh
podman compose -f compose.dev.yaml exec postgres createdb -U dam dam_demo
DATABASE_URL="$(scripts/dev-db-url.sh dam_demo)" pnpm db:migrate
```

### `relation "..." does not exist`

The database has no tables, or an old schema. Run `pnpm db:migrate` against it.

### `Refusing to reset database`

`pnpm demo:seed` empties the database it is pointed at, so it only runs on a database whose name starts with `dam_` and is not `dam`. Create a separate database for the demo (above).

## Ports and startup

### `EADDRINUSE`, or "address already in use"

Another program uses the port. Find it, or pick another port.

1. `lsof -nP -iTCP:3000 -sTCP:LISTEN` shows the process.
2. Stop it, or start the app on another port: `PORT=3100 pnpm dev`. For the container stack, `DAM_PORT=3100 ./scripts/stack.sh up`, and `DAM_DEMO_PORT` for the demo.

### `AUTH_DEV_BYPASS is on but DAM_HOST is ...`

The server refuses to run the dev sign-in bypass on an address that other machines could reach. Set `DAM_HOST=127.0.0.1` (the default). See [Security](security.md#sign-in).

### Every page redirects to the sign-in page, or "Sign-in is not configured"

No identity provider is configured and the bypass is off, so the app rejects every request. For local use, set `AUTH_DEV_BYPASS=true` with `DAM_HOST=127.0.0.1`. For shared use, configure OIDC. See [Configuration](configuration.md#sign-in).

### Every page answers "Internal Server Error"

Look at the server log. If it shows `PolicyError`, see [Policy](#policy).

## AWS access

### `status` shows a last error, or the app says the space's AWS credentials expired

The refresher could not renew the credentials, so the containers kept the old ones until they expired. `./scripts/stack.sh status` prints the AWS CLI's message under `last error`. The usual cause is that your AWS sign-in ended (`Token has expired and refresh failed`, or an expired session for another profile type).

1. Run `./scripts/stack.sh login`. It signs in again, writes new credentials into the containers at once, and starts the refresher if it stopped.
2. If `login` says no sign-in command applies, the profile is not an IAM Identity Center profile. Sign in with your own tool (for an Okta tool, run it) and run `login` again, or set `DAM_AWS_LOGIN_COMMAND` so that `login` runs the tool. See [Okta](getting-started.md#okta).
3. Read the refresher's log in `.dam/aws-bridge.log` if `status` says the refresher is not running.

### "The AWS CLI has no usable credentials" when you run `up`

`up` asks the AWS CLI for credentials before it starts anything. The message after the colon is the CLI's own. If the profile uses IAM Identity Center, `up` runs `aws sso login` for you. If you run under WSL and no browser opens, the CLI prints a URL and a code: open the URL in a browser on Windows. For other profile types, sign in the way you normally do and run `up` again. [How the AWS CLI signs in to IAM Identity Center](https://docs.aws.amazon.com/cli/latest/userguide/sso-using-profile.html) lists the options.

### `up` says the AWS CLI is not installed or too old

Automatic credentials need AWS CLI 2.9.6 or later, because [`aws configure export-credentials`](https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html) came with it. `up` falls back to mounting `~/.aws`, which does not work for IAM Identity Center or `credential_process` profiles. [Install or update the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), then run `up` again.

### "AWS refused the request: the space's read role isn't allowed to ..."

The identity the app uses for the space lacks a permission. The message says what it tried to do, and its Details line names the IAM action. Compare it with the policies in [AWS setup](aws-setup.md).

### AssumeRole is denied

When a space uses roles, the trust policy of each role must name the account and identity that runs the app, require the space's external ID, and allow `sts:SetSourceIdentity`, because the app passes the signed-in person's email as the [source identity](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html). Registration also fails if a role can be assumed without the external ID. See [AWS setup](aws-setup.md).

## Policy

### The web server answers 500, or the worker prints `[worker] fatal PolicyError`

A policy file failed its schema, and the app refuses to run with part of a policy. The log lists each problem with its section, file and key:

```
PolicyError: Policy rejected: 2 problem(s)
  issues: [
    { section: 'sync', file: 'sync.yaml', detail: 'intervalMinutes: Invalid input: expected number, received string' },
    ...
```

1. Open the file the log names and fix the key.
2. Check which layers you have set: `DAM_POLICY_DIR`, `DAM_POLICY_OVERLAY_DIRS`, and `policy/` in the history repository. The log line `[policy] DAM_POLICY_OVERLAY_DIRS lists ..., which does not exist` means a path is wrong. In the container stack the overlay is the folder you gave to `up --policy <folder>`; `.env` keeps it as `DAM_POLICY_OVERLAY_HOST_DIR`.
3. Restart the web server and the worker.

See [Policy](policy.md#when-policy-has-an-error).

## Sync and the space connection

### The home page says "Can't reach this space", "Last sync failed" or "Connection failed"

1. Read the message. It names the step that failed, such as the profile, a role or a call, and has a Details line.
2. As an Admin, open Space settings and select "Test connection". It calls the Agent Space, lists the asset types and lists one asset, through the read access.
3. Fix what the test names:

| Message | Cause |
|---|---|
| No AWS credentials | The profile named on the space does not exist where the app runs. In a container, see above |
| Credentials expired | Sign in again, then run the test again. In the container stack, run `./scripts/stack.sh login`. In a native run, run `aws sso login` or your Okta tool |
| Access denied | The read role or profile lacks a permission. See [AWS setup](aws-setup.md) |
| Network | The machine cannot reach the AWS endpoint for the space's Region |

4. Select "Sync now". While the connection is down, the history stops recording changes. It catches up on the next sync, and the daily reconcile finds anything that was deleted meanwhile.

### Many changes show the source "Unknown"

The app finds the source from CloudTrail. Check that the read role may call [`LookupEvents`](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html). CloudTrail keeps 90 days of events, so older changes stay Unknown, and an event can take a few minutes to arrive. The home page flags only unknown changes inside the lookup window.

### A sync, release or saved audit record fails in a git hook

The worker commits to the history repository with `git commit`, so your `pre-commit` and `commit-msg` hooks run on its commits: the repository's own hooks, and those that `core.hooksPath` sets in the git configuration of the user who runs the worker. A hook that rejects a commit fails the job. For example, a secret scanner can flag a key-like string in an asset.

1. Read the hook's message in the worker's log, on a line that ends the job with `failed:`. In a native run it is the terminal that runs `pnpm dev:worker`.
2. Fix the cause, or change the hook's rule or allowlist if the match is not a secret. Leave the hook on: it is the same check as for any other commit on the computer.
3. Run the job again, for example with "Sync now".

Git runs the hooks with only `PATH`, `HOME` and the `GIT_*` variables the worker sets, so a hook that needs another environment variable fails. The container image has no global git configuration, so hooks set on your computer do not run in the container stack.

## Jobs that never finish

### "Waiting for the background worker"

Syncs, exports, imports, applies and audits run in the worker. If a job stays queued for more than 20 seconds, the worker is not running.

1. Native run: start it with `pnpm dev:worker` in a second terminal.
2. Container stack: run `./scripts/stack.sh status` and `./scripts/stack.sh logs worker`.
3. If the worker exits at once, read its last lines. A policy error and a bad `DATABASE_URL` are the usual causes.

## Audits

### "The space's read role isn't allowed to call the review model in Amazon Bedrock"

The audit reaches Amazon Bedrock through the space's read role, in the space's Region unless Space settings sets another. The role needs:

- `bedrock:InvokeModel` on the chosen model or inference profile. For an inference profile, also on the models in each Region it routes to. The app does not stream, so `bedrock:InvokeModelWithResponseStream` is not needed.
- `bedrock:ListInferenceProfiles` and `bedrock:ListFoundationModels` to fill the model list in Space settings and on "New audit". Without them, type the model ID.

The action names are in the [Amazon Bedrock authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock.html). After the policy changes, rerun the review from the audit page. See [AWS setup](aws-setup.md).

### "Choose a review model for this audit"

No model is built in. Pick one on "New audit", or ask an Admin to set a default in Space settings, under model review.

### A review stops at the step limit, or the answer does not match the schema

These are limits of the profile in [`policy/audits.yaml`](../policy/audits.yaml): `stepLimit`, `timeoutSeconds` and `outputSchema`. Rerun the review first. If it keeps happening, try a more capable model, or raise `stepLimit` in an overlay. See [Policy](policy.md#audit-profiles-and-prompts).

### "AWS refused the request: the space's write role isn't allowed to run a DevOps Agent chat"

A review with the reviewer **DevOps Agent chat** starts a chat in the space and sends it a message. The identity the worker uses for writes needs `aidevops:CreateChat` and `aidevops:SendMessage` on the Agent Space, and `aidevops:CreateAsset` and `aidevops:DeleteAsset` for the two temporary attachments. Add [`chat-review-policy.json`](iam/chat-review-policy.json) to the write role, or deploy the CloudFormation template with `AllowChatReviews=true`, and rerun the review. See [DevOps Agent chat reviews](aws-setup.md#devops-agent-chat-reviews).

### "The review files are ... together" or "The review message is ... characters"

The chat takes one message of at most 32,768 characters and, in testing, read attached files up to about 1.8 MB. The review stops before any call when the files are larger than `review.chat.attachmentBytesCap` (1.5 MB by default). The error names the settings to lower: `review.files.recordCharsCap` cuts long records, and `review.traceCharsInPrompt` and `review.groundTruthCharsInPrompt` shorten the brief. A message that is too long comes from the reviewer system prompt, the output schema or the chat template, which are policy files. Change these in an overlay. See [Policy](policy.md#audit-profiles-and-prompts).

### "The chat returned an empty answer"

The files were probably too large for the chat to read. A chat answered nothing for 2.6 MB of attachments in testing. Lower `review.files.recordCharsCap` as above and rerun the review.

### "The chat asked for an approval or an interrupt"

The chat wanted to run something that needs a person's approval. A review only reads two files, so it should need none. Possible causes are the space's own instructions, which the chat loads, or text in the journal that the chat followed. The app approves nothing and fails the review. Check what the space's instructions tell a chat to do, or run the audit in a separate reviewer space. See [Security](security.md#untrusted-content).

### Attachments named `dam-review-...` stay in the space

The worker deletes them when a review ends. If the worker was stopped in the middle or a delete failed, the files stay. The worker log names each file it could not delete. Delete them in the DevOps Agent console or with `DeleteAsset`. They start with `dam-review-`, and the sync does not record them.

### A review with the DevOps Agent chat times out

The audit profile's `timeoutSeconds` covers the whole review, including both attachments, the chat and the reply. A review took about 2 minutes in testing. Check that the profile's timeout is above that. When the app stops waiting it closes the connection and deletes the attachments. Whether the service then stops the chat's work was not tested, so check the space's usage if reviews time out often.
