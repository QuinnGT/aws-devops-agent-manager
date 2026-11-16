---
name: change-window-search
description: Use when you need to know what changed before an incident. Searches the change feed in adjacent 24-hour windows back to the onset and past it, covering deploys, config changes and flag changes.
---

# Change window search

`anyco_changes_list` returns one day of events per query. A single query for the day of the alert misses anything that changed the day before, so search window by window.

## Steps

1. Take the onset time from triage, or measure it yourself with `anyco_metrics_query`. If you only have the alert time, start two hours before it.
2. Query the 24 hours that end at the alert time. Write down the window you used.
3. Query the previous 24-hour window, then the one before it, until you reach a window with no events of any kind or you are 72 hours before the onset. Search weekends and holidays like any other day. An empty weekend is not the end of the search.
4. Read all three event kinds: deploys, config changes (parameter groups, task definitions, gateway settings) and feature flag changes.
5. For each event, record the time in UTC, the component it touches, who made it, and whether that component is on the failing request path. Use `anyco_cmdb_lookup` for the path.
6. Order the events by time. A change that happened after the onset cannot be the trigger.

## What to report

- The windows you searched, as start and end times in UTC.
- Each candidate change, with its time, component and author.
- The changes you set aside, and the reason for each: not on the request path, or after the onset.
- Any window where the tool returned an error or no data.

Say "no changes found" only when you list the windows you searched.
