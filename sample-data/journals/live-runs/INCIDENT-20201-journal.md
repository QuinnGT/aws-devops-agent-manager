# Journal Log: INCIDENT-20201


---
## Record: mitigation_summary_md
**Created:** 2026-11-03 18:24:03.011000+00:00

# Mitigation Summary

## Action

A person on team-venue should add memory to seat-hold-cache before the next on-sale. The agent made no change.

## Execution Plan

### Step 1: Add capacity

#### 1.1 Increase seat-hold-cache memory
**Type:** text
Ask team-venue to move seat-hold-cache to a larger node type or add shards. Expected effect: used_memory falls below 80 percent and evicted_keys returns to 0 within minutes of the resize. Roll back by resizing again.
**Purpose:** Stop evictions of live holds

#### 1.2 Check the result
**Type:** text
Watch evicted_keys and used_memory for seat-hold-cache for 30 minutes. Compare curr_items with active_holds.
**Purpose:** Confirm holds are no longer lost

---
## Record: investigation_summary_md
**Created:** 2026-11-03 18:24:02.516000+00:00

# Investigation Summary

## Symptoms

### Seat holds released early during the Harbor Lights presale
**Description:** Holds were released after 3 to 4 minutes instead of 10. The alarm fired at 18:20 UTC (10:20 PT).
**Time:** 2026-11-03T18:03:00Z

## Findings

### Cause: seat-hold-cache ran out of memory at presale demand
**Description:** At 18:03 UTC (10:03 PT) used_memory reached 96 to 97 percent of the maximum on all three shards and evictions started, about 2,000 keys per shard per minute. The service held 61,200 holds at 18:15 while the cache held 38,900 keys. The eviction policy (volatile-ttl) and the parameter group did not change.

## Confidence

High for the mechanism (memory exhaustion and eviction), medium for sizing: the memory needed for the peak hold count was not measured.

## Key Gaps

- The 18:00 to 18:25 hold log search was cut off at 500 lines; only 18:03 to 18:04 was counted.

---
## Record: finding
**Created:** 2026-11-03 18:23:10.733000+00:00

**The pattern memory's client-bug explanation does not fit this incident**

Observed: the eviction reason appears in the hold logs (reason=evicted) and evicted_keys is non-zero. Observed: no config or parameter group change in the last 24 hours, and the policy is the expected volatile-ttl. The memory pattern that blames a seat map page client bug was not supported by any query.

---
## Record: finding
**Created:** 2026-11-03 18:23:10.250000+00:00

**Cache memory was exhausted at the start of the presale**

Observed: used_memory reached 96 to 97 percent of the maximum on all three shards at 18:03 UTC (10:03 PT), up from about 71 percent at 17:30. evicted_keys went from 0 to about 2,000 per shard per minute at the same time. Observed: at 18:15 the service held 61,200 active holds and the cache held 38,900 keys. Inferred: the presale produced more holds than seat-hold-cache can store, so keys with the shortest remaining TTL were evicted.

---
## Record: investigation_gap
**Created:** 2026-11-03 18:22:44.902000+00:00

{
  "type": "investigation_gap",
  "id": "gap-log-query-cut-off",
  "title": "Log query reached the 500-line limit",
  "description": "The first log query for 18:00 to 18:25 UTC returned 500 lines and stopped at 18:07. The count of early releases comes from the 18:03 to 18:04 window only (187 lines, not truncated)."
}

---
## Record: symptom
**Created:** 2026-11-03 18:22:44.118000+00:00

**Seat holds disappear before their 10-minute TTL**

Holds for the Harbor Lights presale were released after 3 to 4 minutes. The release ratio alarm fired at 18:20 UTC (10:20 PT).

---
## Record: message
**Created:** 2026-11-03 18:22:36.640000+00:00

**Role:** user

**Tool result** (success):
```
{
  "log_group": "/anyco/prod/seat-map-service",
  "window_utc": [
    "18:03",
    "18:04"
  ],
  "filter": "hold_expired_early",
  "lines_returned": 187,
  "limit": 500,
  "truncated": false,
  "sample": [
    "18:03:12Z hold_expired_early hold=h-88213 age_s=214 ttl_s=600 reason=evicted",
    "18:03:12Z hold_expired_early hold=h-88219 age_s=198 ttl_s=600 reason=evicted"
  ]
}
```

