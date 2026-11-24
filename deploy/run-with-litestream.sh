#!/bin/sh
# Single-container mode, for hosts without a backup sidecar (Render): restore the database from the
# Litestream replica when the disk has none, then run the server under Litestream so every write is
# replicated. Litestream forwards signals to the server and exits when it does.
#
# Use as the container command: omb-with-litestream   (needs the LITESTREAM_* variables from .env.example)
set -eu
: "${LITESTREAM_BUCKET:?set LITESTREAM_BUCKET and the other LITESTREAM_* variables, or run the plain server command}"
CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
# Must match the path in litestream.yml.
DB=/data/openmessageboard.db
EFFECTIVE="${OMB_DB_PATH:-${OMB_DATA_DIR:-/data}/openmessageboard.db}"
if [ "$EFFECTIVE" != "$DB" ]; then
  echo "omb-with-litestream: the server would use $EFFECTIVE, but litestream.yml replicates $DB" >&2
  exit 1
fi
# Only acts when the disk has no database. LITESTREAM_RESTORE_TIMESTAMP picks a point in time for that restore.
if [ -n "${LITESTREAM_RESTORE_TIMESTAMP:-}" ]; then
  litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists -timestamp "$LITESTREAM_RESTORE_TIMESTAMP" "$DB"
else
  litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB"
fi
exec litestream replicate -config "$CONFIG" -exec "node /app/server/dist/cli.js serve"
