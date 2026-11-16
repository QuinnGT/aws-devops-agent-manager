---
name: low-sample-size-check
description: Use when a ratio alarm such as an error rate or conversion rate fires at night or on a quiet service. Counts the requests behind the ratio before you call it an outage.
---

# Low sample size check

A ratio alarm fires when errors divided by requests crosses a threshold. At night a few requests are enough. Three errors in 41 requests is 7 percent and may be nothing.

## Steps

1. Query the numerator and the denominator separately for the alarm window with `anyco_metrics_query`.
2. Write down both counts. If the denominator is below about 100, treat the ratio as unreliable.
3. Query the same window on the previous three days. If the ratio often crosses the threshold at that hour, the alarm is noisy at that hour.
4. Look at the errors themselves. Group them by endpoint and status code. A long-standing low-rate error on a retired endpoint is background noise, not the cause.
5. Check whether the errors continue after the alarm window. If traffic returned to normal and the errors stopped, the alarm cleared by itself.

## What to report

- The counts: errors, requests and the ratio.
- The comparison with the previous days at the same hour.
- Whether you found a real failure. If you did not, say that the alarm fired on a small sample, and name the threshold or the minimum count that would have avoided it.
