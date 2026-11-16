# INCIDENT-20108 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20108
- **Title**: INC-3108: Venue maps not loading for some users
- **Date**: 2026-11-01
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Edge and content
- **Service (CMDB role)**: venue-cdn
- **Root cause type**: Configuration and replication

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

During the Winter Classic on-sale, the primary map bucket `venue-maps-primary` returned S3 503 SlowDown for the hot prefix `maps/2026-q4/`. The CloudFront origin group of `venue-cdn` failed over to `venue-maps-secondary`. That bucket had not received any object since 2026-10-28 09:14 UTC, because replication stopped after an IAM policy change. Requests for the 605 newer maps returned 404. Users were not limited to one region.

## Timeline (PT)

- Wed 2026-10-28 02:12 (PDT): the policy of `venue-maps-replication-role` is edited. The permission to replicate into the secondary bucket is removed by mistake. Replication stops silently.
- Sun 2026-11-01 10:00 (PST): the Winter Classic on-sale opens. Map requests reach about 5,500 per second on the prefix `maps/2026-q4/`.
- 10:18: the primary bucket returns 503 SlowDown. CloudFront fails over per request. The 4xx rate rises from 0.2 to 6.8 percent.
- 10:40: the alarm "venue map load failure ratio above 3 percent" fires. The DevOps Agent run starts at 10:41.
- 11:05: team-edge finds `origin=venue-maps-secondary` on every 404 line and the missing objects.
- 11:25: the 605 objects are copied to the secondary with S3 Batch Replication. 404 responses stop.
- 11:48: the replication role policy is restored.

## Actual Root Cause

The failover target was incomplete. The origin group did what it was built to do when the primary returned 503, but the secondary bucket was missing every map published after replication stopped. The throttling of the primary was a symptom of the on-sale load on a single prefix. Neither a network issue nor a CDN fault was involved.

## Trigger

Two causes together: a replication IAM policy edit on 2026-10-28 that went unnoticed for four days, and the on-sale load on one S3 prefix.

## Fix

- Copy the 605 missing objects to the secondary bucket (done 11:25 PT).
- Restore the replication role policy (done 11:48 PT).
- Spread maps over more prefixes before the next on-sale.

## Follow-ups

- Alarm on `ReplicationLatency` and on `OperationsFailedReplication` for both buckets (team-edge).
- Alarm on `origin_failover_requests` greater than 0 for 5 minutes (team-edge).
- Add a weekly check that counts objects in both buckets (team-edge).
