#!/bin/sh
# Decide whether a deployment should run the bundled Typesense service.
#
# Output is exactly one of:
#   disabled  SQLite FTS only; do not start the plaintext index service.
#   local     Start the Compose Typesense profile and use its internal URL.
#   external  Use the operator-provided AMAIL/GIGAMAIL_TYPESENSE_URL.
set -eu

env_file=${1:-.env}
if [ ! -f "$env_file" ]; then
  echo "Missing environment file: $env_file" >&2
  exit 1
fi

read_key() {
  awk -v key="$1" '
    index($0, key "=") == 1 { value = substr($0, length(key) + 2) }
    END { sub(/\r$/, "", value); print value }
  ' "$env_file"
}

read_alias() {
  name=$1
  value=$(read_key "AMAIL_$name")
  if [ -z "$value" ]; then
    value=$(read_key "GIGAMAIL_$name")
  fi
  printf '%s' "$value"
}

unquote() {
  value=$1
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

search_mode=$(lower "$(unquote "$(read_alias SEARCH_ENGINE)")")
case "$search_mode" in
  auto|typesense|off|fts) ;;
  *) search_mode=auto ;;
esac

key_mode=$(lower "$(unquote "$(read_alias KEY_MODE)")")
encrypt_database=$(lower "$(unquote "$(read_alias ENCRYPT_DATABASE)")")

encrypted=false
case "$key_mode" in
  keyslot) encrypted=true ;;
esac
case "$encrypt_database" in
  1|true|yes|on) encrypted=true ;;
esac

case "$search_mode" in
  off|fts)
    echo disabled
    exit 0
    ;;
  auto)
    if [ "$encrypted" = true ]; then
      echo disabled
      exit 0
    fi
    ;;
  typesense) ;;
esac

typesense_url=$(unquote "$(read_alias TYPESENSE_URL)")
if [ -n "$typesense_url" ]; then
  echo external
else
  echo local
fi
