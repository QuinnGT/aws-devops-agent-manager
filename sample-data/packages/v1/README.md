# AnyCompany DevOps Agent instructions, package v1

This is the first version of the instruction package for AnyCompany Tickets, a fictional ticket seller used as sample data. It was live from the first week of the pilot until release v2 replaced it. It uses the plain instruction folders layout: `instructions/`, `skills/` and `memory/`, with `reference/` beside them.

## Where each file goes

Open each managed agent from the Agents page and use its Agent definition tab.

| File | Section | Managed agent |
|---|---|---|
| `instructions/global.md` | Global instructions | any agent's page |
| `instructions/incident-triage.md` | Agent instructions | Incident triage |
| `instructions/incident-rca.md` | Agent instructions | Incident RCA |
| `instructions/incident-mitigation.md` | Agent instructions | Incident mitigation |
| `instructions/chat.md` | Agent instructions | Chat |

## Contents

| Folder | What it holds | Upload |
|---|---|---|
| `instructions/` | Five instruction files | Yes, as above |
| `skills/` | Eight skills, one folder each | Yes, one asset per folder |
| `memory/` | Three memory stores with nine memories | Yes. `STORE.md` registers a store. `INDEX.md` is generated |
| `reference/` | `ASSET-METADATA.json` (skill agent types and status) and `VALIDATION.json` (build result) | No |

Skill zips (`skills/<name>.zip`) are built from the skill folders by the package build and are not committed. Run the build before you check this package against a space.

## Agent types

| Skill | Agent types |
|---|---|
| `change-window-search` | Incident triage, Incident RCA |
| `cache-path-check`, `vendor-status-check`, `feature-flag-audit`, `token-signing-check` | Incident RCA |
| `low-sample-size-check` | Incident triage |
| `bounded-log-query`, `legacy-dashboard-links` | Generic |
