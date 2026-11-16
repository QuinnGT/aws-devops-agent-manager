---
name: consumer-lag-check
description: Use when tickets or confirmation emails are late, or when a Kafka consumer falls behind. Tells a stuck message on one partition from general load.
---

# Consumer lag check

`fulfillment-worker` consumes the `order-events` topic on Amazon MSK. The topic has 12 partitions. Lag on every partition means load. Lag on one partition while the others sit at zero means a stuck message.

## Steps

1. Query consumer lag per partition for the consumer group, from two hours before the first report.
2. Compare the partitions. Write down which ones are above zero and since when.
3. If only one partition is behind, its committed offset has stopped moving. Check that the offset is unchanged over at least ten minutes.
4. Search the `fulfillment-worker` logs for repeated processing errors or retries of the same offset on that partition. Look for deserialization errors and the same message ID appearing again and again.
5. Check the downstream service the worker calls, `notification-service`, for errors or limits. If it is healthy for other partitions, it is not the cause.
6. Do not blame email sending limits until you have compared the lag across partitions.

## What to report

- Lag per partition with the time window.
- The stuck partition and offset, or "all partitions behind".
- The repeated error and the log group and window where you saw it.
- What you ruled out downstream and the metric you used.
