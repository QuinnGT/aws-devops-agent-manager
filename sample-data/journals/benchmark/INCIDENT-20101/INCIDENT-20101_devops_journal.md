# INCIDENT-20101 - DevOps Agent Investigation Journal

- **Incident**: INCIDENT-20101
- **Title**: INC-3101: Seat holds released early during an on-sale
- **Date**: 2026-10-26
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Caching and Data
- **Service (CMDB role)**: seat-map-service
- **Root cause type**: Configuration

> This is the DevOps Agent's own investigation output (journal / RCA) for this incident, captured from the benchmark report.

---

## Root Cause Summary
Seat holds are lost early during the Harbor Lights on-sale. Release 412 of seat-map-web (16:31 UTC) batches hold writes, and 171 of 200 sampled lost holds come from clients on release 412. The cache was ruled out: seat-map-service answers HTTP 200 on 99.96 percent of requests, p99 latency is flat at 44 ms against 41 ms the day before and cache engine CPU stays under 40 percent. Recommended action: roll seat-map-web back to release 411. Confidence: mid.
