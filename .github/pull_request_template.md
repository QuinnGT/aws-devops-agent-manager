## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How you checked it

<!-- Commands you ran, screens you opened. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass.
- [ ] New logic has a test next to the code. Integration tests (`pnpm test:int`) ran if the change touches the database.
- [ ] No credentials, account IDs or customer data in code, fixtures, logs or screenshots. Tests use `sample-data/`.
- [ ] A new dependency is pinned to an exact version, and this description says why it is needed.
- [ ] A new permission is listed in `src/server/policy/sections/roles.ts` and `policy/roles.yaml`, and this description says so.
