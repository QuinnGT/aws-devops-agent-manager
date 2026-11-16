---
name: vendor-status-check
description: Use when card payments fail for one acquirer or when errors come from a third party. Checks the vendor status page and recent deploys of the calling service.
---

# Vendor status check

`payments-gateway` calls the ExamplePay acquirer. When charges fail, find out whether the problem is on ExamplePay's side or in a recent deploy.

## Steps

1. Read the error code on the failing requests. `checkout-api` shows a failure from the gateway as HTTP 502.
2. Open ExamplePay's status page at https://status.examplepay.example.net and note any incident.
3. List the deploys of `checkout-api` in the hour before the alert.
4. If a deploy happened shortly before the failures started, treat it as the likely cause.

## What to report

- The status page entry, or "no entry".
- The deploys you found, with their times.
