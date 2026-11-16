---
name: bounded-log-query
description: Use before every log search. Keeps queries inside the tool limits and records the window, the log group and the line limit with each result.
---

# Bounded log query

`anyco_logs_search` returns at most 500 lines and times out after 60 seconds. A query that hits either limit gives a partial answer, and a partial answer can look like a clean one.

## Steps

1. Pick the log group first. Service log groups follow the pattern `/anyco/prod/<service>`. The `service-catalog` memory lists them.
2. Pick a window of 15 minutes or less. Widen it only in steps, and only if the narrow window shows what you need.
3. Filter in the query. Use the error code, the status code or the exception name instead of reading raw lines.
4. Run the query. If it returns exactly 500 lines, it was cut off. Narrow the window or the filter and run it again. If it times out, halve the window.
5. If it returns an access error, stop retrying. Report the log group, the role and the time, and use metrics or traces.
6. Write the result down with the log group, the window in UTC and the line limit.

## What to report

For every query you cite: the log group, the start and end time in UTC, the filter, the number of lines returned and whether the limit or the timeout was reached.

A cut-off result shows only the first 500 lines. Never state a count or an onset from a cut-off result.
