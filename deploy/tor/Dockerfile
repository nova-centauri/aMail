FROM alpine:3.24

ARG PROXY_UID=10002
ARG PROXY_GID=10002

RUN apk add --no-cache privoxy tor netcat-openbsd \
    && addgroup -g "${PROXY_GID}" -S torproxy \
    && adduser -u "${PROXY_UID}" -S -D -H -h /var/lib/tor -s /sbin/nologin -G torproxy torproxy \
    && mkdir -p /var/lib/tor \
    && touch /var/lib/tor/.volume-owner \
    && chown -R torproxy:torproxy /var/lib/tor \
    && chmod 0700 /var/lib/tor

COPY torrc /etc/tor/torrc
COPY privoxy.config /etc/privoxy/config
COPY entrypoint.sh /usr/local/bin/tor-proxy

# Alpine keeps Privoxy's stock files as *.new until an administrator accepts
# them. This immutable image accepts the safe defaults at build time. Compose
# pins a numeric UID:GID, so use that non-root primary group for read access.
RUN for file in default.action default.filter match-all.action user.action; do \
      cp "/etc/privoxy/${file}.new" "/etc/privoxy/${file}"; \
    done \
    && chgrp -R torproxy /etc/privoxy \
    && chmod -R g+rX,g-w /etc/privoxy \
    && chmod 0555 /usr/local/bin/tor-proxy

USER torproxy

EXPOSE 8118

ENTRYPOINT ["/usr/local/bin/tor-proxy"]