---
## Record: message
**Created:** 2026-11-03 18:22:29.004000+00:00

**Role:** assistant

<details><summary>Thinking (142 chars)</summary>

The result is cut off at 500 lines and only reaches 18:07, so I cannot count from it. Narrow to 18:03 to 18:06 and filter on the first minute.

</details>

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "log_group": "/anyco/prod/seat-map-service",
    "start": "2026-11-03T18:03:00Z",
    "end": "2026-11-03T18:04:00Z",
    "filter": "hold_expired_early",
    "limit": 500
  },
  "tool_name": "anyco_logs_search"
}
```

---
## Record: message
**Created:** 2026-11-03 18:22:20.371000+00:00

**Role:** user

**Tool result** (success):
```
{
  "log_group": "/anyco/prod/seat-map-service",
  "window_utc": [
    "18:00",
    "18:25"
  ],
  "filter": "hold_expired_early",
  "lines_returned": 500,
  "limit": 500,
  "truncated": true,
  "first_line_time": "18:03:12Z",
  "last_line_time": "18:07:41Z"
}
```

---
## Record: message
**Created:** 2026-11-03 18:22:08.455000+00:00

**Role:** assistant

<details><summary>Thinking (185 chars)</summary>

No cache config change. The one deploy was at 14:12 and holds were fine until 18:03. Now the service logs for hold expiry errors, in a narrow window. First try the whole presale window.

</details>

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "log_group": "/anyco/prod/seat-map-service",
    "start": "2026-11-03T18:00:00Z",
    "end": "2026-11-03T18:25:00Z",
    "filter": "hold_expired_early",
    "limit": 500
  },
  "tool_name": "anyco_logs_search"
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:57.113000+00:00

**Role:** user

**Tool result** (success):
```
{
  "window_utc": [
    "2026-11-02T18:30:00Z",
    "2026-11-03T18:30:00Z"
  ],
  "events": [
    {
      "time": "2026-11-03T14:12:00Z",
      "kind": "deploy",
      "component": "seat-map-service",
      "description": "release 2026.11.03.1, no change to hold handling"
    }
  ],
  "count": 1
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:55.690000+00:00

**Role:** assistant

<details><summary>Thinking (283 chars)</summary>

At 18:15 the service has 61,200 holds and the cache holds 38,900 keys, so about 22,300 holds are gone. The keys stop growing at about 41,000. The eviction policy is volatile-ttl, which is the expected one. I will look for config changes in the last day to be sure nothing changed it.

</details>

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "start": "2026-11-02T18:30:00Z",
    "end": "2026-11-03T18:30:00Z",
    "components": [
      "seat-hold-cache",
      "seat-map-service"
    ]
  },
  "tool_name": "anyco_changes_list"
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:46.327000+00:00

**Role:** user

**Tool result** (success):
```
{
  "metric": "active_holds",
  "points": [
    {
      "t": "17:30",
      "v": 9400
    },
    {
      "t": "18:00",
      "v": 33800
    },
    {
      "t": "18:05",
      "v": 52100
    },
    {
      "t": "18:15",
      "v": 61200
    },
    {
      "t": "18:20",
      "v": 63900
    }
  ]
}
```

**Tool result** (success):
```
{
  "metric": "curr_items",
  "points": [
    {
      "t": "17:30",
      "v": 9400
    },
    {
      "t": "18:00",
      "v": 33700
    },
    {
      "t": "18:05",
      "v": 41200
    },
    {
      "t": "18:15",
      "v": 38900
    },
    {
      "t": "18:20",
      "v": 39100
    }
  ]
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:44.120000+00:00

**Role:** assistant

<details><summary>Thinking (178 chars)</summary>

Evictions start at 18:03 on all three shards and memory is at 97 to 98 percent of the maximum. Now compare the number of holds the service says it has with the keys in the cache.

</details>

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "metric": "active_holds",
    "service": "seat-map-service",
    "start": "2026-11-03T17:30:00Z",
    "end": "2026-11-03T18:25:00Z",
    "step_seconds": 300
  },
  "tool_name": "anyco_metrics_query"
}
```

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "metric": "curr_items",
    "cluster": "seat-hold-cache",
    "aggregate": "sum",
    "start": "2026-11-03T17:30:00Z",
    "end": "2026-11-03T18:25:00Z",
    "step_seconds": 300
  },
  "tool_name": "anyco_metrics_query"
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:35.904000+00:00

