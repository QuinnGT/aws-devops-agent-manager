---
name: bounded-log-query
description: Use before every log search. Keeps queries inside the tool limit.
---

# Bounded log query

`anyco_logs_search` returns at most 500 lines. Keep every query small enough to stay under that limit.

## Steps

1. Pick the log group first. Service log groups follow the pattern `/anyco/prod/<service>`.
2. Pick a window of 15 minutes or less.
3. Filter in the query. Use the error code, the status code or the exception name.
4. If a query returns 500 lines, narrow the window or the filter and run it again.

## What to report

The log group, the window and the number of lines returned.
