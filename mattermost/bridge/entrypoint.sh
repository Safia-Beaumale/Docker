#!/bin/sh
set -eu

VARS='DISCORD_TOKEN DISCORD_SERVER DISCORD_CHANNEL MATTERMOST_BOT_TOKEN MATTERMOST_TEAM MATTERMOST_CHANNEL'

missing=''
for v in $VARS; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "matterbridge: variables manquantes dans .env :$missing" >&2
  exit 1
fi

# Seules les variables listées sont substituées (pas de fuite d'autres variables d'env)
envsubst "$(printf '${%s} ' $VARS)" \
  < /etc/matterbridge/matterbridge.toml.tmpl \
  > /tmp/matterbridge.toml

exec /bin/matterbridge -conf /tmp/matterbridge.toml "$@"
