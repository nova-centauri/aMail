#!/bin/sh
set -eu

usage() {
  echo "Usage: sh deploy/launch.sh [privacy|direct]" >&2
  exit 64
}

mode=${1:-privacy}
case "$mode" in
  direct|privacy) ;;
  *) usage ;;
esac

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env, then replace both required secrets." >&2
  exit 1
fi

# Parsing only the individual KEY=value lines avoids executing an operator's
# configuration file as shell code.
count_key() {
  awk -v key="$1" 'index($0, key "=") == 1 { count += 1 } END { print count + 0 }' .env
}

read_key() {
  awk -v key="$1" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' .env
}

# Do not silently launch with the illustrative values shipped in .env.example.
# Each secret may be declared under its aMail name or its GigaMail-era name,
# but exactly once overall so Compose never picks an unexpected value.
require_secret() {
  name=$1
  modern="AMAIL_$name"
  legacy="GIGAMAIL_$name"
  count=$(( $(count_key "$modern") + $(count_key "$legacy") ))
  if [ "$count" -ne 1 ]; then
    echo "$modern must appear exactly once in .env (found $count declarations of $modern/$legacy)." >&2
    exit 1
  fi
  if [ "$(count_key "$modern")" -eq 1 ]; then
    key=$modern
  else
    key=$legacy
  fi
  value=$(read_key "$key")
  case "$value" in
    ''|replace-with-*|changeme*|change-me*|example*|"\"replace-with-"*|"'replace-with-"*)
      echo "$key must be replaced with a high-entropy secret in .env before launch." >&2
      exit 1
      ;;
  esac
  if [ "${#value}" -lt 32 ]; then
    echo "$key must be at least 32 characters long in .env before launch." >&2
    exit 1
  fi
}

require_secret ENCRYPTION_KEY
require_secret ACCESS_TOKEN

# /api/health reports this so tooling (deploy/autoupdate.sh, a human with curl)
# can see which revision is serving. Deploy tooling may set it explicitly.
if [ -z "${AMAIL_RELEASE_SHA:-}" ]; then
  AMAIL_RELEASE_SHA=$(git rev-parse HEAD 2>/dev/null || true)
fi
export AMAIL_RELEASE_SHA

# `config --quiet` renders the exact project first. It does not create,
# remove, or restart containers, volumes, networks, or images.
docker compose --env-file .env config --quiet

compose_privacy() {
  # Shell-scoped so a normal direct launch cannot accidentally retain a proxy
  # setting for a stopped Tor container.
  REMOTE_CONTENT_PROXY_URL=http://tor-proxy:8118 \
    docker compose --env-file .env --profile privacy "$@"
}

force_recreate=${AMAIL_FORCE_RECREATE:-${GIGAMAIL_FORCE_RECREATE:-0}}

if [ "$mode" = privacy ]; then
  if [ "$force_recreate" = "1" ]; then
    # Never force-recreate Tor for an app release: a cold Tor bootstrap can
    # take minutes, and taking down a working relay is how deploys get stuck.
    compose_privacy up --detach --build tor-proxy
    compose_privacy up --detach --build --force-recreate --no-deps amail
  else
    compose_privacy up --detach --build
  fi
else
  # This intentionally runs no proxy. In production aMail keeps remote
  # content blocked rather than bypassing privacy controls with direct egress.
  if [ "$force_recreate" = "1" ]; then
    REMOTE_CONTENT_PROXY_URL= \
      docker compose --env-file .env up --detach --build --force-recreate
  else
    REMOTE_CONTENT_PROXY_URL= \
      docker compose --env-file .env up --detach --build
  fi
fi
