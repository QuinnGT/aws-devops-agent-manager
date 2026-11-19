# Getting started

DevOps Agent Manager runs on your computer, in containers. One script, `scripts/stack.sh`, builds the image and starts everything. This page covers the demo, running against your own Agent Space, and everyday operation.

This is not an official AWS project. It manages an AWS DevOps Agent Space from outside the console.

## Before you start

You need:

1. A container engine. [Podman](https://podman.io/docs/installation) is the default. On macOS and Windows, Podman runs containers in a virtual machine, so also run `podman machine init` once and `podman machine start` after each restart of your computer.
2. A compose provider for Podman. `podman compose` hands the work to [docker-compose or podman-compose](https://docs.podman.io/en/latest/markdown/podman-compose.1.html), so one of them must be installed.
3. `git`, `curl` and `bash`.
4. A few GB of free disk space for the image (about 1 GB) and the build.
5. At least 3.5 GiB of memory for the container engine, if you build the image yourself. See [Memory for the build](#memory-for-the-build).
6. To run against your own Agent Space: the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), version 2.9.6 or later. The demo does not need it.

macOS and Linux are supported. On Windows, use [WSL2](https://learn.microsoft.com/windows/wsl/install) and run everything inside the Linux shell.

Clone the repository and run the commands in this page from its top folder.

### Memory for the build

The first build runs `next build` inside the image build. With less than about 3.5 GiB of memory, the kernel kills it (exit code 137, "Killed"). A new Podman machine has 2 GiB, so raise it before the first build. `./scripts/stack.sh` reads the engine's memory before it builds and stops with the fix when the memory is too small.

| Your engine | How to raise the memory |
|---|---|
| Podman on macOS | `podman machine stop`, then `podman machine set --memory 4096`, then `podman machine start`. The value is in MiB, and [`podman machine set`](https://docs.podman.io/en/latest/markdown/podman-machine-set.1.html) needs a stopped machine |
| Docker Desktop | Open Settings, then Resources, raise the memory limit to 4 GB or more, and apply |
| WSL 2 (Podman or Docker inside it) | In Windows, add `memory=6GB` under `[wsl2]` in `%UserProfile%\.wslconfig`, run `wsl --shutdown` in PowerShell, and open the Linux shell again. [`.wslconfig` is described by Microsoft](https://learn.microsoft.com/windows/wsl/wsl-config#configure-global-options-with-wslconfig). The default is 50% of the memory of the Windows computer |
| Podman or Docker on Linux | The engine uses the memory of the computer. Free some, or add swap |

The check does not run when `DAM_IMAGE` names a published image, because nothing is built. To skip it, set `DAM_SKIP_MEMORY_CHECK=1`.

## Try the demo

The demo shows every page of the app with invented data and needs no AWS account.

```sh
./scripts/stack.sh demo
```

The script:

1. builds the image the first time (several minutes),
2. starts a Postgres database of its own,
3. loads the sample data (a few more minutes the first time),
4. starts the web app and the worker,
5. waits until the app answers and prints the address.

Open `http://127.0.0.1:3001/spaces/anycompany-tickets`. You are signed in as Alex Rivera, the owner of the sample space, with no sign-in screen. The data is a fictional company, AnyCompany Tickets. [`sample-data/README.md`](../sample-data/README.md) says what it contains: two versions of an instruction package, eight audited investigations, releases, plans, audits with reports, and revisions.

What does not work in the demo is everything that calls AWS. A sync, **Test connection** and an audit reviewed by an Amazon Bedrock model all fail with a credentials error, because the sample space has no Agent Space behind it. An audit reviewed with review files calls no AWS API, so you can try it ([Audit without Bedrock](#audit-without-bedrock)). The worker runs, so imports, exports and analysis work. Scheduled syncs are switched off, so the pages keep showing the seeded data however long the demo runs. The reason and the setting are in [`scripts/demo-seed/policy/sync.yaml`](../scripts/demo-seed/policy/sync.yaml).

| To do this | Run |
|---|---|
| Start the demo again. Your changes are kept | `./scripts/stack.sh demo` |
| Start over with fresh sample data | `./scripts/stack.sh demo --reset` |
| Use another port (default 3001) | `DAM_DEMO_PORT=3005 ./scripts/stack.sh demo` |
| Stop it and keep its data | `./scripts/stack.sh down --demo` |
| Stop it and delete its data | `./scripts/stack.sh down --demo --volumes` |
| Read its logs | `./scripts/stack.sh logs --demo` (add `-f` to follow, or a service name such as `worker`) |

## Run it against your Agent Space

You need:

1. An AWS DevOps Agent Space, and its Agent Space ID, Region and AWS account ID.
2. AWS credentials that can read the space (and write to it, if you want to apply plans). [AWS setup](aws-setup.md) lists the permissions and ships the policy documents.
3. The AWS CLI, version 2.9.6 or later, signed in the way you normally sign in to AWS. The script uses it to get credentials for the containers. Read [AWS credentials in containers](#aws-credentials-in-containers) for what it does and for the Okta cases.

Start the app:

```sh
./scripts/stack.sh up --profile <profile-name>
```

`--profile` can be replaced by `AWS_PROFILE=<profile-name>` in front of the command. The first run:

1. checks that the container engine has enough memory to build,
2. gets credentials for the profile from the AWS CLI, and signs you in first if the sign-in has ended (a browser window opens),
3. creates `.env` in the repository folder, with a random database password (`.env` is git-ignored and readable only by you; the script never prints the password),
4. builds the image,
5. starts Postgres, the web app and the worker,
6. passes the credentials to the containers and starts a background process that renews them,
7. waits until the app answers and prints `http://127.0.0.1:3000`.

The port is `DAM_PORT` (default 3000). The app listens on `127.0.0.1` only, so only this computer can reach it. To reach it from another machine, use an SSH port forward. The app signs you in as a local administrator and shows no sign-in screen. That is safe only because of the loopback address, so do not publish the port wider.

Run `up` again at any time, for example after `git pull`. It rebuilds the image, recreates the containers and replaces the background process.

### First steps in the app

1. Open `http://127.0.0.1:3000`. The app has no spaces yet.
2. Register your space. Enter an alias, the Region (for example `us-west-2`), the AWS account ID and the Agent Space ID. Leave the AWS profile field empty, or enter the profile you gave to `up`. Fill in the role ARNs if you use roles, as [AWS setup](aws-setup.md) describes.
3. Under **History repository**, choose **Add a repository** and give it a name. Leave the remote URL empty to keep the history local. Every change to the space is committed to this git repository.
4. Choose **Register and test connection**. The app calls `GetAgentSpace`, `ListAssetTypes` and `ListAssets`. When the test passes, the first sync starts on its own.
5. Watch the sync on the space's home page. When it finishes, **Assets** and **History** show every asset with its full version history.

If the test fails, the space's settings page shows which step failed and the AWS error. Fix the access, then choose **Test connection** there.

### Audit without Bedrock

An audit does not need Amazon Bedrock. Choose the **Review files** reviewer on **New audit**, and the app writes the files and reads the reviews back instead of calling a model.

1. Choose the investigations, add their ground truth, pick **Review files** under **Reviewer** and start the audit. The analyzers run, and each investigation then shows "Waiting for a review file".
2. On the audit's **Investigations** tab, choose **Download all review files**. The zip has one folder for each investigation. Its `README.md` has a prompt for an agent such as the Kiro CLI or Claude Code.
3. Run the folders with an agent your company has approved. The files hold journal text from the Agent Space, so give them only to a tool and model approved for that data. The agent writes `review.json` in each folder.
4. Zip the folders and choose **Import reviews**, or open one investigation and import its `review.json` with its `manifest.json`. Type who or what wrote the reviews, for example "Claude Code, Opus 5.5". The app lists, for each file, whether it was imported or refused and why. When every investigation has a review, the audit moves to "In review" and you accept or reject the findings as usual (see "Review an audit" below).

The sample data has reference reviews in `sample-data/audit/reviews/`. They cite records as `R76`, so convert them to numbers before importing them (the integration test `src/server/audits/handoff.int.test.ts` shows how).

### Review an audit

The strip at the top of an audit shows the steps: Reviews, Decide, Fix in a revision, Report and Record, with what is left at each. Each cell links to its tab or card.

1. Open the **Findings** tab. The list on the left is grouped by incident; the finding you select on the right is shown whole, with its evidence: each cited record, the quoted text and whether the citation check found it. **Accept**, **Edit** and **Reject** are the buttons at the top of the detail. The keys A, E, R, J and K do the same, and **Accept** on an incident's heading accepts the findings that passed the check.
2. Under each finding, **What happens next** says where it goes. A fix for a memory or an instruction is a package fix: **Add to revision…** (or **Accept and add to revision…**) puts it on an open revision's to-address list, or starts a revision with it. The dialog starts on the revision that already holds findings from this audit, and says what each revision is. Accepting a fix does not apply it: a fix in a revision is only queued, and reaches the agent after someone edits the files in the revision, saves, and applies its plan. The finding then links to the revision, its plan and its release, and the banner at the top of the audit names the revisions still waiting and any accepted package fixes that are in none. Any other fix is listed in the report as an action for its owner, and a diagnosis is counted in the report. An Editor can decide findings and build revisions; a Viewer can read them. The "Who can do what" page lists the roles.
3. A citation such as **R12** is record 12 of the investigation's journal. Press it to read the record under its row (press **O** for the first cited one). If a citation failed the check and you read the record and the finding holds, press **I checked the record** and say what you found.
4. On the **Report** tab, build the report, edit the summary and export it if you want to share it.
5. When every finding has a decision, choose **Save the audit record**. The dialog says the repository, branch and folder, which of `audit.json`, `findings.json` and `report.md` are new, and whether the commit is pushed (only when the repository has a remote and pushing is on). Saving changes nothing in the Agent Space. Afterwards the card shows the commit, which you can copy, and whether it was pushed.

### Where the data lives

| What | Where |
|---|---|
| Database | Volume `devops-agent-manager_pg-data` |
| History repositories, exports and uploads | Volume `devops-agent-manager_app-data`, under `/data` in the containers |
| Database password | `.env` in the repository folder |

The demo uses its own volumes, `dam-demo_pg-data` and `dam-demo_app-data`, and its own password in the same `.env`.

A history repository is a normal git repository. To copy one out of the volume, run `podman cp devops-agent-manager-worker-1:/data/history/<repository-name> ./history-copy`. Pushing to a remote needs a deploy key file that the worker can read inside its container. `compose.yaml` does not mount one. Add a volume to the `worker` service if you need it.

## AWS credentials in containers

You run one command, sign in when asked, and the app keeps working for as long as your AWS sign-in lasts. The script renews the credentials in the containers by itself.

```sh
./scripts/stack.sh up --profile <profile-name>
```

What `up` does with the profile:

1. It asks the AWS CLI on your computer for the profile's credentials, with [`aws configure export-credentials`](https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html). The CLI resolves every profile type it supports: access keys, a role assumed from another profile, IAM Identity Center (SSO), `credential_process`, and cached MFA. This needs AWS CLI 2.9.6 or later.
2. If the CLI has no valid sign-in, `up` signs you in and tries once more. For an IAM Identity Center profile it runs `aws sso login --profile <name>`: a browser window opens, or, under WSL, the CLI prints a URL and a code. For any other profile it runs your own command from `DAM_AWS_LOGIN_COMMAND`, if you set one (see [Okta](#okta)). Credentials that come without an expiry time (access keys, or keys an Okta tool wrote) cannot show that they ended, so for those `up` also makes one [`sts:GetCallerIdentity`](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html) call, which needs no permission, and signs you in if AWS refuses them.
3. It passes the credentials to the worker container on its standard input. The worker writes them to `/data/.aws-bridge/credentials.json` in the app-data volume, in the JSON format of the [`credential_process`](https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html) feature. A config file next to it, which holds no secret, points the web app and the worker at that file, so the AWS SDK reads it like any other credential source.
4. It starts a small background process, the refresher. Every minute it checks the credentials in the file. When they expire in less than 20 minutes, it asks the AWS CLI again and rewrites the file. The SDK runs the `credential_process` again before the credentials expire, and so picks up the new file without a restart. If a renewal fails, the refresher keeps the old file, which stays valid until it expires, and tries again a minute later. The refresher keeps running when you close the terminal, until you run `down`.

Credentials that the AWS CLI reports without an expiry time (access keys, or keys that an Okta tool wrote into `~/.aws/credentials`) get one anyway: ten minutes ahead, renewed every minute. The [AWS SDKs treat credentials without an expiry as permanent](https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html#feature-process-credentials-output) and never read the file again, so keys that a tool renewed on your computer would never arrive.

In the app, leave the space's AWS profile field empty, or enter the profile you gave to `up`. Both work.

### Check it, and sign in again

```sh
./scripts/stack.sh status
```

The last block of the output is the bridge:

```
== AWS access
refresher:        running (PID 12046, log .dam/aws-bridge.log)
profile:          my-sso-profile
last renewal:     2026-11-16T19:58:07Z (2 minutes ago)
credentials end:  2026-11-16T20:04:07Z (in 5 minutes)
last error:       none
```

When your AWS sign-in ends, renewals fail. The refresher records the reason and keeps the old credentials, so the app works until they expire. `status` shows `last error` with the AWS CLI's message, and the app starts to report that its AWS credentials expired. Run:

```sh
./scripts/stack.sh login
```

`login` signs in again the same way `up` does (`aws sso login`, or `DAM_AWS_LOGIN_COMMAND`), writes new credentials into the containers at once, and starts the refresher if it is not running. No data is lost, and nothing restarts.

How long a sign-in lasts is not set by this script. For IAM Identity Center, [the default session is 8 hours, and an administrator can set 15 minutes to 90 days](https://docs.aws.amazon.com/singlesignon/latest/userguide/user-interactive-sessions.html). With an external identity provider such as Okta, [a shorter session at the provider shortens it](https://docs.aws.amazon.com/singlesignon/latest/userguide/user-session-duration-prereqs-considerations.html). Ask your AWS administrator if you need to know.

`down` stops the refresher and deletes the credentials from the volume before it stops the containers.

### Okta

People who sign in to AWS through Okta usually work in one of two ways.

1. **IAM Identity Center with Okta as the identity provider.** Your profile is an IAM Identity Center profile, and `aws sso login` sends you to Okta in the browser. Nothing else to set up: `up` and `login` run `aws sso login` for you. The session length is the one in the previous section.
2. **An Okta tool that writes temporary keys into `~/.aws/credentials`**, such as okta-aws-cli, gimme-aws-creds or saml2aws. The profile then holds plain keys that stop working after the time the tool chose, often one hour. The AWS CLI cannot see when they end, so the bridge cannot either: `up` finds out with its `GetCallerIdentity` call, but the refresher cannot. Tell the script which command signs you in:

   ```sh
   export DAM_AWS_LOGIN_COMMAND='okta-aws-cli web --profile <profile-name>'
   ./scripts/stack.sh up --profile <profile-name>
   ```

   `up` runs the command when the AWS CLI has no credentials or AWS refuses them, and `login` always runs it. The command runs in a shell, in your terminal, with `AWS_PROFILE` set to the profile. You can also put the line `DAM_AWS_LOGIN_COMMAND='...'` in `.env`. When the keys stop working, run `./scripts/stack.sh login`, or run your Okta tool yourself: the refresher copies whatever keys the AWS CLI reads from the profile once a minute, so the new keys reach the containers within a minute.

### Without the AWS CLI

If the AWS CLI is not installed, or is older than 2.9.6, `up` says so and falls back to the older way: it mounts your `~/.aws` folder into the containers read-only, and `AWS_PROFILE` selects the profile. `up --mount-aws-dir` chooses this way on purpose. `DAM_AWS_DIR=<folder>` replaces `~/.aws` as the folder that is mounted.

What works depends on the profile type:

| Your profile | With the AWS CLI (the bridge) | With the mounted folder |
|---|---|---|
| Access keys | Works | Works |
| A role assumed from a profile with access keys (`role_arn` and `source_profile`) | Works | Works. The AWS SDK in the container calls `AssumeRole` itself |
| Any profile with `mfa_serial` | Works. The CLI asks for the code in your terminal when `up` or `login` runs. The refresher cannot ask, so run `login` when the role session ends | Does not work. The app has no way to ask for the code |
| `credential_process` | Works | Does not work. The program lives on your computer, not in the container |
| IAM Identity Center (SSO) | Works | Unreliable. The container can read the cached sign-in token but, on a read-only mount, cannot renew it |

The sources for the limits of the mounted folder: [`credential_process` runs a program named in your AWS configuration](https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html), and [IAM Identity Center sign-in tokens are cached in `~/.aws/sso/cache`](https://docs.aws.amazon.com/sdkref/latest/guide/feature-sso-credentials.html). The AWS SDK for JavaScript, which the app uses, writes a renewed token back to that cache file, and a read-only mount does not allow that. Install the AWS CLI rather than work around these limits.

`--export-credentials`, the option of earlier versions that put credentials in the containers' environment, is accepted and ignored.

### Credentials already in your shell

If your shell already has `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (for example from `aws-vault exec <profile> --`), run `./scripts/stack.sh up` in that shell with no `--profile`. The bridge passes those credentials on, but nothing can renew them: only that shell knows how. When they expire, the app loses access until you run `up` again in a fresh shell. A named profile is better.

### What stays safe

- The credentials are never written to a file on your computer, and never put in a command line or in an environment variable of a container, so `podman inspect` and the process list do not show them. The script holds them in memory only, long enough to write them into the volume. (The AWS CLI keeps its own cache in `~/.aws`, as it always does.)
- In the volume the file is `/data/.aws-bridge/credentials.json`, mode `0600` in a folder with mode `0700`, owned by the app user. Anyone who can run commands as that user in a container, or who administers the container engine, can read it. It holds temporary credentials, which expire. `down` deletes it, with or without `--volumes`.
- Only the credentials of the one profile reach the containers. They do not see your `~/.aws` folder: no other profile, no cached sign-in token. A profile with access keys is the exception to "temporary": the bridge passes those long-term keys on. Prefer a role or an IAM Identity Center profile.
- The refresher keeps no credential. It starts the AWS CLI each time. Its files, in the git-ignored `.dam/` folder of the repository, hold only a process number, a log and a status with times and error messages.
- The refresher stops by itself about 15 minutes after the containers are gone, for example after `podman compose down`.

To run the app without containers, see [Run the app without containers](development.md).

## Change the policy of the containers

[Policy](policy.md) files set rules, layouts and audit prompts. To change them for the container stack, put your changes in a folder and name it:

```sh
./scripts/stack.sh up --profile <profile-name> --policy /path/to/my-policy
```

The script mounts the folder read-only into the web app and the worker at `/app/policy-overlay`, and the app merges it over the default `policy/` folder. A history repository's own `policy/` folder still wins over it. The choice is saved in `.env` as `DAM_POLICY_OVERLAY_HOST_DIR`, so later runs of `up` keep it. `--policy none` removes it. The path may contain spaces. On macOS, the folder must be one that your Podman machine shares, which by default means a folder under `/Users`.

The script warns when the folder holds none of the file names that the app reads. The app reads its policy once, when it starts, so run `up` again after you edit a file. [Policy](policy.md#write-an-overlay) explains how to write an overlay.

## Stop, update and clean up

| To do this | Run |
|---|---|
| See both stacks and the AWS credentials | `./scripts/stack.sh status` |
| Sign in to AWS again and renew the credentials | `./scripts/stack.sh login` |
| Read the logs | `./scripts/stack.sh logs [-f] [web\|worker\|postgres]` |
| Stop, keep all data. Also stops the credential refresher and deletes the credentials from the volume | `./scripts/stack.sh down` |
| Stop and delete the database and history | `./scripts/stack.sh down --volumes` (cannot be undone) |
| Update to a newer version | `git pull`, then run the same `up` command again. It rebuilds the image and recreates the containers. Database migrations run when the web container starts |
| Start over completely | `./scripts/stack.sh down --volumes`, then `up` |

If `.env` is lost while the database volume still exists, `up` refuses to create a new password, because the database would reject it. Put the old value back, or delete the volume with `down --volumes`.

## Run a published image

If the project publishes an image, you can skip the build. Set `DAM_IMAGE` to its name, for example `ghcr.io/<owner>/devops-agent-manager:<tag>`:

```sh
DAM_IMAGE=ghcr.io/<owner>/devops-agent-manager:<tag> ./scripts/stack.sh up --profile <name>
DAM_IMAGE=ghcr.io/<owner>/devops-agent-manager:<tag> ./scripts/stack.sh demo
```

The script pulls the image and builds nothing. To update, use a newer tag. The compose files read the same variable, so `DAM_IMAGE` also works with plain `podman compose`.

## Docker and Windows

- **Docker.** The script uses Podman when it is installed and Docker otherwise. Set `DAM_CONTAINER_CLI=docker` to choose Docker even when Podman is installed. The Docker path is written but has not been tested by the project. The script never starts Docker Desktop for you, so start it first.
- **Windows.** Use WSL2 with a Linux distribution, install Podman or Docker inside it (or turn on Docker Desktop's WSL integration), and run `./scripts/stack.sh` from the Linux shell. Install the AWS CLI inside the same Linux shell: the script runs it there. Keep the repository inside the Linux file system, not under `/mnt/c`, for speed. Clone inside WSL. If someone clones on the Windows side anyway, [`.gitattributes`](../.gitattributes) keeps the scripts and the `Containerfile` on Unix line endings, so they still run in the container.
- **Another `~/.aws` folder.** With `--mount-aws-dir`, `DAM_AWS_DIR=<folder>` replaces `~/.aws` as the folder that is mounted.

## When something fails

| Message or symptom | What to do |
|---|---|
| `Podman is installed but not answering` | Run `podman machine start`. |
| `No AWS credentials were found, and no profile is named`, or `The AWS CLI has no usable credentials` | Sign in the way you normally do, then run `up` again. See [AWS credentials in containers](#aws-credentials-in-containers). |
| `status` shows a `last error`, or the app says its AWS credentials expired | Your AWS sign-in ended. Run `./scripts/stack.sh login`. |
| The container engine has less than 3.5 GiB of memory | See [Memory for the build](#memory-for-the-build). |
| The page shows "Waiting for the background worker" for a demo or stack that is running | Run `./scripts/stack.sh logs worker`. |
| A port is already in use | Set `DAM_PORT` or `DAM_DEMO_PORT` to a free port. |
| The database refuses the password | See the note about `.env` under [Stop, update and clean up](#stop-update-and-clean-up). |
