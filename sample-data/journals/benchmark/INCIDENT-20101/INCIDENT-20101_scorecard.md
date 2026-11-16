# INCIDENT-20101 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20101
- **Title**: INC-3101: Seat holds released early during an on-sale
- **Date**: 2026-10-26
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Caching and Data
- **Service (CMDB role)**: seat-map-service
- **Root cause type**: Configuration

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **1/5** |
| Verdict | **Missed (wrong root cause)** |
| DevOps stated confidence | mid |
| Comparison agent (Reference-RCA) score | 3/5 |

## What DevOps got right

Found that holds were lost inside the TTL and that seat-map-service kept answering HTTP 200 with an empty hold.

## What DevOps got wrong / missed

Blamed seat-map-web release 412 and ruled out the cache because HTTP status, latency and cache CPU looked normal. It never queried `evicted_keys` or `used_memory` and never looked at the parameter group change from Sunday.

## Why this incident is flagged

The DevOps Agent scored **1/5** against the confirmed incident review, meaning its investigation was "Missed (wrong root cause)". Compare `INCIDENT-20101_devops_journal.md` (what the agent concluded) against `20101_actual_rca.md` (what actually happened) to see the gap.
