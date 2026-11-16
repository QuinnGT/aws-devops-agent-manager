# Security

This page describes what the app protects, how, and what it leaves to you. To report a vulnerability, follow [`SECURITY.md`](../SECURITY.md).

The short version: the app listens on `127.0.0.1` by default, writes to an Agent Space only through reviewed plans and only in its worker process, and treats everything that comes from the space, a journal or a model as untrusted text.

## Network exposure

- **Loopback by default.** The web server binds `DAM_HOST`, which defaults to `127.0.0.1`. The container stack binds `0.0.0.0` inside the container and publishes the port as `127.0.0.1:<port>:<port>`. That publish rule is the boundary. Do not widen it. To reach the app from another machine, use an SSH port forward.
- **Postgres is not published.** In the container stack only the web and worker containers can reach it. The development database in `compose.dev.yaml` is published to `127.0.0.1:55432` only.
- **No TLS in the app.** It serves plain HTTP. Self-hosting behind a reverse proxy is not ready yet ([Roadmap](roadmap.md#self-hosting)). When it is, terminate TLS at the proxy, run it in hosted mode (below), and set `BETTER_AUTH_URL` and `DAM_ALLOWED_ORIGINS` to the public address. See [Configuration](configuration.md).
- **The image runs as a non-root user.**

## Sign-in

There are two modes.

**Local mode** uses the dev sign-in bypass (`AUTH_DEV_BYPASS=true`). Every request is signed in as one user, with the role in `AUTH_DEV_ROLE` (default `admin`). The sidebar shows "local sign-in bypass". The server refuses to start with the bypass on unless one of these holds:

1. `DAM_HOST` is a loopback address (`127.0.0.1`, `::1` or `localhost`).
2. `DAM_LOOPBACK_PUBLISH_ONLY=true`, which only the compose files should set, next to a port mapping that publishes to `127.0.0.1` only.

The check looks at the bind address. It cannot see a reverse proxy or a tunnel in front of a loopback port. Anything that forwards traffic to a port that runs with the bypass gives that access to whoever can reach the forwarder. Never combine the two.

**Hosted mode** uses one OpenID Connect provider (Okta, IAM Identity Center, Cognito or similar) through Better Auth, with authorization code flow and PKCE. Email and password sign-in is off. Sessions are stored in Postgres. With no provider and no bypass, the app rejects every request. Settings are in [Configuration](configuration.md#sign-in). Hosted mode is not ready for use yet: [Roadmap](roadmap.md#self-hosting) lists what is still open.

## Roles and permissions

Policy defines four roles in [`policy/roles.yaml`](../policy/roles.yaml). Each role includes the ones below it:

| Role | Can |
|---|---|
| Viewer | Read assets, history, journals and audits, and export journals, packages and audit reports |
| Editor | Everything a Viewer can, plus sync, write change reasons, draft changes, create plans, import journals, run audits, review findings and build revisions |
| Publisher | Everything an Editor can, plus approve and apply plans, restore, apply revisions and create releases |
| Admin | Everything, plus register spaces, change settings and history repositories, give people roles, start replays and read the audit log |

An Admin binds a role to a person (by email) or to a group from the identity provider, for all spaces or for one. A person with several bindings gets the highest-ranked role. Roles come from the app's policy only. The "Who can do what" page shows who holds each role in a space.

Three space settings tighten this further: a change reason can be required (on by default), a second person can be required to approve a plan (off), and deletes are refused unless an Admin turns them on (off).

Every page, Server Action and Route Handler goes through one access layer that checks the caller's permission for the space it touches. The code looks the space up first and does not trust an ID from the browser. `src/proxy.ts` only redirects signed-out people to the sign-in page. It is not the access check.

## Writes to an Agent Space

- **Only through plans.** Nothing in the app edits an asset directly. A draft, an import, a restore and a revision all become a plan. The plan page shows the diff, and the app writes only after a Publisher applies it. See [Concepts](concepts.md#drafts-plans-and-apply).
- **Only in the worker.** The code that builds AWS credentials for write access throws unless the process is the worker (`DAM_PROCESS=worker`). Git commits, tags and pushes follow the same rule. The web process cannot write even if a page tried.
- **Checked before and after.** Apply re-reads each asset and skips an item that changed since the plan was checked. It sends each write once and reads the result back to compare it with the plan.
- **Every action is logged.** The audit log records who changed or exported what, with the result. People with the `auditlog.read` permission (Admins) read it on the Audit log page and can export it as CSV or JSON. Findings, reports and revisions record who made each change.

## AWS access

The app never stores access keys. A space uses either:

- **A local profile.** The AWS SDK reads the profile, as it does for any tool on your machine. Use this for local mode.
- **Two roles to assume.** A **read role** for browsing, sync, journal export, attribution and model calls, and a **write role** that only the worker uses to apply plans. Keeping them apart means the web process never holds write permission.

When the app assumes a role it passes the signed-in person's email as the [source identity](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html), so CloudTrail shows who acted. The role's trust policy must therefore allow `sts:SetSourceIdentity`.

The app also generates an external ID for each space. Put it in each role's trust policy. AWS uses the external ID to [stop another party from tricking a service into using your role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html) (the confused deputy problem). AWS does not treat it as a secret. When you register a space with roles, the app tries to assume each role without the external ID and rejects the registration if that works.

The exact permissions and trust policies are in [AWS setup](aws-setup.md).

## Untrusted content

Text from an Agent Space, from journals and from models can be wrong or hostile. A skill, a memory or a journal could contain markup, a link, or a sentence that tries to instruct a model.

- **Rendering.** Markdown is rendered only with the app's `SafeMarkdown` component: raw HTML is skipped, and the result is sanitized. The code does not use `dangerouslySetInnerHTML`.
- **Model input.** Journal text and ground-truth documents are data. The prompts say so and tell the model to report text that tries to direct it, instead of following it.
- **Model tools.** A review has three tools, and each reads only that investigation's records. The model has no tool for other journals, files, other spaces or the network.
- **Model output.** Nothing a model returns is run, fetched, or used as a path. A review is checked against a schema, and every record it cites is checked against the journal. A person accepts or rejects each finding before it can reach a revision.
- **Uploads.** Zips and package folders are read with limits on size and entry count. The reader rejects absolute paths and `..` segments, and package uploads also reject symlinks, encryption and duplicate names. Nothing from a zip is written to disk under its own name.

## Where data is stored

| Data | Where |
|---|---|
| Asset content and change history, releases, finalized audits, revision branches | The history repository on the machine that runs the app, `DAM_DATA_DIR/history/<name>`. It is pushed to your remote only when you set one up and turn pushes on |
| The asset index, plans, drafts, journals (every cached record), analyzer results, audits, findings, ground-truth documents, role bindings, sessions, the audit log | Postgres |
| Journal exports (kept 14 days), journal imports, package uploads (kept 30 days) | `DAM_DATA_DIR`, in folders with mode `0700` and files with mode `0600` |
| A history repository's deploy key | Only its path is stored. The key file stays where you put it |
| AWS credentials | Not stored. The SDK reads them from your profile, environment or role |

Model calls send journal content, ground truth and analyzer output to Amazon Bedrock in the account and Region of the space's read role (or the Region set in Space settings). Choose a model and Region that your data rules allow.

## What this does not cover

- **Encryption at rest.** The app does not encrypt Postgres or `DAM_DATA_DIR`. Journals can hold production data, so use an encrypted disk or volume.
- **One trust boundary.** A deployment trusts its Admins and its Postgres administrators. It does not separate teams from each other.
- **The first Admin in hosted mode.** The app has no built-in way to create the first role binding when sign-in is OIDC only. Start the app once in local mode against the same database, add the binding in App settings, then switch to hosted mode.
- **The IAM permissions.** The app does not check them. A missing permission shows up when a page loads or a job runs.
- **Your identity provider and proxy.** Their configuration, their rate limits and their logs are yours.
- **The AWS DevOps Agent service.** Report issues in the service to AWS.
