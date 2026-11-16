# INCIDENT-20101 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20101
- **Title**: INC-3101: Seat holds released early during an on-sale
- **Date**: 2026-10-26
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Caching and Data
- **Service (CMDB role)**: seat-map-service
- **Root cause type**: Configuration

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

Seat holds in the `seat-hold-cache` Redis cluster were evicted before their 10-minute TTL during the Harbor Lights on-sale. The cache had lost its `maxmemory-policy volatile-ttl` setting in a parameter group change two days earlier and fell back to `allkeys-lru`. When the on-sale opened, memory filled and Redis evicted live holds. The seat map page release (412) and the change feed were not involved.

## Timeline (PT)

- Sun 2026-10-25 14:36: the pipeline run `infra-cache #4412` applies a change to the parameter group `seat-hold-cache-params`. The `maxmemory-policy` line is removed, so the cluster uses its default `allkeys-lru`.
- Mon 2026-10-26 09:00: the Harbor Lights queue opens.
- Mon 10:00: the on-sale opens and seat map traffic rises about 6 times.
- Mon 10:02: `used_memory` reaches `maxmemory` on two of three shards. `evicted_keys` rises from 0 to about 14,000 per minute.
- Mon 10:12: the first customer reports on social media that a held seat vanished.
- Mon 10:42: the alarm "seat-map-service hold loss ratio above 5 percent" fires. The DevOps Agent run starts at 10:43.
- Mon 10:58: team-venue sees `evicted_keys` and the parameter group difference.
- Mon 11:12: `maxmemory-policy volatile-ttl` is restored. Evictions drop to 0 within two minutes.

## Actual Root Cause

A change to the parameter group `seat-hold-cache-params` removed `maxmemory-policy volatile-ttl`. Without it, ElastiCache used `allkeys-lru`. Under on-sale memory pressure Redis evicted seat holds that were still inside their TTL. seat-map-service kept returning HTTP 200 because a missing hold is a valid empty answer, so status codes and latency stayed flat.

## Trigger

**Unknown.** The parameter group change came from pipeline run `infra-cache #4412`. The run has no linked ticket, review or commit message beyond "cleanup cache params", and the author has not been identified. The team has not confirmed whether removing the line was intended. This part of the root cause is uncertain.

## Fix

- Restore `maxmemory-policy volatile-ttl` in `seat-hold-cache-params` (done 11:12 PT).
- Add the setting to the Terraform module as a required value.

## Follow-ups

- Alarm on `evicted_keys` greater than 0 for `seat-hold-cache` (team-venue).
- Add a plan check that rejects removing cache policy settings (team-venue).
- Load test the cache at on-sale volume before the next on-sale (team-venue).
- Find out who removed the line and why (team-venue, open).
