---
name: cache-path-check
description: Use when seat holds disappear early or a cache may be involved. Checks evictions, memory use and the eviction policy before you rule the cache out.
---

# Cache path check

A cache can fail while requests still return HTTP 200 and latency stays flat. A client that loses a seat hold just asks again. Do not rule the cache out from status codes and latency alone.

## Steps

1. Find the cache for the service with `anyco_cmdb_lookup`. For seat holds it is the `seat-hold-cache` ElastiCache cluster.
2. Query `evicted_keys` for the cluster from two hours before the alert. A rate above zero while holds are vanishing is the signal. Query it per shard.
3. Query `used_memory` and compare it with the configured maximum. Memory at the limit explains evictions.
4. Count the active holds. Compare the keys in the cache with the number of holds the service says it has taken. A gap means holds are being lost.
5. Check the eviction policy. The expected policy for seat holds is `volatile-ttl`. Search the change feed for parameter group changes on the cluster (see `change-window-search`). A policy that fell back to `allkeys-lru` evicts live holds at peak.
6. Only after steps 2 to 5, compare with a baseline. Use the same hour on the previous day and the same hour a week earlier.
7. See `references/cache-metrics.md` for the metrics and what each one shows.

## What to report

- The `evicted_keys` and `used_memory` values with their time windows.
- The eviction policy now and any change to it, with the time.
- The active hold count compared with the keys in the cache.
- Whether the cache is ruled in or out, and which of the numbers above is the reason.
