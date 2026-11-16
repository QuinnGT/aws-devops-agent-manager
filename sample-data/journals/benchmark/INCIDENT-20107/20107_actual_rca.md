# INCIDENT-20107 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20107
- **Title**: INC-3107: Checkout error-rate alarm at 03:10 PT
- **Date**: 2026-10-31
- **Severity**: Low
- **Region**: us-west-2
- **Domain**: Checkout
- **Service (CMDB role)**: checkout-api
- **Root cause type**: Alarm configuration

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

There was no outage. At 03:10 PT checkout-api handled 41 requests in the five minute alarm window. Three of them were 404 responses on the retired route `POST /v1/coupons/redeem`, called by old mobile clients, as on every day. 3 of 41 is 7.3 percent, above the 5 percent alarm threshold. The alarm has no minimum request count, so a handful of requests at night can trip it.

## Timeline (PT)

- Sat 2026-10-31 02:40: one 404 on the retired route. Ratio 2 percent, no alarm (alarm needs 5 minutes above 5 percent).
- 02:55: one more 404, ratio 2.5 percent.
- 03:05 to 03:10: three 404 responses in a window with 41 requests. Ratio 7.3 percent.
- 03:10: the alarm "checkout-api error rate above 5 percent for 5 minutes" fires. The DevOps Agent run starts at 03:11.
- 03:25: the on-call engineer reads the alarm, sees 41 requests and closes the incident as noise.

## Actual Root Cause

Not an incident. The alarm is a ratio without a minimum request count. In daytime the same 404 calls (about 40 per day) are under 0.1 percent of traffic. At 03:10 PT the traffic is 40 to 50 requests per five minutes, so three errors cross the threshold.

## Trigger

Normal night traffic and a chronic, harmless 404 on a retired route. No change was made.

## Fix

- No production fix is needed.
- Change the alarm to require at least 200 requests in the window.

## Follow-ups

- Alarm with a minimum request count (team-checkout).
- Count 404 on retired routes separately from the error ratio (team-checkout).
- Remove the coupon call from mobile 5.9.x in the next release (team-mobile).
