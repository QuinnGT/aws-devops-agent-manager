# INCIDENT-20108 - DevOps Agent Investigation Journal

- **Incident**: INCIDENT-20108
- **Title**: INC-3108: Venue maps not loading for some users
- **Date**: 2026-11-01
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Edge and content
- **Service (CMDB role)**: venue-cdn
- **Root cause type**: Configuration and replication

> This is the DevOps Agent's own investigation output (journal / RCA) for this incident, captured from the benchmark report.

---

## Root Cause Summary
Seat maps do not load for some users. The most likely explanation is a regional network issue affecting a subset of users. Origin failover and a stale secondary bucket were also found. Recommended action: copy the 605 missing objects to the secondary bucket, restore the replication role policy and add a replication latency alarm. Confidence: mid.
