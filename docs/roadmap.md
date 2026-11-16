# Roadmap

Today the app runs on one computer: an engineer's laptop, signed in as a local administrator and reachable from that computer only. This page lists what is planned next. Nothing here has a date.

The project is a stop-gap until the AWS DevOps Agent service offers these features. When the service covers one of them, the matching part of this app will point to the service instead.

## Self-hosting

**Not ready yet.** The code has a hosted mode: sign-in through an OpenID Connect provider, roles, and an audit log ([Security](security.md#sign-in)). The project does not support it yet, because the items below are open. Until they are done, run the app on your own computer with `./scripts/stack.sh up`.

Self-hosting is ready when all of these are true:

- [ ] **Sign-in works end to end with a real identity provider.** At least one OpenID Connect provider (for example Okta, IAM Identity Center or Amazon Cognito) is tested, with a written setup for each one tested. Today the sign-in flow has no automated test and has not been tried against a provider.
- [ ] **The first administrator can be set up in hosted mode.** Today the first role binding needs one run in local mode against the same database ([Security](security.md#what-this-does-not-cover)).
- [ ] **The app works behind a reverse proxy with TLS.** `DAM_ALLOWED_ORIGINS` is read when the image is built, so a published image refuses Server Actions from a proxy's address. The app has to read it when it starts.
- [ ] **AWS access comes from the server's own role.** On a server, the app uses its host's role (an EC2 instance profile or an ECS task role) to assume each space's read and write roles with the external ID. No personal AWS profile or sign-in is involved. The credential chain supports this already. It needs a tested setup and its own section in [AWS setup](aws-setup.md).
- [ ] **History is kept off the server.** The worker pushes each history repository to a remote with a deploy key, in the containers, so a lost server loses no history. Today the container stack mounts no deploy key.
- [ ] **One tested reference deployment on AWS.** The database runs outside the app (for example Amazon RDS for PostgreSQL), TLS is in place, and backups, restores and upgrades are written down and tested.
- [ ] **Each release publishes an image** (see below), so a server never builds the app itself.
- [ ] **Hosted mode has had a security review**, and [Security](security.md) records the result: what each role can see and do when many people share one deployment, session lifetime, and what the operator must protect.

## Smaller items

- **A published container image.** The release workflow (`.github/workflows/release-image.yml`) builds an image for `linux/amd64` and `linux/arm64` and publishes it to the GitHub container registry on each version tag. It has not run yet. Once it has, `DAM_IMAGE` lets `./scripts/stack.sh` skip the local build ([Getting started](getting-started.md#run-a-published-image)).
- **A tested Windows path.** The scripts run inside WSL2, but nobody has tested them there yet: the AWS sign-in from WSL, the container engines, and the browser reaching the app.
- **Clearer policy errors.** A policy file with a mistake makes every page fail with only a count of problems. The page should name the file and the key, as the server log does today ([Policy](policy.md#when-policy-has-an-error)).

## Being explored

Ideas that are not decided. They may change shape or be dropped.

- **Audit reviews by a coding agent on your own computer.** Today an audit sends each investigation to a model in Amazon Bedrock: the app runs the review with the brief and the output schema of the audit profile (`policy/audit-profiles/`), then checks the result against the schema and checks every quote against the journal record it cites. The idea is to let a coding agent the engineer already uses, for example the Kiro CLI or Claude Code, do the review step instead. The app would hand it the same inputs (the brief, the condensed trace, the journal records, the ground truth and the output schema), read back the review, and run the same checks, so findings look the same whichever way they were made. Teams without Bedrock model access, or with an agent tool their company has already approved, could then run audits too. Open questions: how the app hands the inputs over and reads the result back (a folder per incident, or a local tool server the agent calls), how to keep the agent read-only and limited to that one investigation, as the Bedrock review is today, and how to record which agent and model wrote each review.

## Ideas and requests

Open an issue with the feature request form. Say what you want to do and why: the problem matters more than the solution.
