#!/bin/sh
set -eu

umask 077

tor_config=$(mktemp /tmp/amail-torrc.XXXXXX)
/usr/local/bin/render-torrc /etc/tor/torrc "$tor_config"

tor -f "$tor_config" &
tor_pid=$!
privoxy_pid=''

cleanup() {
  if [ -n "$privoxy_pid" ]; then
    kill -TERM "$privoxy_pid" 2>/dev/null || true
    wait "$privoxy_pid" 2>/dev/null || true
  fi
  kill -TERM "$tor_pid" 2>/dev/null || true
  wait "$tor_pid" 2>/dev/null || true
  rm -f "$tor_config"
}

on_signal() {
  cleanup
  trap - EXIT
  exit 0
}

trap on_signal INT TERM
trap cleanup EXIT

# Privoxy stays in the foreground, so Docker correctly tracks service health.
privoxy --no-daemon --pidfile /tmp/privoxy.pid /etc/privoxy/config &
privoxy_pid=$!

# A usable HTTP proxy requires both daemons. Exit (and let Compose restart)
# if either one dies rather than leaving Privoxy serving a broken upstream.
while kill -0 "$tor_pid" 2>/dev/null && kill -0 "$privoxy_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$tor_pid" 2>/dev/null; then
  wait "$tor_pid" || exit_code=$?
else
  wait "$privoxy_pid" || exit_code=$?
fi

exit "${exit_code:-1}"
