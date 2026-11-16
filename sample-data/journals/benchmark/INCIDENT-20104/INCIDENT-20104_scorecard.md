# INCIDENT-20104 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20104
- **Title**: INC-3104: Mobile sign-in failures
- **Date**: 2026-10-29
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Identity
- **Service (CMDB role)**: identity-service
- **Root cause type**: Configuration

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **1/5** |
| Verdict | **Missed (wrong root cause)** |
| DevOps stated confidence | low |
| Comparison agent (Reference-RCA) score | 2/5 |

## What DevOps got right

Reported honestly that identity-service could not be read, and listed the 403 responses as a gap. Found that the 401 responses came from mobile-bff.

## What DevOps got wrong / missed

Concluded a client side bug in app 6.3.x. The failures were not specific to a version. The agent never saw identity-service, where the missing previous key showed.

## Why this incident is flagged

The DevOps Agent scored **1/5** against the confirmed incident review, meaning its investigation was "Missed (wrong root cause)". Compare `INCIDENT-20104_devops_journal.md` (what the agent concluded) against `20104_actual_rca.md` (what actually happened) to see the gap.