**Role:** user

**Tool result** (success):
```
{
  "metric": "evicted_keys",
  "window_utc": [
    "16:20",
    "18:25"
  ],
  "step_seconds": 60,
  "shards": {
    "0001": {
      "first_nonzero": "18:03",
      "before_first_nonzero": 0,
      "avg_per_minute_after": 2140,
      "peak_per_minute": 3310
    },
    "0002": {
      "first_nonzero": "18:03",
      "before_first_nonzero": 0,
      "avg_per_minute_after": 1980,
      "peak_per_minute": 3050
    },
    "0003": {
      "first_nonzero": "18:04",
      "before_first_nonzero": 0,
      "avg_per_minute_after": 2230,
      "peak_per_minute": 3420
    }
  }
}
```

**Tool result** (success):
```
{
  "metric": "used_memory_percent_of_max",
  "window_utc": [
    "16:20",
    "18:25"
  ],
  "shards": {
    "0001": {
      "at_17_30": 71,
      "at_18_03": 97,
      "at_18_20": 98
    },
    "0002": {
      "at_17_30": 69,
      "at_18_03": 96,
      "at_18_20": 98
    },
    "0003": {
      "at_17_30": 72,
      "at_18_03": 97,
      "at_18_20": 97
    }
  }
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:33.775000+00:00

**Role:** assistant

<details><summary>Thinking (102 chars)</summary>

Per the skill: evicted_keys per shard first, then used_memory. Window from two hours before the alert.

</details>

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "metric": "evicted_keys",
    "cluster": "seat-hold-cache",
    "group_by": "shard",
    "start": "2026-11-03T16:20:00Z",
    "end": "2026-11-03T18:25:00Z",
    "step_seconds": 60
  },
  "tool_name": "anyco_metrics_query"
}
```

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "metric": "used_memory_percent_of_max",
    "cluster": "seat-hold-cache",
    "group_by": "shard",
    "start": "2026-11-03T16:20:00Z",
    "end": "2026-11-03T18:25:00Z",
    "step_seconds": 60
  },
  "tool_name": "anyco_metrics_query"
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:25.011000+00:00

**Role:** user

**Tool result** (success):
```
{
  "service": "seat-map-service",
  "tier": 1,
  "owner": "team-venue",
  "depends_on": [
    "seat-hold-cache",
    "orders-db"
  ],
  "log_group": "/anyco/prod/seat-map-service",
  "cache": {
    "name": "seat-hold-cache",
    "engine": "ElastiCache for Redis",
    "cluster_mode": true,
    "shards": 3,
    "parameter_group": "seat-hold-cache-params",
    "maxmemory-policy": "volatile-ttl"
  }
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:24.402000+00:00

**Role:** assistant

<details><summary>Thinking (49 chars)</summary>

Find the cache and its settings through the CMDB.

</details>

**Tool call:** `invoke_user_tool`
```json
{
  "arguments": {
    "service": "seat-map-service"
  },
  "tool_name": "anyco_cmdb_lookup"
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:16.120000+00:00

**Role:** user

**Tool result** (success):
```
     1	# runbooks
     2	
     3	Links are relative to this index. This is the validated local index preview.
     4	
     5	- [change-feed-windows](./change-feed-windows.md): How the change feed returns events and how to search it. Read before you query the change feed.
     6	- [log-query-limits](./log-query-limits.md): Limits on log searches and what to state with each query. Read before you run or cite a log search.
```

**Tool result** (success):
```
     1	---
     2	name: log-query-limits
     3	description: Limits on log searches and what to state with each query. Read before you run or cite a log search.
     4	---
     5	
     6	Log searches return at most 500 lines.
     7	
     8	Memory: runbooks/log-query-limits
     9	Review this memory when an incident shows it is wrong.
```

---
## Record: message
**Created:** 2026-11-03 18:21:15.833000+00:00

**Role:** assistant

<details><summary>Thinking (85 chars)</summary>

Next the runbook for log limits, so I state the window and the limit with each query.

</details>

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/memory/runbooks/INDEX.md"
}
```

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/memory/runbooks/log-query-limits.md"
}
```

