---
name: vendor-status-check
description: Use when card payments fail for one acquirer or when errors come from a third party. Checks the vendor status page and the gateway's own TLS and auth errors before blaming a deploy.
---

# Vendor status check

`payments-gateway` calls the ExamplePay acquirer over mutual TLS. When charges fail, the cause is often on ExamplePay's side or in the connection to it, not in a recent `checkout-api` deploy.

## Steps

1. Read the error code on the failing requests. `checkout-api` shows a failure from the gateway as HTTP 502 with `PGW_UPSTREAM`.
2. Open ExamplePay's status page at https://status.examplepay.example.net and note any incident, its start time and what it says changed.
3. Search the `payments-gateway` logs with `anyco_logs_search` for TLS and auth errors in the hour around the onset. Look for certificate chain errors such as `PKIX path building failed`, handshake failures and 401 or 403 responses from the acquirer.
4. Compare the first TLS or auth error with the onset of the failures. They should start together.
5. Only then look at deploys. Check whether the changed component is on the payment path. A `checkout-api` deploy that does not touch payment calls is not the cause.

## What to report

- The status page entry, with its time, or "no entry" with the time you looked.
- The first gateway error of each kind, with its time and the log group and window you searched.
- Whether the failures are limited to one acquirer.
- Which deploys you set aside and why.
