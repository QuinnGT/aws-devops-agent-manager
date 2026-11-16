# INCIDENT-20105 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20105
- **Title**: INC-3105: New events missing from search
- **Date**: 2026-10-30
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Search
- **Service (CMDB role)**: search-api
- **Root cause type**: Configuration

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **3/5** |
| Verdict | **Partly right (right area, wrong mechanism)** |
| DevOps stated confidence | mid |
| Comparison agent (Reference-RCA) score | 3/5 |

## What DevOps got right

Located the problem in the search-indexer to events-search path, saw the falling indexing rate and the growing backlog, and noted the retries.

## What DevOps got wrong / missed

Said "replication delay, will recover" and ruled out an indexer fault because no ERROR lines existed at 12:10 UTC. The ERROR lines with the mapping conflict began at 12:25 UTC. The agent also recommended to continue monitoring.

## Why this incident is flagged

The DevOps Agent scored **3/5** against the confirmed incident review, meaning its investigation was "Partly right (right area, wrong mechanism)". Compare `INCIDENT-20105_devops_journal.md` (what the agent concluded) against `20105_actual_rca.md` (what actually happened) to see the gap.
