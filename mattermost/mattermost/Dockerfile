# Version choisie depuis le .env (MATTERMOST_VERSION), transmise par docker-compose
ARG MATTERMOST_VERSION=release-9.11
FROM mattermost/mattermost-enterprise-edition:${MATTERMOST_VERSION}

USER mattermost

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -f http://localhost:8065/api/v4/system/ping || exit 1

EXPOSE 8065
