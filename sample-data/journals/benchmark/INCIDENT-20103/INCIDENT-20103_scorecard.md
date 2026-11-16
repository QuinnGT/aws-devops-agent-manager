# INCIDENT-20103 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20103
- **Title**: INC-3103: Order confirmation emails delayed
- **Date**: 2026-10-28
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Messaging
- **Service (CMDB role)**: notification-service
- **Root cause type**: Data / message

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **2/5** |
| Verdict | **Symptom only (partial / shallow)** |
| DevOps stated confidence | mid |
| Comparison agent (Reference-RCA) score | 3/5 |

## What DevOps got right

Saw that emails were late, that SES was close to its limit and that lag existed on partition 7 of order-events.

## What DevOps got wrong / missed

Blamed SES throttling. Every throttled send succeeded 1.8 to 3.1 seconds later, which cannot cause an 11 minute delay. The lag on partition 7 was noted and then dismissed as a side effect. The agent never read the fulfillment-worker logs.

## Why this incident is flagged

The DevOps Agent scored **2/5** against the confirmed incident review, meaning its investigation was "Symptom only (partial / shallow)". Compare `INCIDENT-20103_devops_journal.md` (what the agent concluded) against `20103_actual_rca.md` (what actually happened) to see the gap.
