---
name: token-signing-check
description: Use when sign-in or token validation fails for some users. Compares the key IDs in recent tokens with the keys the identity service publishes after a signing key rotation.
---

# Token signing check

`identity-service` signs tokens and publishes its public keys as a JWKS. After a key rotation, tokens signed with the old key stay valid until they expire. If the JWKS no longer lists the old key, validators reject those tokens.

## Steps

1. Find the first failure time and the error. Look for messages such as unknown key ID, signature verification failed or token rejected.
2. Query the identity service logs for the failing key ID (`kid`). Never print or store a token. Only the `kid` and the error are needed.
3. Find the key rotation. Search the change feed for identity config changes in adjacent 24-hour windows.
4. Fetch the keys the JWKS lists now and compare them with the key IDs in the failing tokens. A failing `kid` that is missing from the JWKS is the cause to confirm.
5. Check who was affected. Tokens issued before the rotation fail. New sign-ins succeed. A pattern of "only users who signed in before time T" fits.
6. If any log search on the identity namespace returns an access error, report the gap and use metrics and traces. Do not conclude that the client app is at fault.

## What to report

- The rotation time and the old and new key IDs.
- The failing key ID and the first error time.
- Whether the JWKS still lists the old key.
- Any access error, with the tool and the role that was refused.
