#!/bin/sh
# Exercise the opt-in autoheal compose profile against a real Docker daemon:
# autoheal restarts an unhealthy labeled container through socket-proxy, and
# the proxy allowlist permits list and restart while denying inspect, stop,
# exec, create, delete, and images.
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to test the autoheal socket proxy." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose is required to test the autoheal socket proxy." >&2
  exit 1
fi
if [ ! -S /var/run/docker.sock ]; then
  echo "This test needs a Docker engine socket at /var/run/docker.sock." >&2
  exit 1
fi

# Dedicated project so `down` cannot touch another aMail stack.
export COMPOSE_PROJECT_NAME="${AMAIL_AUTOHEAL_TEST_PROJECT:-amail-autoheal-$$}"
export AUTOHEAL_INTERVAL="${AUTOHEAL_INTERVAL:-2}"
export AUTOHEAL_START_PERIOD="${AUTOHEAL_START_PERIOD:-0}"
export AMAIL_AUTOHEAL=true

PROBE_NAME="${COMPOSE_PROJECT_NAME}-probe"
COMPOSE="docker compose --profile autoheal"
# Operators enable the sidecar with `--profile autoheal up`. This script
# starts only the profile services so we do not build or boot aMail.
# autoheal depends_on socket-proxy; --no-deps skips that edge, so both
# names must be listed.
COMPOSE_UP="$COMPOSE up -d --no-deps socket-proxy autoheal"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm --force --volumes "$PROBE_NAME" >/dev/null 2>&1 || true
  $COMPOSE stop socket-proxy autoheal >/dev/null 2>&1 || true
  $COMPOSE rm -f socket-proxy autoheal >/dev/null 2>&1 || true
  docker compose --profile autoheal down --timeout 15 >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "Project: $COMPOSE_PROJECT_NAME"
echo "Command: AUTOHEAL_INTERVAL=$AUTOHEAL_INTERVAL AUTOHEAL_START_PERIOD=$AUTOHEAL_START_PERIOD $COMPOSE_UP"

$COMPOSE_UP

echo "Waiting for socket-proxy and autoheal..."
i=0
proxy_id=""
autoheal_id=""
while [ "$i" -lt 30 ]; do
  proxy_id=$($COMPOSE ps -q socket-proxy 2>/dev/null || true)
  autoheal_id=$($COMPOSE ps -q autoheal 2>/dev/null || true)
  proxy_state=""
  autoheal_state=""
  if [ -n "$proxy_id" ] && [ -n "$autoheal_id" ]; then
    proxy_state=$(docker inspect --format '{{.State.Status}}' "$proxy_id")
    autoheal_state=$(docker inspect --format '{{.State.Status}}' "$autoheal_id")
    if [ "$proxy_state" = "running" ] && [ "$autoheal_state" = "running" ]; then
      break
    fi
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$proxy_state" != "running" ] || [ "$autoheal_state" != "running" ]; then
  echo "autoheal profile services did not become running:" >&2
  $COMPOSE ps >&2 || true
  $COMPOSE logs >&2 || true
  exit 1
fi

# Runtime trust-boundary checks.
sock_mounts=$(docker inspect "$proxy_id" --format '{{range .Mounts}}{{.Source}}:{{.Destination}}:rw={{.RW}} {{end}}')
case "$sock_mounts" in
  */var/run/docker.sock:/var/run/docker.sock:rw=false*) ;;
  *)
    echo "socket-proxy must mount /var/run/docker.sock read-only, got: $sock_mounts" >&2
    exit 1
    ;;
esac
autoheal_mounts=$(docker inspect "$autoheal_id" --format '{{range .Mounts}}{{.Source}}:{{.Destination}}:rw={{.RW}} {{end}}')
case "$autoheal_mounts" in
  */var/run/docker.sock*)
    echo "autoheal must not mount docker.sock, got: $autoheal_mounts" >&2
    exit 1
    ;;
esac
proxy_bindings=$(docker inspect "$proxy_id" --format '{{json .HostConfig.PortBindings}}')
if [ "$proxy_bindings" != "{}" ] && [ "$proxy_bindings" != "null" ]; then
  echo "socket-proxy must not publish host ports, got: $proxy_bindings" >&2
  exit 1
fi
proxy_nets=$(docker inspect "$proxy_id" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')
autoheal_nets=$(docker inspect "$autoheal_id" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')
case "$proxy_nets" in
  *app-net*|*privacy-net*)
    echo "socket-proxy must not join app-net or privacy-net, got: $proxy_nets" >&2
    exit 1
    ;;
esac
case "$autoheal_nets" in
  *app-net*|*privacy-net*)
    echo "autoheal must not join app-net or privacy-net, got: $autoheal_nets" >&2
    exit 1
    ;;
esac

echo "Starting labeled probe container $PROBE_NAME"
docker rm --force --volumes "$PROBE_NAME" >/dev/null 2>&1 || true
docker run --detach --name "$PROBE_NAME" \
  --label autoheal=true \
  --health-cmd "exit 1" \
  --health-interval 1s \
  --health-timeout 1s \
  --health-retries 1 \
  --health-start-period 0s \
  alpine:3.20 sleep 3600 >/dev/null

PROBE_ID=$(docker inspect --format '{{.Id}}' "$PROBE_NAME")
PROBE_SHORT=$(printf '%s' "$PROBE_ID" | cut -c1-12)

