# INCIDENT-20104 - DevOps Agent Investigation Journal

- **Incident**: INCIDENT-20104
- **Title**: INC-3104: Mobile sign-in failures
- **Date**: 2026-10-29
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Identity
- **Service (CMDB role)**: identity-service
- **Root cause type**: Configuration

> This is the DevOps Agent's own investigation output (journal / RCA) for this incident, captured from the benchmark report.

---

## Root Cause Summary
Mobile sign-in fails with 401 in mobile-bff across all app versions. The most likely cause is a client side session refresh bug in the 6.3 app line, which reached 100 percent rollout at 18:00 UTC. identity-service logs, metrics, traces and the audit log group returned 403, so the identity side is unverified. Recommended action: pause the 6.3.1 rollout and ask users to update or sign in again. Confidence: low.
