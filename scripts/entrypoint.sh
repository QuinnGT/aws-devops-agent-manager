#!/bin/sh
# Container entrypoint: `web` runs migrations then the Next.js server; `worker` runs the job worker;
# `demo-seed` migrates, then fills the database with the sample space unless that was done before.
set -eu
case "${1:-web}" in
  web)
    node dist/migrate.mjs
    # Next.js standalone reads HOSTNAME; DAM_HOST is the single source of truth.
    export HOSTNAME="${DAM_HOST:-127.0.0.1}"
    exec node server.js
    ;;
  worker)
    export DAM_PROCESS=worker
    exec node dist/worker.mjs
    ;;
  demo-seed)
    node dist/migrate.mjs
    # The seed empties the database it is pointed at, so a finished seed leaves a marker next to the
    # history repository (same volume) and a later start leaves the demo as it is. A seed that failed
    # leaves no marker, and the next start runs it again from scratch.
    marker="${DAM_DATA_DIR:-/data}/.demo-seeded"
    if [ -e "$marker" ]; then
      echo "[demo-seed] already seeded, leaving the demo as it is"
      exit 0
    fi
    node dist/demo-seed.mjs
    : > "$marker"
    ;;
  *)
    exec "$@"
    ;;
esac
