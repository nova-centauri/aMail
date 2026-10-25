#!/bin/sh
# Read-only deployment inventory for an existing aMail host.
#
# This deliberately never sources .env, renders `docker compose config`, or
# inspects container environment variables. Secret values are reported only as
# missing, duplicated, too short, or present. Run it from the repository root:
#
#   sudo sh deploy/security-preflight.sh
#
# It may also be streamed from a reviewed Git revision. In that case pass the
# repository path as the first argument:
#
#   git show <revision>:deploy/security-preflight.sh | sudo sh -s -- "$PWD"
set -u

export LC_ALL=C
umask 077

section() {
  printf '\n[%s]\n' "$1"
}

emit() {
  key=$1
  shift
  # Keep the report line-oriented and remove terminal control characters even
  # if an operator-controlled setting contains odd whitespace.
  value=$(printf '%s' "$*" | tr -cd '\11\12\15\40-\176' | tr '\r\n\t' '   ')
  printf '%s=%s\n' "$key" "$value"
}

first_line() {
  sed -n '1p' | tr '\r\n\t' '   '
}

repo_arg=${1:-.}
if ! repo_dir=$(CDPATH= cd -- "$repo_arg" 2>/dev/null && pwd -P); then
  echo "Could not open repository directory: $repo_arg" >&2
  exit 64
fi

if [ "$(id -u)" -eq 0 ]; then
  privilege=root
  as_root() { "$@"; }
elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  privilege=sudo-noninteractive
  as_root() { sudo -n "$@"; }
else
  privilege=unprivileged
  as_root() { "$@"; }
fi

docker_access=unavailable
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    docker_access=direct
    docker_run() { docker "$@"; }
  elif [ "$privilege" = sudo-noninteractive ] && sudo -n docker info >/dev/null 2>&1; then
    docker_access=sudo
    docker_run() { sudo -n docker "$@"; }
  elif [ "$privilege" = root ] && docker info >/dev/null 2>&1; then
    docker_access=root
    docker_run() { docker "$@"; }
  fi
fi

env_file=$repo_dir/.env

env_count() {
  key=$1
  [ -f "$env_file" ] || { printf '0\n'; return; }
  awk -v key="$key" 'index($0, key "=") == 1 { count += 1 } END { print count + 0 }' "$env_file"
}

env_value() {
  key=$1
  [ -f "$env_file" ] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$env_file"
}

secret_state() {
  label=$1
  modern=$2
  legacy=${3:-}
  modern_count=$(env_count "$modern")
  legacy_count=0
  [ -n "$legacy" ] && legacy_count=$(env_count "$legacy")
  total=$((modern_count + legacy_count))
  if [ "$total" -eq 0 ]; then
    emit "secret.$label" missing
    return
  fi
  if [ "$total" -ne 1 ]; then
    emit "secret.$label" "duplicate ($total declarations)"
    return
  fi
  if [ "$modern_count" -eq 1 ]; then
    secret_key=$modern
  else
    secret_key=$legacy
  fi
  secret_length=$(env_value "$secret_key" | awk '{ print length($0); exit }')
  if [ "${secret_length:-0}" -lt 32 ]; then
    emit "secret.$label" present-but-short
  else
    emit "secret.$label" present-and-at-least-32-chars
  fi
}

setting() {
  key=$1
  value=$(env_value "$key")
  [ -n "$value" ] && emit "env.$key" "$value"
}

unit_state() {
  unit=$1
  if ! command -v systemctl >/dev/null 2>&1; then
    emit "systemd.$unit" unavailable
    return
  fi
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  active=$(systemctl is-active "$unit" 2>/dev/null || true)
  fragment=$(systemctl show -p FragmentPath --value "$unit" 2>/dev/null || true)
  emit "systemd.$unit" "enabled=${enabled:-unknown} active=${active:-unknown} unit=${fragment:-unknown}"
}

classify_database() {
  database=$1
  [ -f "$database" ] || return 0
  header=$(as_root dd if="$database" bs=16 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
  case "$header" in
    53514c69746520666f726d6174203300) format=plaintext-sqlite ;;
    '') format=unreadable ;;
    *) format=encrypted-or-unrecognized ;;
  esac
  size=$(as_root stat -c '%s' "$database" 2>/dev/null || true)
  emit database "path=$database bytes=${size:-unknown} format=$format"
}

