# INCIDENT-20105 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20105
- **Title**: INC-3105: New events missing from search
- **Date**: 2026-10-30
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Search
- **Service (CMDB role)**: search-api
- **Root cause type**: Configuration

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

Release 129 of search-indexer added the field `doors_open_local` to event documents and sent it as a free-text string. The index `events-v7` already mapped that field as `date`, left by a test document in September. OpenSearch rejected every document with the new field (`mapper_parsing_exception`). The indexer treated the rejection as retriable, retried each batch with growing delays and logged an ERROR only after the last attempt, at 12:25 UTC. The domain's software update at 11:41 UTC was not involved.

## Timeline (PT)

- Fri 2026-10-30 04:40: release 129 of search-indexer is deployed.
- 04:41: the managed software update of `events-search` finishes (unrelated).
- 04:52: the first event with `doors_open_local` is published. The bulk batch 8841 is rejected and retried.
- 05:00: the canary alarm "published event missing from the index after 10 minutes" fires. The DevOps Agent run starts at 05:06.
- 05:25: after the fifth attempt the indexer logs `ERROR bulk item rejected: mapper_parsing_exception` for the first time.
- 05:31: team-search reads the error and finds the mapping conflict.
- 05:48: release 130 sends `doors_open_local` as a date. The failed batches are replayed.
- 06:10: the backlog is empty and the canary is visible.

## Actual Root Cause

A mapping conflict on `doors_open_local`: the index maps it as `date` and the indexer sent text. OpenSearch rejected the documents and the indexer retried them instead of dead-lettering them, so the missing events were not logged as errors until 33 minutes after the first rejection.

## Trigger

Release 129 of search-indexer, deployed at 04:40 PT, with a new field that was not checked against the live mapping.

## Fix

- Release 130 sends `doors_open_local` as an ISO date (done 05:48 PT).
- Replay the failed batches.

## Follow-ups

- Log the first rejection of a bulk item at WARN with the reason (team-search).
- Add a mapping check to the indexer release pipeline (team-search).
- Remove the September test document and fix the mapping drift in `events-v7` (team-search).
