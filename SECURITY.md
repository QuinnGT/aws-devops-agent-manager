# Security policy

DevOps Agent Manager is a community project. It is not an official AWS product.

## Report a vulnerability

Report it privately with GitHub's private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability**.
3. Describe the affected version, the steps to reproduce the problem, and what an attacker gains.

[GitHub's documentation](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-a-vulnerability/privately-reporting-a-security-vulnerability) describes the form and what happens after you submit it. Do not open a public issue or pull request for a vulnerability.

Never put credentials, access keys, account IDs, Agent Space content or customer data in a report. To show a problem, reproduce it with the sample data (`pnpm demo:seed`), or mask the values first.

The maintainers answer in the private advisory. They will agree a fix and a disclosure date with you there, and credit you in the advisory if you want that.

## Problems in AWS services

A vulnerability in the AWS DevOps Agent service, in the AWS SDK or in another AWS service is not in scope here. Report it to AWS through the [AWS vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/).

A vulnerability in a third-party dependency belongs to that project. Report it here only if this project uses the dependency in a way that makes it exploitable.

## Supported versions

Only the latest release receives security fixes. Until the first release, only the `main` branch does.

## Security model

This is a summary. [docs/security.md](docs/security.md) has the details.

1. **Network.** The server binds to `127.0.0.1` unless you set `DAM_HOST`. `compose.yaml` publishes the web port on `127.0.0.1` only, and Postgres has no published port. To reach the app from another machine, use an SSH port forward or hosted mode.
2. **Sign-in.** Hosted mode signs users in through OpenID Connect (OIDC). With no identity provider and no dev bypass, the app rejects every request. `AUTH_DEV_BYPASS` signs in one local user, and the server refuses to start with it unless it binds to loopback or runs in a container published to `127.0.0.1` only.
3. **Permissions.** Every Server Action, Route Handler and page that reads data checks the signed-in user's role for the Agent Space first.
4. **AWS access.** The app reaches AWS only through the AWS SDK credential providers, with the profile or role you configure. Only the worker process can write to an Agent Space, and every write goes through a plan.
5. **Untrusted content.** Agent Space content, journals and model output are treated as untrusted. Markdown is sanitized before it is shown, and nothing a model returns is executed or used as a file path. Zip imports reject absolute paths, `..` segments and symlinks.
6. **Audit log.** Every user action that changes something is recorded with the user who did it.
7. **Secrets.** Secrets come from environment variables or `*_FILE` paths. None are committed, and tests make no AWS or Bedrock calls.