proxy_curl() {
  # Same network and binary autoheal uses to talk to the proxy.
  method=$1
  path=$2
  shift 2
  $COMPOSE exec -T autoheal curl --silent --show-error --max-time 5 \
    --output /tmp/autoheal-proxy-body \
    --write-out '%{http_code}' \
    --request "$method" \
    "http://socket-proxy:2375$path" \
    "$@"
}

echo "Waiting for proxy GET /_ping..."
i=0
ping_code=000
while [ "$i" -lt 30 ]; do
  ping_code=$(proxy_curl GET /_ping || printf '000')
  if [ "$ping_code" = "200" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ping_code" != "200" ]; then
  echo "socket-proxy never answered GET /_ping (last status $ping_code)" >&2
  $COMPOSE logs socket-proxy autoheal >&2 || true
  exit 1
fi

fail=0
report() {
  method=$1
  path=$2
  expected=$3
  actual=$4
  if [ "$actual" = "$expected" ]; then
    printf 'ALLOW/DENY  %s %s -> %s (expected %s)\n' "$method" "$path" "$actual" "$expected"
  else
    printf 'ALLOW/DENY  %s %s -> %s (expected %s) FAIL\n' "$method" "$path" "$actual" "$expected" >&2
    fail=1
  fi
}

list_code=$(proxy_curl GET /containers/json)
report GET /containers/json 200 "$list_code"

inspect_code=$(proxy_curl GET "/containers/${PROBE_ID}/json")
report GET /containers/{id}/json 403 "$inspect_code"
inspect_body=$($COMPOSE exec -T autoheal cat /tmp/autoheal-proxy-body 2>/dev/null || true)
case "$inspect_body" in
  *'"Config"'*|*'Config.Env'*|*'"Env"'*)
    echo "GET /containers/{id}/json was denied but the body still looks like inspect (would leak Config.Env):" >&2
    printf '%s\n' "$inspect_body" >&2
    fail=1
    ;;
esac
if [ "$inspect_code" != "403" ]; then
  echo "GET /containers/{id}/json must be denied (inspect exposes Config.Env)." >&2
  fail=1
fi
inspect_v_code=$(proxy_curl GET "/v1.41/containers/${PROBE_ID}/json")
report GET /v1.41/containers/{id}/json 403 "$inspect_v_code"

restart_code=$(proxy_curl POST "/containers/${PROBE_ID}/restart?t=1")
if [ "$restart_code" = "200" ] || [ "$restart_code" = "204" ]; then
  printf 'ALLOW/DENY  %s %s -> %s (expected 200 or 204)\n' POST /containers/{id}/restart "$restart_code"
else
  printf 'ALLOW/DENY  %s %s -> %s (expected 200 or 204) FAIL\n' POST /containers/{id}/restart "$restart_code" >&2
  fail=1
fi

stop_code=$(proxy_curl POST "/containers/${PROBE_ID}/stop")
report POST /containers/{id}/stop 403 "$stop_code"

exec_code=$(proxy_curl POST "/containers/${PROBE_ID}/exec" \
  --header 'Content-Type: application/json' \
  --data '{"Cmd":["id"]}')
report POST /containers/{id}/exec 403 "$exec_code"

create_code=$(proxy_curl POST /containers/create \
  --header 'Content-Type: application/json' \
  --data '{"Image":"alpine:3.20","Cmd":["true"]}')
report POST /containers/create 403 "$create_code"

delete_code=$(proxy_curl DELETE "/containers/${PROBE_ID}")
report DELETE /containers/{id} 403 "$delete_code"

images_code=$(proxy_curl GET /images/json)
report GET /images/json 403 "$images_code"

if [ "$fail" -ne 0 ]; then
  echo "Proxy allow/deny checks failed." >&2
  $COMPOSE logs socket-proxy >&2 || true
  exit 1
fi

echo "Waiting for the probe to be unhealthy..."
i=0
health=""
while [ "$i" -lt 30 ]; do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$PROBE_NAME")
  if [ "$health" = "unhealthy" ]; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$health" != "unhealthy" ]; then
  echo "Probe never became unhealthy (status '$health')." >&2
  docker inspect "$PROBE_NAME" >&2 || true
  exit 1
fi

started_at=$(docker inspect --format '{{.State.StartedAt}}' "$PROBE_NAME")
echo "Probe is unhealthy (StartedAt=$started_at). Waiting for autoheal restart through the proxy..."
i=0
restarted=0
while [ "$i" -lt 45 ]; do
  now=$(docker inspect --format '{{.State.StartedAt}}' "$PROBE_NAME")
  if [ "$now" != "$started_at" ]; then
    restarted=1
    echo "Autoheal restarted $PROBE_NAME ($PROBE_SHORT): StartedAt $started_at -> $now"
    break
  fi
  i=$((i + 1))
  sleep 1
done

echo "---- autoheal logs ----"
$COMPOSE logs --no-color --timestamps autoheal || true
echo "---- socket-proxy logs (tail) ----"
$COMPOSE logs --no-color --timestamps --tail 50 socket-proxy || true

if [ "$restarted" -ne 1 ]; then
  echo "autoheal did not restart the unhealthy labeled container through the proxy." >&2
  echo "STOP: inspect stays denied. If 1.2.0 required GET /containers/{id}/json, report that rather than re-allowing it." >&2
  exit 1
fi
if ! $COMPOSE logs --no-color autoheal | grep -q "found to be unhealthy"; then
  echo "autoheal logs did not record the unhealthy restart." >&2
  exit 1
fi

echo "PASS: autoheal restarted ${PROBE_NAME} through socket-proxy; allow/deny checks succeeded."
