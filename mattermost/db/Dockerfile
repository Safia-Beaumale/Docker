FROM postgres:15-alpine

RUN addgroup -g 1001 mmgroup || true

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD pg_isready -U $POSTGRES_USER -d $POSTGRES_DB

EXPOSE 5432
