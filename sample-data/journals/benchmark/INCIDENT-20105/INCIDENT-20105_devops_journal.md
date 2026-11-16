# INCIDENT-20105 - DevOps Agent Investigation Journal

- **Incident**: INCIDENT-20105
- **Title**: INC-3105: New events missing from search
- **Date**: 2026-10-30
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Search
- **Service (CMDB role)**: search-api
- **Root cause type**: Configuration

> This is the DevOps Agent's own investigation output (journal / RCA) for this incident, captured from the benchmark report.

---

## Root Cause Summary
New events are missing from search. The most likely cause is a replication delay after the events-search software update at 11:41 UTC: the indexer is retrying its bulk batches, the domain is green and the indexer log has no ERROR lines. An indexer fault was ruled out. The backlog should clear without action. Continue monitoring the backlog. Confidence: mid.
