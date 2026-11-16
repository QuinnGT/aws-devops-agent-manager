---
name: cache-path-check
description: Use when seat holds disappear early or a cache may be involved. Checks whether the cache path is healthy by comparing request status and latency with a normal day.
---

# Cache path check

Seat holds live in the `seat-hold-cache` ElastiCache cluster. Use this skill to decide whether the cache is the problem.

## Steps

1. Find the cache for the service with `anyco_cmdb_lookup`. For seat holds it is the `seat-hold-cache` cluster.
2. Query the HTTP status codes and the latency of `seat-map-service` for the incident window.
3. Query the same metrics for the same hour on the previous day.
4. If the status codes and latency match the previous day, the cache path is healthy.

## What to report

- The status code counts and the latency percentiles for both days.
- Whether the cache path is healthy or not.
