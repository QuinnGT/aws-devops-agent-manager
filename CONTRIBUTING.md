# Contributing

DevOps Agent Manager is a community project. It is not an official AWS product. Contributions are welcome under the [MIT license](LICENSE).

To report a security problem, follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## Set up

[docs/development.md](docs/development.md) explains how to install the tools, start the local database and run the app. You need Node.js 22.12 or later (CI uses 24), pnpm 10 and, for the database, Podman or any other container runtime. The pnpm version is pinned in `package.json`; `corepack enable` makes that version available.

Read [AGENTS.md](AGENTS.md) before you change code. It lists the stack, the security rules, the module contracts and the style rules. Pull requests are reviewed against it.

## Checks

These four commands must pass before you open a pull request:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

If your change touches the database, also run the integration tests against a disposable database (see "Local services" in `AGENTS.md`):

```sh
TEST_DATABASE_URL=<url of a database you can empty> pnpm test:int
```

CI runs the same four checks, the integration tests, `pnpm demo:seed` on a fresh database, a container image build, and a secret scan with [gitleaks](https://github.com/gitleaks/gitleaks). A pull request needs all of them green.

## Tests

- Put a test next to the code it covers: `*.test.ts` for unit tests, `*.int.test.ts` for integration tests.
- Tests make no live calls to AWS, Bedrock or GitHub. Use `aws-sdk-client-mock`, the AI SDK's mock models and the captured responses in `test/fixtures/`.
- New logic needs a test. A bug fix needs a test that fails without the fix.

## Test data and privacy

Never commit real customer data, account IDs, Agent Space IDs, people's names or credentials, not even in a test, a fixture, a log excerpt or a screenshot.

- `sample-data/` is the dataset for tests and `pnpm demo:seed`. It describes an invented company, AnyCompany Tickets. Add to it when a test needs more data, and keep it invented.
- Use `example.com` addresses, account `111122223333` and Region `us-west-2` in examples.
- `test/private/` is git-ignored. Put tests there when they need data you cannot publish, such as your own instruction package. They run with the other tests when the folder exists, and they never reach the repository.
- The secret scan reports anything that looks like a key. If a test needs a fake key, use an obviously made-up value (for example `AKIAIOSFODNN7EXAMPLE`). Only if the scan still reports it, add a narrow entry to `.gitleaks.toml` for that file and value, and say why in the pull request.

## Pull requests

- Keep each pull request small and about one thing. Open an issue first for a large change.
- Fill in the pull request template.
- Say why in the description when you add a dependency, and pin it to an exact version.
- A new permission goes in `src/server/policy/sections/roles.ts` and `policy/roles.yaml`. Say so in the description.
- UI changes follow `design-system/devops-agent-manager/MASTER.md` and the page file for the screen.
- Use plain, specific wording in UI text and documentation. No em dashes. Use inclusive language (allowlist and denylist, primary and replica).
