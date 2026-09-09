#!/bin/sh
# Pull-based continuous delivery for a self-hosted aMail.
#
# CI fast-forwards the `release` branch to a commit of `main` only after every
# check has passed. This script, run from a timer (see deploy/systemd), fetches
# that branch, and when it has moved: checks it out, redeploys with
# deploy/launch.sh, waits for /api/health to report the new revision, and rolls
# back to the previous one if it does not. Nothing on GitHub can reach this
# host; the host only ever pulls.
#
# Usage: sh deploy/autoupdate.sh [privacy|direct]
# Environment:
#   AMAIL_RELEASE_BRANCH   branch to follow (default: release)
#   AMAIL_HEALTH_TIMEOUT   seconds to wait for the new revision (default: 180)
set -eu

usage() {
  echo "Usage: sh deploy/autoupdate.sh [privacy|direct]" >&2
  exit 64
}

mode=${1:-privacy}
case "$mode" in
  direct|privacy) ;;
  *) usage ;;
esac

branch=${AMAIL_RELEASE_BRANCH:-release}
health_timeout=${AMAIL_HEALTH_TIMEOUT:-180}
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

log() {
  printf '%s autoupdate: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# One updater at a time. A deploy can take minutes and the timer keeps firing.
lock_file=$repo_dir/.git/amail-autoupdate.lock
if command -v flock >/dev/null 2>&1; then
  exec 9>"$lock_file"
  if ! flock -n 9; then
    log "another run is still in progress; skipping"
    exit 0
  fi
fi

failed_marker=$repo_dir/.git/amail-autoupdate-failed

read_env_key() {
  awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' .env
}

health_url() {
  bind=$(read_env_key AMAIL_BIND_ADDRESS)
  port=$(read_env_key AMAIL_PORT)
  case "$bind" in
    ''|0.0.0.0|'::'|'[::]') bind=127.0.0.1 ;;
  esac
  echo "http://${bind}:${port:-3080}/api/health"
}

# Succeeds once /api/health answers with the expected revision.
wait_for_revision() {
  want=$1
  url=$(health_url)
  deadline=$(( $(date +%s) + health_timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    body=$(curl --silent --fail --max-time 5 "$url" 2>/dev/null || true)
    case "$body" in
      *"\"releaseSha\":\"$want\""*) return 0 ;;
    esac
    sleep 5
  done
  return 1
}

if [ ! -f .env ]; then
  log "no .env in $repo_dir; nothing to deploy"
  exit 1
fi

git fetch --quiet origin "$branch"
current=$(git rev-parse HEAD)
target=$(git rev-parse FETCH_HEAD)

if [ "$current" = "$target" ]; then
  exit 0
fi

if [ -f "$failed_marker" ] && [ "$(cat "$failed_marker")" = "$target" ]; then
  # Already tried this revision and rolled back. Wait for the next one rather
  # than redeploying a known-bad build every few minutes.
  exit 0
fi

# Local edits to tracked files would be clobbered by the checkout. .env and
# other untracked files are left alone.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "tracked files have local changes; refusing to update. Commit, stash, or revert them."
  exit 1
fi

log "deploying $target (was $current)"
git checkout --quiet -B "$branch" "$target"
git branch --quiet --set-upstream-to "origin/$branch" "$branch" 2>/dev/null || true

if AMAIL_RELEASE_SHA=$target sh deploy/launch.sh "$mode" && wait_for_revision "$target"; then
  rm -f "$failed_marker"
  log "now serving $target"
  exit 0
fi

log "$target did not become healthy within ${health_timeout}s; rolling back to $current"
printf '%s\n' "$target" > "$failed_marker"
git checkout --quiet -B "$branch" "$current"
if AMAIL_RELEASE_SHA=$current AMAIL_FORCE_RECREATE=1 sh deploy/launch.sh "$mode" && wait_for_revision "$current"; then
  log "rolled back; $current is serving again. $target will not be retried until release moves."
else
  log "rollback to $current did not report healthy either; manual attention needed"
fi
exit 1
