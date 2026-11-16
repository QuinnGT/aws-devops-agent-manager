# INCIDENT-20106 - DevOps Agent Investigation Journal

- **Incident**: INCIDENT-20106
- **Title**: INC-3106: Price at checkout differs from the event page
- **Date**: 2026-10-30
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Pricing
- **Service (CMDB role)**: pricing-service
- **Root cause type**: Feature flag and cache

> This is the DevOps Agent's own investigation output (journal / RCA) for this incident, captured from the benchmark report.

---

## Root Cause Summary
The event page shows a higher price than checkout for 112 sampled requests since 15:36 UTC. The most likely cause is CDN caching of the price path on venue-cdn (60 second TTL, 93 percent hit rate). Recommended action: purge /api/events/*/prices on venue-cdn. Confidence: low. The ticket had no description or CMDB role.
