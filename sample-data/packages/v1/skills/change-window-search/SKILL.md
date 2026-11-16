---
name: change-window-search
description: Use when you need to know what changed before an incident. Searches the change feed for deploys, config changes and flag changes around the alert.
---

# Change window search

`anyco_changes_list` returns events from the change feed. Use it to find what changed shortly before the alert.

## Steps

1. Take the alert time, or the onset if triage gave one.
2. Query the change feed for the day of the alert.
3. Read all three event kinds: deploys, config changes and feature flag changes.
4. For each event, record the time in UTC, the component it touches and who made it.
5. Order the events by time. A change that happened after the onset cannot be the trigger.

## What to report

- The day you searched.
- Each candidate change, with its time, component and author.
- "No changes found" if the feed was empty.