---
## Record: message
**Created:** 2026-11-03 18:21:07.590000+00:00

**Role:** user

**Tool result** (success):
```
     1	---
     2	name: cache-path-check
     3	description: Use when seat holds disappear early or a cache may be involved. Checks evictions, memory use and the eviction policy before you rule the cache out.
     4	---
     5	
     6	# Cache path check
     7	
     8	A cache can fail while requests still return HTTP 200 and latency stays flat. A client that loses a seat hold just asks again. Do not rule the cache out from status codes and latency alone.
     9	
    10	## Steps
    11	
    12	1. Find the cache for the service with `anyco_cmdb_lookup`. For seat holds it is the `seat-hold-cache` ElastiCache cluster.
    13	2. Query `evicted_keys` for the cluster from two hours before the alert. A rate above zero while holds are vanishing is the signal. Query it per shard.
    14	3. Query `used_memory` and compare it with the configured maximum. Memory at the limit explains evictions.
    15	4. Count the active holds. Compare the keys in the cache with the number of holds the service says it has taken. A gap means holds are being lost.
    16	5. Check the eviction policy. The expected policy for seat holds is `volatile-ttl`. Search the change feed for parameter group changes on the cluster (see `change-window-search`). A policy that fell back to `allkeys-lru` evicts live holds at peak.
    17	6. Only after steps 2 to 5, compare with a baseline. Use the same hour on the previous day and the same hour a week earlier.
    18	7. See `references/cache-metrics.md` for the metrics and what each one shows.
    19	
    20	## What to report
    21	
    22	- The `evicted_keys` and `used_memory` values with their time windows.
    23	- The eviction policy now and any change to it, with the time.
    24	- The active hold count compared with the keys in the cache.
    25	- Whether the cache is ruled in or out, and which of the numbers above is the reason.
```

**Tool result** (success):
```
     1	---
     2	name: bounded-log-query
     3	description: Use before every log search. Keeps queries inside the tool limits and records the window, the log group and the line limit with each result.
     4	---
     5	
     6	# Bounded log query
     7	
     8	`anyco_logs_search` returns at most 500 lines and times out after 60 seconds. A query that hits either limit gives a partial answer, and a partial answer can look like a clean one.
     9	
    10	## Steps
    11	
    12	1. Pick the log group first. Service log groups follow the pattern `/anyco/prod/<service>`. The `service-catalog` memory lists them.
    13	2. Pick a window of 15 minutes or less. Widen it only in steps, and only if the narrow window shows what you need.
    14	3. Filter in the query. Use the error code, the status code or the exception name instead of reading raw lines.
    15	4. Run the query. If it returns exactly 500 lines, it was cut off. Narrow the window or the filter and run it again. If it times out, halve the window.
    16	5. If it returns an access error, stop retrying. Report the log group, the role and the time, and use metrics or traces.
    17	6. Write the result down with the log group, the window in UTC and the line limit.
    18	
    19	## What to report
    20	
    21	For every query you cite: the log group, the start and end time in UTC, the filter, the number of lines returned and whether the limit or the timeout was reached.
    22	
    23	A cut-off result shows only the first 500 lines. Never state a count or an onset from a cut-off result.
```

---
## Record: message
**Created:** 2026-11-03 18:21:07.226000+00:00

**Role:** assistant

<details><summary>Thinking (210 chars)</summary>

The pattern says a client bug in the seat map page. That is a hint, not evidence. The holds live in the cache, so I will check the cache path with the cache-path-check skill before I believe either explanation.

</details>

