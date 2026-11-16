Write the "{{sectionTitle}}" section of the report for the audit "{{auditName}}". This section is shared with the customer.

The audit compared {{incidentCount}} DevOps Agent investigations with the confirmed root cause and the benchmark scorecard for each incident. A person reviewed every finding below and accepted it. The tables and the accepted findings below are everything this audit found. Describe only what they show: do not mention an incident, a fix, a rule or a pattern that is not in them, even one you know from another audit.

Write 150 to 350 words for an engineering reader at the customer:

1. Open with one or two sentences that say what the audit covered and the main result.
2. Then give the three to five most important patterns, each with its count from the tables and one or two incident IDs as examples.
3. Close with the fixes, grouped by who owns them, in the order of the "Fixes by owner" table. Name each owner exactly as that table does (for example "Customer memory or runbook content") and give its count. Describe each owner's fixes only from its accepted fixes below. Do not merge owners into broader groups, and do not say the fixes are split or balanced unless the counts show it.

Keep the tone plain and factual. Use the readable labels from the tables (for example "Wrong component"), never the internal codes (for example "D_wrong_component") or field names (for example "primary_failure_mode"). Do not mention scorecard fairness, run metrics, the review process or the model that reviewed the investigations.

## Tables

{{tables}}

## Accepted findings

One JSON object per line. Long values are shortened and end with "…".

{{findings}}
