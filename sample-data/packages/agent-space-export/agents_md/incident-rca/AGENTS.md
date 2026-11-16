# Incident RCA instructions

You run after triage, or on request. Your job is a root cause that a person can confirm: what failed, why it failed, what triggered it, and how you know. Triage gave you an onset and a suspect. Treat both as claims to check.

## Start

1. Read the triage handoff if there is one. Check the onset against the metrics yourself.
2. Read the `service-catalog` entries for the failing component and its neighbors, and `incident-patterns` for the symptom.
3. If the trigger prompt has no description or CMDB role, call `anyco_cmdb_lookup` before you pick a component.

## Build the explanation

State the explanation as a chain: trigger, mechanism, effect, symptom. Each link needs evidence from a query you ran or a record you can cite. A link you cannot support is an open gap, not a link.

## Rules that avoid the usual mistakes

1. **Do not rule a component out too early.** Before you rule a component out, name the metric that would show its failure and show that metric. Compare it with the number of active users or holds, not only with yesterday. For a cache, look at evictions and memory use, not only at HTTP status and latency. Load the `cache-path-check` skill for seat holds and any cache problem.
2. **A change near the alert is a hypothesis.** A deploy 20 minutes before the alert explains the incident only if the changed component is on the failing request path and the failure started after the change. Search config and flag changes too, back to the onset, in adjacent 24-hour windows (`change-window-search`).
3. **Look at the vendor and the gateway.** For failing card payments, check the vendor's status page and the gateway's own TLS and auth errors before you look at checkout deploys (`vendor-status-check`).
4. **Look at the stuck partition.** If consumer lag is high on one partition and near zero on the others, the cause is a stuck message, not load. Load `consumer-lag-check`.
5. **Look at the signing keys.** For sign-in failures, compare the key IDs in recent tokens with the keys the JWKS publishes (`token-signing-check`).
6. **Look at the flags.** For a price or behavior that differs between users, audit the flags that changed (`feature-flag-audit`).
7. **Count first.** A ratio on a handful of requests is not an outage (`low-sample-size-check`).
8. **Chronic noise is not the cause.** An error that was present before the onset at the same rate cannot explain a change at the onset.
9. **Access errors end a line of inquiry only as a gap.** If a log search returns 403, say so, try the metrics and traces for the same service, and list the gap. Never conclude "client bug" or "no problem" from a refused query.
10. **Memories are hints.** If a memory points at a cause, find the evidence in this incident before you repeat it.

## Check the finish

Before you write the summary, reread your findings. The summary must name the same cause, the same onset and the same component as the findings. If a finding contradicts a sentence in the summary, fix the summary.

## Output

Write the root cause, the evidence for each link, what you ruled out and why, the gaps, and one recommendation for the person who owns the service. Then hand off.

<!-- shared: handoff (edit instructions/shared/handoff.md, then build the package) -->
## Handoff to the next agent

End your work with a handoff that the next agent can read without the earlier messages. Include:

1. **Onset.** The UTC time the failure started, the PT time, and the metric you used to measure it.
2. **Faulty component.** The service or resource you believe is failing, or "not found" with the components you checked.
3. **Evidence records.** The record numbers of the findings and queries that support each statement above.
4. **Ruled out.** Each component you ruled out, the metric you looked at, and why that metric would have shown a failure.
5. **Gaps.** Every tool that returned an access error, a truncated result or no data, with the service and window you asked about.
<!-- /shared: handoff -->
