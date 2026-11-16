# INCIDENT-20103 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20103
- **Title**: INC-3103: Order confirmation emails delayed
- **Date**: 2026-10-28
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Messaging
- **Service (CMDB role)**: notification-service
- **Root cause type**: Data / message

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

One malformed record on partition 7 of the `order-events` topic made fulfillment-worker retry the same message forever. No other message on partition 7 was processed, so about 8 percent of orders (the share that hash to partition 7) got no ticket and no confirmation email until the message was skipped. Lag grew on partition 7 only. SES and notification-service were healthy.

## Timeline (PT)

- Wed 2026-10-28 11:19: a one-off backfill script run by team-fulfillment publishes one record to `order-events` with schema version 3. The record lands on partition 7 at offset 4118902.
- 11:19: worker-3 (partition 7) throws `DeserializationException: unknown schema version 3 for OrderPlaced` and retries every 30 to 60 seconds. It never moves the offset.
- 11:20: lag on partition 7 starts to grow at about 25 messages per minute. The other 11 partitions stay near 0.
- 11:55: the alarm "order confirmation email delay p95 above 10 minutes" fires. The DevOps Agent run starts at 11:56.
- 12:07: team-fulfillment finds the exception in `/anyco/prod/fulfillment-worker`.
- 12:14: the consumer offset is moved past 4118902. Partition 7 drains in 6 minutes.
- 12:21: all delayed confirmation emails are sent.

## Actual Root Cause

A message that fulfillment-worker could not deserialize blocked partition 7. The consumer retries a failed message without limit and has no dead-letter topic, so one bad record stops the partition. Notification-service only receives requests for orders that were processed, so its own latency stayed flat at about 1.2 seconds.

## Trigger

A backfill script was run against production with a newer schema version than the consumers accept. The script had no schema check.

## Fix

- Move the consumer offset for partition 7 past the bad record (done 12:14 PT).
- Send records that fail 5 times to a dead-letter topic instead of retrying forever.

## Follow-ups

- Alarm on consumer lag per partition greater than 200 for 5 minutes (team-fulfillment).
- Add a schema version check to the backfill script (team-fulfillment).
- Raise the SES sending rate limit anyway; the account runs at 99 percent of its limit at peak (team-fulfillment).
