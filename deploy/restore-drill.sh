#!/usr/bin/env bash
# Restore drill: proves the Litestream replica brings back a working server.
#
# 1. Restores the latest replica (or a point in time) into a new scratch directory.
# 2. Checks the restored file with SQLite's integrity check and counts what it holds.
# 3. Boots a throwaway server on it, on its own port, on an internal Docker network with no internet
#    access, so the restored copy can't send email, webhooks or sync messages to real people. It uses the
#    email sign-in provider (without SMTP) because it has no external identity provider.
# 4. Checks /healthz and /.well-known/openmessageboard and prints a report.
#
# It never mounts or reads the live data volume or directory; only the replica in object storage.
# Needs Docker, the server image, and an env file with the LITESTREAM_* settings (and OMB_SECRET).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$HERE/.env}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-$HERE/litestream.yml}"
OMB_IMAGE="${OMB_IMAGE:-openmessageboard:local}"
LITESTREAM_IMAGE="${LITESTREAM_IMAGE:-litestream/litestream:0.3.13}"
# The database path as written in litestream.yml; it selects the replica, nothing is read from it.
REPLICA_DB_PATH="${REPLICA_DB_PATH:-/data/openmessageboard.db}"
DRILL_PORT="${DRILL_PORT:-18787}"
DRILL_ROOT="${DRILL_ROOT:-$HOME/.cache/omb-restore-drill}"
TIMESTAMP=""
KEEP=0

usage() {
  cat <<EOF
Usage: deploy/restore-drill.sh [--env-file FILE] [--image IMAGE] [--timestamp RFC3339] [--keep]

  --env-file FILE     Env file with LITESTREAM_* and OMB_SECRET (default: deploy/.env)
  --image IMAGE       Server image to boot (default: $OMB_IMAGE)
  --timestamp TIME    Restore to a point in time, e.g. 2026-11-20T09:00:00Z (default: latest)
  --keep              Keep the scratch directory for inspection

Environment overrides: LITESTREAM_CONFIG, LITESTREAM_IMAGE, REPLICA_DB_PATH, DRILL_PORT, DRILL_ROOT.
Exit status is 0 only when the restore and every check pass.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --image) OMB_IMAGE="$2"; shift 2 ;;
    --timestamp) TIMESTAMP="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '[restore-drill] %s\n' "$*" >&2; }
die() { say "FAILED: $*"; exit 1; }

