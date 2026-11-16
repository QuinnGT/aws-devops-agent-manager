# INCIDENT-20106 - DevOps RCA Scorecard & Feedback

- **Incident**: INCIDENT-20106
- **Title**: INC-3106: Price at checkout differs from the event page
- **Date**: 2026-10-30
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Pricing
- **Service (CMDB role)**: pricing-service
- **Root cause type**: Feature flag and cache

---

## Score

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **2/5** |
| Verdict | **Symptom only (partial / shallow)** |
| DevOps stated confidence | low |
| Comparison agent (Reference-RCA) score | 4/5 |

## What DevOps got right

Measured the price gap on checkout-api (112 lines, 4 to 12 units) and stated low confidence because the ticket had little context.

## What DevOps got wrong / missed

Blamed CDN caching and recommended a purge. The mismatch lines all carried `variant=v2`, which pointed at the pricing flag. The agent did not include pricing-service in its change query and did not run the feature flag audit.

## Why this incident is flagged

The DevOps Agent scored **2/5** against the confirmed incident review, meaning its investigation was "Symptom only (partial / shallow)". Compare `INCIDENT-20106_devops_journal.md` (what the agent concluded) against `20106_actual_rca.md` (what actually happened) to see the gap.
