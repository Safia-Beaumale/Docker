# L'image Gatus est construite FROM scratch (pas de shell) : le dossier de
# données est préparé dans un stage Alpine puis copié avec le bon propriétaire.
FROM alpine:3.22 AS data
RUN mkdir /data

FROM twinproduction/gatus:v5.37.0

COPY --from=data --chown=65534:65534 /data /data
COPY config.yaml /config/config.yaml

# Utilisateur non-root (nobody)
USER 65534:65534

EXPOSE 8080
