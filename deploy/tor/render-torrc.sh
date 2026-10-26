#!/bin/sh
set -eu

umask 077

if [ "$#" -ne 2 ]; then
  echo "Usage: render-torrc BASE_CONFIG RUNTIME_CONFIG" >&2
  exit 64
fi

base_config=$1
runtime_config=$2
transport=${AMAIL_TOR_TRANSPORT:-${GIGAMAIL_TOR_TRANSPORT:-direct}}

case "$transport" in
  direct|snowflake) ;;
  *)
    echo "AMAIL_TOR_TRANSPORT must be direct or snowflake (got: $transport)." >&2
    exit 64
    ;;
esac

cp "$base_config" "$runtime_config"

if [ "$transport" = snowflake ]; then
  cat >>"$runtime_config" <<'EOF'

# Snowflake hides the first Tor hop behind a WebRTC pluggable transport. These
# two bridge descriptors are the Tor Project's v2.15.1 client defaults. The
# synthetic 192.0.2.x addresses are never contacted; snowflake-client uses the
# broker, domain fronts, and ICE servers encoded on each Bridge line.
UseBridges 1
ClientTransportPlugin snowflake exec /usr/bin/snowflake-client
Bridge snowflake 192.0.2.4:80 8838024498816A039FCBBAB14E6F40A0843051FA fingerprint=8838024498816A039FCBBAB14E6F40A0843051FA url=https://1098762253.rsc.cdn77.org/ fronts=www.cdn77.com,www.phpmyadmin.net ice=stun:stun.antisip.com:3478,stun:stun.epygi.com:3478,stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,stun:stun.mixvoip.com:3478,stun:stun.nextcloud.com:3478,stun:stun.bethesda.net:3478,stun:stun.nextcloud.com:443 utls-imitate=hellorandomizedalpn
Bridge snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=https://1098762253.rsc.cdn77.org/ fronts=www.cdn77.com,www.phpmyadmin.net ice=stun:stun.antisip.com:3478,stun:stun.epygi.com:3478,stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,stun:stun.mixvoip.com:3478,stun:stun.nextcloud.com:3478,stun:stun.bethesda.net:3478,stun:stun.nextcloud.com:443 utls-imitate=hellorandomizedalpn
EOF
fi

chmod 0600 "$runtime_config"
