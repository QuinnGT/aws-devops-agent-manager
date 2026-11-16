# INCIDENT-20107 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20107
- **Title**: INC-3107: Checkout error-rate alarm at 03:10 PT
- **Date**: 2026-10-31
- **Severity**: Low
- **Region**: us-west-2
- **Domain**: Checkout
- **Service (CMDB role)**: checkout-api
- **Root cause type**: Alarm configuration

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **3/5** |
| Verdict | **Partly right (right area, wrong mechanism)** |
| DevOps stated confidence | high |
| Comparison agent (Reference-RCA) score | 4/5 |

## What DevOps got right

Found that all errors were 404 responses on the retired coupon route, read the counts correctly and said there was no customer impact.

## What DevOps got wrong / missed

Called the old clients the root cause and recommended a 410 and a threshold change. The point is that the alarm fired on 41 requests: three errors are noise at that traffic, not a fault. The agent had `request_count` of 41 in its own results and did not say the sample was too small.

## Why this incident is flagged

The DevOps Agent scored **3/5** against the confirmed incident review, meaning its investigation was "Partly right (right area, wrong mechanism)". Compare `INCIDENT-20107_devops_journal.md` (what the agent concluded) against `20107_actual_rca.md` (what actually happened) to see the gap.
