---
name: feature-flag-audit
description: Use when behavior or a price differs between users, or when a change in rollout may explain an incident. Lists the flags that changed and the share of traffic each one reaches.
---

# Feature flag audit

Feature flags change behavior without a deploy. They are served by the `flags` service and used by `pricing-service` and others. A flag that reaches part of the traffic produces a problem that only part of the users see.

## Steps

1. Query `anyco_changes_list` for flag changes in the 24 hours before the first report, then in adjacent windows back to the last quiet day.
2. For each changed flag, note the time, the new value, the share of traffic or the cohort it reaches, and who changed it.
3. Match the flag to the component. Use `anyco_cmdb_lookup` to see which services read it.
4. Compare the affected users with the flag's cohort. If the problem appears only for users in the cohort, the flag is a strong candidate.
5. Check the cache in front of the flagged component. A stale cache for one cohort can keep serving the old value after the flag changes.
6. Do not blame a CDN or an edge cache until you have ruled the flag out.

## What to report

- Each flag change in the window: flag name, time, value and cohort.
- Which flag matches the affected users, and how you matched them.
- Whether a cache served stale values to that cohort, with the evidence.
