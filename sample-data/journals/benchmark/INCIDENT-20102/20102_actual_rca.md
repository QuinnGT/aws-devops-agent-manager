# INCIDENT-20102 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20102
- **Title**: INC-3102: Card payments declining for one acquirer
- **Date**: 2026-10-27
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Payments
- **Service (CMDB role)**: checkout-api
- **Root cause type**: External dependency

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

ExamplePay rotated the certificate authority behind its mutual-TLS endpoint at 14:45 UTC. payments-gateway did not trust the new chain and rejected every handshake, so every card charge through ExamplePay failed fast. checkout-api returned HTTP 502 with code PGW_UPSTREAM. Release 231 of checkout-api was not involved.

## Timeline (PT)

- Tue 2026-10-27 07:45: ExamplePay switches to the new CA, as announced on its status page 14 days earlier.
- 07:46: payments-gateway logs `PKIX path building failed` for every call to `api.examplepay.example.net`. checkout-api starts returning HTTP 502 PGW_UPSTREAM.
- 07:52: checkout-api release 231 goes live (unrelated).
- 08:12: the alarm "checkout-api card charge failure ratio above 15 percent" fires. The DevOps Agent run starts at 08:13.
- 08:20: team-payments finds the TLS errors in `/anyco/prod/payments-gateway`.
- 08:34: the new CA bundle is added to the trust store and payments-gateway is redeployed.
- 08:41: the charge failure ratio returns to 0.005.

## Actual Root Cause

payments-gateway trusted only the old ExamplePay CA chain. After the rotation the gateway rejected the new chain (`javax.net.ssl.SSLHandshakeException: PKIX path building failed`). The failure happened at connect time, so charges failed in about 20 ms and the gateway latency metric stayed flat.

## Trigger

A planned vendor change. ExamplePay announced the rotation on its status page and by email to a distribution list that team-payments no longer monitors. Nobody updated the trust store.

## Fix

- Add the new ExamplePay CA bundle to the gateway trust store (done 08:34 PT).
- Redeploy payments-gateway.

## Follow-ups

- Subscribe team-payments to the ExamplePay status page and email notices (team-payments).
- Alarm on `ssl_handshake_failed` greater than 0 in payments-gateway (team-payments).
- Document the CA bundle update steps in the payments-gateway runbook (team-payments).
