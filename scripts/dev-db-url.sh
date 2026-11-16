#!/bin/sh
# Prints the connection URL for a database on the local dev Postgres (compose.dev.yaml),
# reading the password from .env so it never has to be typed or pasted.
# Usage: export TEST_DATABASE_URL="$(scripts/dev-db-url.sh dam_sync)"
set -eu
db="${1:-dam}"
case "$db" in *[!a-z0-9_]*) echo "invalid database name: $db" >&2; exit 2;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
envfile="${DAM_ENV_FILE:-$root/.env}"
pass="$(sed -n 's/^DAM_DEV_POSTGRES_PASSWORD=//p' "$envfile")"
[ -n "$pass" ] || { echo "DAM_DEV_POSTGRES_PASSWORD missing in $envfile" >&2; exit 1; }
printf 'postgres://dam:%s@127.0.0.1:55432/%s\n' "$pass" "$db"
