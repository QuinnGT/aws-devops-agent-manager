# INCIDENT-20106 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20106
- **Title**: INC-3106: Price at checkout differs from the event page
- **Date**: 2026-10-30
- **Severity**: Medium
- **Region**: us-west-2
- **Domain**: Pricing
- **Service (CMDB role)**: pricing-service
- **Root cause type**: Feature flag and cache

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

team-pricing turned on the flag `dynamic-pricing-v2` for 10 percent of traffic at 15:30 UTC. pricing-service cached prices per event and section without the flag variant in the cache key. For the 10 percent cohort the event page showed a v2 price and checkout read a v1 price from the shared cache entry, so the two differed by 4 to 12 currency units. The CDN cache was not involved.

## Timeline (PT)

- Fri 2026-10-30 08:30: team-pricing enables `dynamic-pricing-v2` at 10 percent.
- 08:36: the first `price_mismatch` line appears in checkout-api (variant=v2).
- 09:21: customer support opens the incident. The DevOps Agent run starts at 09:22.
- 09:40: team-pricing sees `variant=v2` on every mismatch line.
- 09:52: the flag is set to 0 percent. New mismatches stop.
- 10:05: the pricing-service cache for the cohort is flushed. Entries computed under v2 disappear from checkout.

## Actual Root Cause

The pricing-service cache key was `event:section` and did not include the flag variant. Cohort members and other customers shared entries, so checkout often read a price computed for the other variant. venue-cdn only passed through what the page API returned.

## Trigger

Enabling `dynamic-pricing-v2` for 10 percent of traffic without a cache key change.

## Fix

- Flag set to 0 percent (done 09:52 PT).
- Flush the pricing-service cache (done 10:05 PT).
- Add the variant to the cache key before the flag is enabled again.

## Follow-ups

- Test flag rollouts against the price cache in the staging environment (team-pricing).
- Log the flag variant in every checkout price line, as `price_mismatch` already does (team-pricing).
- Create incidents from support with the CMDB role filled in (support operations).
