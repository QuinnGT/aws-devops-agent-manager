# INCIDENT-20108 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20108
- **Title**: INC-3108: Venue maps not loading for some users
- **Date**: 2026-11-01
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Edge and content
- **Service (CMDB role)**: venue-cdn
- **Root cause type**: Configuration and replication

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **4/5** |
| Verdict | **Mostly correct (mechanism found, summary off)** |
| DevOps stated confidence | mid |
| Comparison agent (Reference-RCA) score | 4/5 |

## What DevOps got right

Found the origin failover, the 605 missing objects in the secondary and the replication gap in its findings and its closing message. Ruled out a network issue with the country spread of the failing requests.

## What DevOps got wrong / missed

The investigation summary still leads with "a regional network issue" as the root cause and gives mid confidence. A reader of the summary alone would look in the wrong place.

## Why this incident is flagged

The DevOps Agent scored **4/5** against the confirmed incident review, meaning its investigation was "Mostly correct (mechanism found, summary off)". Compare `INCIDENT-20108_devops_journal.md` (what the agent concluded) against `20108_actual_rca.md` (what actually happened) to see the gap.