command -v docker >/dev/null || die "docker is required"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable"
[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE"
[ -f "$LITESTREAM_CONFIG" ] || die "Litestream config not found: $LITESTREAM_CONFIG"
docker image inspect "$OMB_IMAGE" >/dev/null 2>&1 || die "server image $OMB_IMAGE not found; build it with: docker build -t $OMB_IMAGE ."

mkdir -p "$DRILL_ROOT"
SCRATCH="$(mktemp -d "$DRILL_ROOT/run.XXXXXX")"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
# A brand-new, empty directory is the only place anything is written.
[ -z "$(ls -A "$SCRATCH")" ] || die "scratch directory is not empty: $SCRATCH"
case "$SCRATCH" in
  /data|/data/*) die "refusing to use $SCRATCH: it looks like a live data directory" ;;
esac
if [ -n "${OMB_DATA_DIR:-}" ] && [ -d "$OMB_DATA_DIR" ]; then
  LIVE="$(cd "$OMB_DATA_DIR" && pwd -P)"
  case "$SCRATCH/" in "$LIVE"/*) die "refusing to restore inside the live data directory $LIVE" ;; esac
fi

RUN_ID="omb-restore-drill-$(date +%s)-$$"
NETWORK="$RUN_ID"
SERVER="$RUN_ID-server"
USER_ARGS=(--user "$(id -u):$(id -g)")

cleanup() {
  docker rm -f "$SERVER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ "$KEEP" = 1 ]; then say "kept scratch directory: $SCRATCH"; else rm -rf "$SCRATCH"; fi
}
trap cleanup EXIT

# OMB_SECRET decrypts integration secrets and keeps sessions valid; use the production value when present.
SECRET="$(sed -n 's/^OMB_SECRET=//p' "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
SECRET_NOTE="production OMB_SECRET"
if [ -z "$SECRET" ]; then
  SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-48)"
  SECRET_NOTE="no OMB_SECRET in $ENV_FILE: used a throwaway secret, so stored integration secrets would not decrypt"
  say "warning: $SECRET_NOTE"
fi

# ---------- 1. restore ----------
say "restoring ${TIMESTAMP:-the latest replica} into $SCRATCH"
START=$(date +%s)
RESTORE_ARGS=(restore -config /etc/litestream.yml -o /restore/openmessageboard.db)
[ -n "$TIMESTAMP" ] && RESTORE_ARGS+=(-timestamp "$TIMESTAMP")
RESTORE_ARGS+=("$REPLICA_DB_PATH")
docker run --rm "${USER_ARGS[@]}" \
  --env-file "$ENV_FILE" \
  -v "$LITESTREAM_CONFIG:/etc/litestream.yml:ro" \
  -v "$SCRATCH:/restore" \
  "$LITESTREAM_IMAGE" "${RESTORE_ARGS[@]}" >&2 || die "litestream restore failed"
[ -s "$SCRATCH/openmessageboard.db" ] || die "the restore produced no database"
RESTORE_SECONDS=$(( $(date +%s) - START ))
DB_BYTES=$(wc -c <"$SCRATCH/openmessageboard.db" | tr -d ' ')

# ---------- 2. integrity and contents ----------
say "checking integrity"
# shellcheck disable=SC2016  # JavaScript, not shell: ${t} is a template literal.
INSPECT_JS='
const Database = require("better-sqlite3");
// The scratch copy, so a normal connection is fine (read-only WAL opens can fail without a -shm file).
const db = new Database("/data/openmessageboard.db", { fileMustExist: true });
const count = (t) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { return null; } };
const one = (sql) => { try { return db.prepare(sql).pluck().get() ?? null; } catch { return null; } };
const out = {
  integrity: db.pragma("integrity_check", { simple: true }),
  migrations: one("SELECT COUNT(*) FROM schema_migrations"),
  principals: count("principals"),
  boards: count("boards"),
  threads: count("threads"),
  messages: count("messages"),
  events: count("events"),
  latest_event_at: one("SELECT MAX(created_at) FROM events"),
};
db.close();
console.log(JSON.stringify(out));
'
INSPECT="$(docker run --rm "${USER_ARGS[@]}" --network none -v "$SCRATCH:/data" -w /app/server --entrypoint node "$OMB_IMAGE" -e "$INSPECT_JS")" || die "could not open the restored database"
case "$INSPECT" in *'"integrity":"ok"'*) ;; *) die "integrity check failed: $INSPECT" ;; esac

# ---------- 3. boot an isolated server ----------
say "starting a throwaway server on port $DRILL_PORT (internal network, no internet access)"
docker network create --internal "$NETWORK" >/dev/null
docker run -d --name "$SERVER" "${USER_ARGS[@]}" \
  --network "$NETWORK" --network-alias omb-drill \
  -v "$SCRATCH:/data" \
  -e OMB_DATA_DIR=/data \
  -e OMB_PORT="$DRILL_PORT" \
  -e OMB_PUBLIC_URL="http://omb-drill:$DRILL_PORT" \
  -e OMB_SECRET="$SECRET" \
  -e OMB_ALLOW_IMPORT=false \
  -e OMB_AUTH_PROVIDERS=email \
  "$OMB_IMAGE" >/dev/null

# ---------- 4. check it from a sibling container on the same network ----------
CHECK_JS='
const base = process.argv[1];
const deadline = Date.now() + 60_000;
const get = async (path) => {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
(async () => {
  let health = null;
  while (Date.now() < deadline) {
    try { health = await get("/healthz"); if (health.status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const info = health?.status === 200 ? await get("/.well-known/openmessageboard").catch(() => null) : null;
  const result = {
    healthz: health?.status ?? null,
    version: health?.body?.version ?? null,
    well_known: info?.status ?? null,
    spec_version: info?.body?.spec_version ?? null,
    profiles: info?.body?.profiles ?? null,
  };
  console.log(JSON.stringify(result));
  process.exit(result.healthz === 200 && result.well_known === 200 && result.spec_version ? 0 : 1);
})();
'
CHECK_STATUS=0
CHECK="$(docker run --rm --network "$NETWORK" --entrypoint node "$OMB_IMAGE" -e "$CHECK_JS" "http://omb-drill:$DRILL_PORT")" || CHECK_STATUS=$?
if [ "$CHECK_STATUS" != 0 ]; then
  say "server log:"
  docker logs --tail 50 "$SERVER" >&2 || true
fi

TOTAL_SECONDS=$(( $(date +%s) - START ))
PASSED=$([ "$CHECK_STATUS" = 0 ] && echo true || echo false)
cat <<EOF
{
  "passed": $PASSED,
  "restored_to": "${TIMESTAMP:-latest}",
  "restore_seconds": $RESTORE_SECONDS,
  "total_seconds": $TOTAL_SECONDS,
  "database_bytes": $DB_BYTES,
  "database": $INSPECT,
  "server": ${CHECK:-null},
  "secret": "$SECRET_NOTE"
}
EOF
[ "$PASSED" = true ] || die "the restored server did not pass its checks"
say "passed: the replica restores into a working server"
