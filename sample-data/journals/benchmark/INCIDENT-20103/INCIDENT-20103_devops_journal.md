# INCIDENT-20103 - DevOps Agent Investigation Journal

- **Incident**: INCIDENT-20103
- **Title**: INC-3103: Order confirmation emails delayed
- **Date**: 2026-10-28
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Messaging
- **Service (CMDB role)**: notification-service
- **Root cause type**: Data / message

> This is the DevOps Agent's own investigation output (journal / RCA) for this incident, captured from the benchmark report.

---

## Root Cause Summary
Order confirmation emails are delayed by more than 10 minutes at p95. notification-service sends at 13.8 per second against the SES account limit of 14 per second and throttles about 10 sends per minute. A consumer backlog was ruled out: total lag on order-events is 925 messages. Recommended action: request a higher SES sending rate and add jitter to the retry delay. Confidence: mid.
