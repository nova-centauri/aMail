#!/bin/sh
# Runtime wrapper for the aMail image.
#
# Hosted (keyslot) tenants get a density profile when the operator has not
# already set these. Self-hosted env-mode installs are unchanged. Explicit
# environment always wins.
set -eu

if [ "${AMAIL_KEY_MODE:-}" = "keyslot" ]; then
  if [ -z "${UV_THREADPOOL_SIZE:-}" ]; then
    UV_THREADPOOL_SIZE=2
    export UV_THREADPOOL_SIZE
  fi
  case "${NODE_OPTIONS:-}" in
    *max-old-space-size*) ;;
    "")
      NODE_OPTIONS="--max-old-space-size=384"
      export NODE_OPTIONS
      ;;
    *)
      NODE_OPTIONS="${NODE_OPTIONS} --max-old-space-size=384"
      export NODE_OPTIONS
      ;;
  esac
fi

exec "$@"
