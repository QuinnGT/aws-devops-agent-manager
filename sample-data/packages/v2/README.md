# AnyCompany DevOps Agent instructions, package v2

This is the second version of the instruction package for AnyCompany Tickets, a fictional ticket seller used as sample data. It was built after an audit of eight investigations that ran on v1. Each change below answers a failure the audit found.

## Where each file goes

Open each managed agent from the Agents page and use its Agent definition tab.

| File | Section | Managed agent |
|---|---|---|
| `instructions/global.md` | Global instructions | any agent's page |
| `instructions/incident-triage.md` | Agent instructions | Incident triage |
| `instructions/incident-rca.md` | Agent instructions | Incident RCA |
| `instructions/incident-mitigation.md` | Agent instructions | Incident mitigation |
| `instructions/chat.md` | Agent instructions | Chat |

`instructions/shared/handoff.md` is a source file. The package build copies it into the triage and RCA files between the `shared: handoff` markers. Edit the source, then build. Do not upload it on its own.

## Contents

| Folder | What it holds | Upload |
|---|---|---|
| `instructions/` | Five instruction files and one shared section | Yes, as above |
| `skills/` | Eight skills, one folder each | Yes, one asset per folder |
| `memory/` | Three memory stores with ten memories | Yes. `STORE.md` registers a store. `INDEX.md` is generated |
| `reference/` | `ASSET-METADATA.json` (skill agent types and status) and `VALIDATION.json` (build result) | No |

Skill zips (`skills/<name>.zip`) are built from the skill folders by the package build and are not committed. Run the build before you check this package against a space.

## Agent types

| Skill | Agent types |
|---|---|
| `change-window-search` | Incident triage, Incident RCA |
| `cache-path-check`, `vendor-status-check`, `feature-flag-audit`, `token-signing-check`, `consumer-lag-check` | Incident RCA |
| `low-sample-size-check` | Incident triage |
| `bounded-log-query` | Generic |

## What changed from v1

1. A shared handoff section in the triage and RCA instructions: onset, faulty component, evidence records, what was ruled out, and gaps.
2. The global rules ask for the time window, log group and line limit with every cited query, and treat an access error as a gap.
3. The RCA rules say not to rule a component out until the metric that would show its failure has been read, and that a nearby change is a hypothesis.
4. Revised skills: `change-window-search` (adjacent 24-hour windows), `cache-path-check` (evictions and memory), `vendor-status-check` (status page and gateway TLS errors) and `bounded-log-query` (limits and timeouts).
5. New skill: `consumer-lag-check`. Removed skill: `legacy-dashboard-links`.
6. Memory changes: four service pages, the on-call routing page and two runbook pages gained text, two pattern pages were rewritten, and `patterns/low-traffic-alarms` is new.
