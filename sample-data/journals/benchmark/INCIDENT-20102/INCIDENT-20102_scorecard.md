# INCIDENT-20102 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20102
- **Title**: INC-3102: Card payments declining for one acquirer
- **Date**: 2026-10-27
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Payments
- **Service (CMDB role)**: checkout-api
- **Root cause type**: External dependency

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **2/5** |
| Verdict | **Symptom only (partial / shallow)** |
| DevOps stated confidence | mid |
| Comparison agent (Reference-RCA) score | 4/5 |

## What DevOps got right

Saw that card charges for ExamplePay fail fast with HTTP 502 PGW_UPSTREAM and that ExamplePay latency is normal.

## What DevOps got wrong / missed

Blamed checkout-api release 231 and recommended a rollback. The failures began in the 14:45 bucket, before the 14:52 release. The agent never read payments-gateway logs, so it missed the TLS handshake failures, and it did not check ExamplePay's status page.

## Why this incident is flagged

The DevOps Agent scored **2/5** against the confirmed incident review, meaning its investigation was "Symptom only (partial / shallow)". Compare `INCIDENT-20102_devops_journal.md` (what the agent concluded) against `20102_actual_rca.md` (what actually happened) to see the gap.
