FROM mattermost/mattermost-enterprise-edition:release-9.11

USER mattermost

HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD curl -f http://localhost:8065/api/v4/system/ping || exit 1

EXPOSE 8065
