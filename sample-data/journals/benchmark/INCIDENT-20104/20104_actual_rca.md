# INCIDENT-20104 - Actual Root Cause (Ground Truth)

- **Incident**: INCIDENT-20104
- **Title**: INC-3104: Mobile sign-in failures
- **Date**: 2026-10-29
- **Severity**: High
- **Region**: us-west-2
- **Domain**: Identity
- **Service (CMDB role)**: identity-service
- **Root cause type**: Configuration

> Confirmed root cause from the incident review, used as the benchmark the DevOps Agent was scored against.

---

## Summary

identity-service rotated its signing key at 13:40 PT and published a JWKS that no longer contained the previous key. Access tokens signed before the rotation could not be validated by mobile-bff and returned HTTP 401. Users who signed in after 13:40 PT were not affected. The mobile app 6.3.x and mobile-bff release 54 were not involved.

## Timeline (PT)

- Thu 2026-10-29 13:40: the scheduled job `identity-keys-rotate` creates signing key `k-2026-10` and publishes the JWKS with that key only.
- 13:41: mobile-bff starts rejecting access tokens with `kid=k-2026-09` (`invalid signature: unknown kid`). The mobile app shows "Sign in failed".
- 13:50: the sign-in failure ratio climbs from 0.02 to 0.14 as older sessions are restored.
- 14:10: the alarm "mobile sign-in failure ratio above 10 percent" fires. The DevOps Agent run starts at 14:11.
- 14:26: team-identity finds `unknown kid` in `/anyco/prod/identity-service`.
- 14:40: the JWKS is republished with both keys. Failures stop within five minutes.

## Actual Root Cause

After the rotation the JWKS listed only the new key. The previous key must stay in the JWKS for at least the token lifetime plus a margin (24 hours at AnyCompany). Tokens issued before 13:40 PT still carried the previous `kid`, so validation failed.

## Trigger

The monthly rotation job ran with a new version of the key tool (`keyctl` 2.0, deployed on 2026-10-22). In that version `retain_previous` defaults to `false`. The old version kept the previous key.

## Fix

- Republish the JWKS with the previous key (done 14:40 PT).
- Set `retain_previous=true` and `retain_hours=24` explicitly in the rotation job.

## Follow-ups

- Alarm on token validation failures with `unknown kid` greater than 50 per minute (team-identity).
- Give the DevOps Agent role read access to the identity-service log group and the `AnyCompany/identity-service` metrics (team-identity).
- Add a rotation dry run that validates a token signed with the previous key (team-identity).