inspect_data_mount() {
  container=$1
  source=$(docker_run inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container" 2>/dev/null || true)
  [ -n "$source" ] || return 0
  volume=$(docker_run inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container" 2>/dev/null || true)
  usage=$(as_root du -sh "$source" 2>/dev/null | awk '{print $1; exit}')
  filesystem=$(findmnt -T "$source" -n -o SOURCE,FSTYPE,OPTIONS 2>/dev/null | first_line || true)
  emit data_mount "container=$container volume=${volume:-bind-mount} source=$source usage=${usage:-unknown} filesystem=${filesystem:-unknown}"
  for database in "$source/amail.sqlite" "$source/gigamail.sqlite"; do
    classify_database "$database"
  done
}

section report
emit generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
emit report_version 1
emit safety read-only-secret-values-redacted

section host
emit hostname "$(hostname 2>/dev/null || echo unknown)"
emit kernel "$(uname -sr 2>/dev/null || echo unknown)"
if [ -r /etc/os-release ]; then
  os_name=$(awk -F= '$1 == "PRETTY_NAME" { value=substr($0, index($0, "=") + 1); gsub(/^"|"$/, "", value); print value; exit }' /etc/os-release)
  emit os "${os_name:-unknown}"
fi
emit executing_user "$(id -un 2>/dev/null || echo unknown)"
emit privilege "$privilege"
emit root_filesystem "$(findmnt -n -o SOURCE,FSTYPE / 2>/dev/null | first_line || echo unknown)"
if command -v lsblk >/dev/null 2>&1; then
  encrypted_devices=$(lsblk -nr -o TYPE,FSTYPE 2>/dev/null | awk '$1 == "crypt" || $2 == "crypto_LUKS" { count += 1 } END { print count + 0 }')
  emit encrypted_block_devices_detected "$encrypted_devices"
fi

section repository
emit repository "$repo_dir"
if command -v git >/dev/null 2>&1 && git -c "safe.directory=$repo_dir" -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1; then
  emit git_head "$(git -c "safe.directory=$repo_dir" -C "$repo_dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  emit git_branch "$(git -c "safe.directory=$repo_dir" -C "$repo_dir" symbolic-ref --short -q HEAD 2>/dev/null || echo detached)"
  tracked_changes=$(git -c "safe.directory=$repo_dir" -C "$repo_dir" status --porcelain --untracked-files=no 2>/dev/null | awk 'END { print NR + 0 }')
  emit git_tracked_changes "$tracked_changes"
else
  emit git_repository unavailable
fi
emit repository_permissions "$(stat -c '%a %U:%G' "$repo_dir" 2>/dev/null || echo unknown)"

section configuration
if [ -f "$env_file" ]; then
  emit env_file present
  emit env_file_permissions "$(stat -c '%a %U:%G' "$env_file" 2>/dev/null || echo unknown)"
else
  emit env_file missing
fi
secret_state encryption-key AMAIL_ENCRYPTION_KEY GIGAMAIL_ENCRYPTION_KEY
secret_state access-token AMAIL_ACCESS_TOKEN GIGAMAIL_ACCESS_TOKEN
secret_state typesense-api-key TYPESENSE_API_KEY
for key in \
  COMPOSE_PROJECT_NAME AMAIL_BIND_ADDRESS AMAIL_PORT AMAIL_ENCRYPT_DATABASE \
  GIGAMAIL_ENCRYPT_DATABASE AMAIL_SEARCH_ENGINE GIGAMAIL_SEARCH_ENGINE \
  AMAIL_KEY_MODE GIGAMAIL_KEY_MODE AMAIL_TRUST_PROXY GIGAMAIL_TRUST_PROXY \
  AMAIL_ALLOW_INSECURE_TLS GIGAMAIL_ALLOW_INSECURE_TLS \
  AMAIL_COOKIE_SECURE GIGAMAIL_COOKIE_SECURE AMAIL_RP_ID GIGAMAIL_RP_ID \
  AMAIL_ORIGIN GIGAMAIL_ORIGIN AMAIL_RETAIN_DAYS GIGAMAIL_RETAIN_DAYS \
  AMAIL_AUTOHEAL GIGAMAIL_AUTOHEAL
do
  setting "$key"
done

section updater
unit_state amail-autoupdate.timer
unit_state amail-autoupdate.service
if [ -f "$repo_dir/.git/amail-autoupdate-failed" ]; then
  emit updater_failed_marker present
else
  emit updater_failed_marker absent
fi

section docker
emit docker_access "$docker_access"
if [ "$docker_access" != unavailable ]; then
  emit docker_server_version "$(docker_run version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
  emit compose_version "$(docker_run compose version --short 2>/dev/null || echo unknown)"
  docker_root=$(docker_run info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  emit docker_root "${docker_root:-unknown}"
  if [ -n "$docker_root" ]; then
    emit docker_filesystem "$(findmnt -T "$docker_root" -n -o SOURCE,FSTYPE,OPTIONS 2>/dev/null | first_line || echo unknown)"
  fi
  emit docker_storage_driver "$(docker_run info --format '{{.Driver}}' 2>/dev/null || echo unknown)"
  emit docker_security_options "$(docker_run info --format '{{json .SecurityOptions}}' 2>/dev/null || echo unknown)"

  app_count=0
  for container in $(docker_run ps -aq --filter label=com.docker.compose.service=amail 2>/dev/null); do
    app_count=$((app_count + 1))
    name=$(docker_run inspect --format '{{.Name}}' "$container" 2>/dev/null | sed 's#^/##')
    project=$(docker_run inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null || true)
    image=$(docker_run inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)
    state=$(docker_run inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)
    health=$(docker_run inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)
    user=$(docker_run inspect --format '{{.Config.User}}' "$container" 2>/dev/null || true)
    readonly=$(docker_run inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container" 2>/dev/null || true)
    privileged=$(docker_run inspect --format '{{.HostConfig.Privileged}}' "$container" 2>/dev/null || true)
    restart=$(docker_run inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container" 2>/dev/null || true)
    network_mode=$(docker_run inspect --format '{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null || true)
    ports=$(docker_run inspect --format '{{json .HostConfig.PortBindings}}' "$container" 2>/dev/null || true)
    cap_drop=$(docker_run inspect --format '{{json .HostConfig.CapDrop}}' "$container" 2>/dev/null || true)
    security_opt=$(docker_run inspect --format '{{json .HostConfig.SecurityOpt}}' "$container" 2>/dev/null || true)
    emit application_container "name=${name:-unknown} project=${project:-unknown} image=${image:-unknown} state=${state:-unknown} health=${health:-unknown} user=${user:-default} read_only=${readonly:-unknown} privileged=${privileged:-unknown} restart=${restart:-unknown} network_mode=${network_mode:-unknown} ports=${ports:-unknown} cap_drop=${cap_drop:-unknown} security_opt=${security_opt:-unknown}"
    inspect_data_mount "$container"
  done
  emit application_container_count "$app_count"

  for service in typesense tor-proxy autoheal; do
    service_count=$(docker_run ps -aq --filter "label=com.docker.compose.service=$service" 2>/dev/null | awk 'END { print NR + 0 }')
    emit "container_service.$service" "$service_count"
    for container in $(docker_run ps -aq --filter "label=com.docker.compose.service=$service" 2>/dev/null); do
      name=$(docker_run inspect --format '{{.Name}}' "$container" 2>/dev/null | sed 's#^/##')
      project=$(docker_run inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null || true)
      state=$(docker_run inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)
      health=$(docker_run inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)
      emit supporting_container "service=$service name=${name:-unknown} project=${project:-unknown} state=${state:-unknown} health=${health:-unknown}"
      [ "$service" = typesense ] && inspect_data_mount "$container"
    done
  done
else
  emit docker_note "Docker is unavailable to this user; rerun with sudo for container and volume checks"
fi

section host_services
for unit in docker.service ssh.service sshd.service nginx.service caddy.service ufw.service fail2ban.service unattended-upgrades.service; do
  unit_state "$unit"
done
if command -v ss >/dev/null 2>&1; then
  listening_ports=$(as_root ss -lntH 2>/dev/null | awk '{ address=$4; sub(/^.*:/, "", address); if (address ~ /^[0-9]+$/) seen[address]=1 } END { first=1; for (port in seen) { if (!first) printf ","; printf "%s", port; first=0 } print "" }')
  emit tcp_listening_ports "${listening_ports:-unknown}"
fi
if command -v ufw >/dev/null 2>&1; then
  ufw_state=$(as_root ufw status 2>/dev/null | awk 'NR == 1 { print $2; exit }')
  emit ufw "${ufw_state:-unknown}"
else
  emit ufw unavailable
fi
sshd_path=$(command -v sshd 2>/dev/null || true)
if [ -n "$sshd_path" ]; then
  as_root "$sshd_path" -T 2>/dev/null | awk '
    $1 ~ /^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|maxauthtries|allowtcpforwarding|x11forwarding)$/ {
      key=$1; $1=""; sub(/^ /, ""); print "ssh." key "=" $0
    }
  '
else
  emit sshd_config unavailable
fi

section backup_indicators
if command -v systemctl >/dev/null 2>&1; then
  backup_units=$(systemctl list-unit-files --no-legend --no-pager 2>/dev/null | awk 'tolower($1) ~ /(backup|restic|borg|kopia|duplicati)/ { printf "%s%s", separator, $1; separator="," } END { print "" }')
  emit matching_systemd_units "${backup_units:-none-detected}"
fi
if [ "$docker_access" != unavailable ]; then
  backup_containers=$(docker_run ps -a --format '{{.Names}}' 2>/dev/null | awk 'tolower($0) ~ /(backup|restic|borg|kopia|duplicati)/ { printf "%s%s", separator, $0; separator="," } END { print "" }')
  emit matching_containers "${backup_containers:-none-detected}"
fi

section result
emit complete true
emit reminder "This report cannot prove backup recoverability or full-disk encryption; verify both before migrating plaintext data"
