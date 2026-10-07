FROM 42wim/matterbridge:1.26.0

# envsubst pour générer la config à partir du template + utilisateur non-root
RUN apk add --no-cache gettext \
  && adduser -D -H -u 1001 matterbridge

COPY matterbridge.toml.tmpl /etc/matterbridge/matterbridge.toml.tmpl
COPY --chmod=755 entrypoint.sh /entrypoint.sh

USER matterbridge

ENTRYPOINT ["/entrypoint.sh"]