The pattern memory points at a client bug. I will check the cache path first, because holds are stored there.

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/skills/user/cache-path-check/SKILL.md"
}
```

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/skills/user/bounded-log-query/SKILL.md"
}
```

---
## Record: message
**Created:** 2026-11-03 18:20:56.702000+00:00

**Role:** user

**Tool result** (success):
```
     1	# incident-patterns
     2	
     3	Links are relative to this index. This is the validated local index preview.
     4	
     5	- [cache-evictions](./patterns/cache-evictions.md): Why seat holds vanish early. Read when holds disappear before their TTL.
     6	- [pricing-mismatch](./patterns/pricing-mismatch.md): Why a price differs between the event page and checkout. Read when a price mismatch is reported.
     7	- [on-call-routing](./roles/on-call-routing.md): Which team to page for each service. Read before you recommend who to page.
```

**Tool result** (success):
```
     1	---
     2	name: patterns/cache-evictions
     3	description: Why seat holds vanish early. Read when holds disappear before their TTL.
     4	---
     5	
     6	Seat holds that vanish early usually come from a client bug in the seat map page.
     7	
     8	Memory: incident-patterns/patterns/cache-evictions
     9	Review this memory when an incident shows it is wrong.
```

---
## Record: message
**Created:** 2026-11-03 18:20:56.318000+00:00

**Role:** assistant

<details><summary>Thinking (177 chars)</summary>

The page says holds live in seat-hold-cache with a 10-minute TTL. Past patterns may say why holds vanish early, so I will read the incident-patterns index and the cache pattern.

</details>

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/memory/incident-patterns/INDEX.md"
}
```

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/memory/incident-patterns/patterns/cache-evictions.md"
}
```

---
## Record: message
**Created:** 2026-11-03 18:20:49.044000+00:00

**Role:** user

**Tool result** (success):
```
     1	# service-catalog
     2	
     3	Links are relative to this index. This is the validated local index preview.
     4	
     5	- [checkout-api](./services/checkout-api.md): What checkout-api does, where its logs are and who owns it. Read when an alert or ticket names checkout-api.
     6	- [fulfillment-worker](./services/fulfillment-worker.md): How fulfillment-worker consumes order-events and who owns it. Read when tickets or confirmation emails are late.
     7	- [payments-gateway](./services/payments-gateway.md): How payments-gateway reaches the ExamplePay acquirer and who owns it. Read when card payments fail or time out.
     8	- [seat-map-service](./services/seat-map-service.md): What seat-map-service does, how seat holds are stored and who owns it. Read when seat holds or the seat map misbehave.
```

**Tool result** (success):
```
     1	---
     2	name: services/seat-map-service
     3	description: What seat-map-service does, how seat holds are stored and who owns it. Read when seat holds or the seat map misbehave.
     4	---
     5	
     6	seat-map-service serves the venue seat map and seat holds. Holds live in the seat-hold-cache Redis cluster (cluster mode, 3 shards) with a 10-minute TTL. Owner: team-venue.
     7	
     8	Memory: service-catalog/services/seat-map-service
     9	Review this memory when an incident shows it is wrong.
```

---
## Record: message
**Created:** 2026-11-03 18:20:48.510000+00:00

**Role:** assistant

<details><summary>Thinking (160 chars)</summary>

Seat holds are released early during a presale. I will start with what the service catalog says about seat-map-service, then look at the cache behind the holds.

</details>

Reading the service catalog index and the seat-map-service page first.

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/memory/service-catalog/INDEX.md"
}
```

**Tool call:** `fs_read`
```json
{
  "file_path": "/aidevops/memory/service-catalog/services/seat-map-service.md"
}
```

---
## Record: message
**Created:** 2026-11-03 18:20:41.201000+00:00

**Role:** user

TITLE: INCIDENT-20201, DESCRIPTION: === Investigation Context ===
Incident Number: INCIDENT-20201
Title: INC-7301: [us-west-2] seat-map-service seat holds released early
Severity: High
Service: seat-map-service
CMDB role: seat-map-service
Alert: seat_hold_early_release_ratio above 5 percent for 10 minutes, fired 2026-11-03 18:20 UTC (10:20 PT)
===

User request: Please find the root cause of this incident.
