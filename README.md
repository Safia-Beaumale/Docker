# IM Bridge - Mattermost ⇄ Discord

Stack Docker Compose qui déploie un serveur **Mattermost** (messagerie) et un **bridge vers Discord**, afin que les utilisateurs présents sur Discord puissent échanger avec ceux de Mattermost sans changer d'outil.

---

## Sommaire

- [Contexte](#contexte)
- [Architecture](#architecture)
- [Services](#services)
- [Démarrage rapide](#démarrage-rapide)
- [Variables d'environnement](#variables-denvironnement)
- [Configurer le bridge Discord](#configurer-le-bridge-discord)
- [Stack de développement](#stack-de-développement)
- [Fonctionnalités Docker avancées](#fonctionnalités-docker-avancées)
- [Sécurité](#sécurité)
- [Structure du projet](#structure-du-projet)
- [Commandes utiles](#commandes-utiles)
- [Avancement](#avancement)

---

## Contexte

Les utilisateurs sont répartis sur plusieurs services de messagerie de groupe concurrents. L'objectif est de leur permettre de communiquer **depuis et vers** le service de l'entreprise (Mattermost) à partir de leur compte sur un autre service (Discord).

Objectifs pédagogiques :

- comprendre et tester Docker / Docker Compose sur un projet multi-services ;
- étudier les possibilités de networking offertes par Docker ;
- sécuriser les images et le stack applicatif ;
- utiliser des fonctionnalités avancées (Watch, fragments, cgroups, multi-stage, healthchecks) ;
- proposer un environnement de développement / configuration distinct de la production.

---

## Architecture

```mermaid
flowchart LR
    user([Navigateur / App Mattermost]) -->|HTTP :80| nginx

    subgraph frontend [réseau frontend]
        nginx[Nginx<br/>reverse proxy]
    end

    subgraph backend [réseau backend - interne]
        mattermost[Mattermost<br/>:8065]
        db[(PostgreSQL 15)]
    end

    subgraph frontend
        bridge[Bridge Node.js<br/>:8080]
    end

    nginx --> mattermost
    mattermost --> db
    bridge -->|API + WebSocket| mattermost
    mattermost -.->|boutons des sondages| bridge
    bridge -->|Gateway + webhook Discord| discord([Discord])
```

Principes :

- **Seul Nginx expose un port** sur l'hôte. Mattermost et PostgreSQL ne sont joignables que depuis les réseaux Docker.
- **PostgreSQL n'est attaché qu'au réseau `backend`** : il n'est accessible ni depuis l'extérieur, ni depuis Nginx, ni depuis le bridge.
- **Le bridge** parle à Mattermost via son API (compte bot dédié) et à Discord via un bot Discord. Il n'a jamais accès à la base de données.
- Le démarrage est ordonné par des **healthchecks** : `db` → `mattermost` → `nginx` / `bridge`.

---

## Services

| Service      | Image de base                                           | Rôle                                                    | Réseaux                  |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------- | ------------------------ |
| `db`         | `postgres:15-alpine`                                    | Base de données de Mattermost                           | `backend`                |
| `mattermost` | `mattermost/mattermost-enterprise-edition:release-9.11` | Serveur de messagerie (API + WebSocket sur `:8065`)     | `frontend`, `backend`    |
| `nginx`      | `nginx:alpine`                                          | Reverse proxy, point d'entrée unique, upgrade WebSocket | `frontend`               |
| `bridge`     | `node:24-alpine` (bridge maison en TypeScript)          | Relais Mattermost ⇄ Discord (messages, réactions, fichiers, sondages…) | `frontend` |

Volumes persistants : `db-data`, `mm-data`, `mm-config`, `mm-logs`, `mm-plugins`, `bridge-data` (correspondance des IDs de messages entre les deux plateformes).

---

## Démarrage rapide

### Prérequis

- Docker Engine ≥ 24 et Docker Compose v2 (`docker compose`, pas `docker-compose`)
- Un serveur Discord sur lequel vous êtes administrateur (pour le bridge)

### Installation

1. Cloner le dépôt puis copier le fichier d'exemple des variables d'environnement :

```bash
cp .env.example .env
```

2. Éditer `.env` et remplacer au minimum les valeurs `change_me` (voir [Variables d'environnement](#variables-denvironnement)).

3. Construire et lancer le stack :

```bash
docker compose up -d --build
```

4. Vérifier que tous les services sont `healthy` :

```bash
docker compose ps
```

5. Ouvrir <http://localhost> (ou le port défini dans `NGINX_PORT`), créer le compte administrateur et la première équipe Mattermost.

---

## Variables d'environnement

Toute la configuration passe par le fichier `.env` (jamais versionné). Le fichier [`.env.example`](.env.example) sert de modèle.

### PostgreSQL

| Variable            | Description             | Exemple      |
| ------------------- | ----------------------- | ------------ |
| `POSTGRES_USER`     | Utilisateur de la base  | `mmuser`     |
| `POSTGRES_PASSWORD` | Mot de passe de la base | `change_me`  |
| `POSTGRES_DB`       | Nom de la base          | `mattermost` |

### Mattermost

Mattermost lit directement les variables préfixées `MM_` pour surcharger son `config.json` (format `MM_<SECTION>_<CLÉ>`).

| Variable                     | Description                      | Exemple                                                          |
| ---------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `MM_SQLSETTINGS_DRIVERNAME`  | Driver SQL                       | `postgres`                                                       |
| `MM_SQLSETTINGS_DATASOURCE`  | Chaîne de connexion à PostgreSQL | `postgres://mmuser:change_me@db:5432/mattermost?sslmode=disable` |
| `MM_SERVICESETTINGS_SITEURL` | URL publique du serveur          | `http://localhost`                                               |

> ⚠️ Le mot de passe apparaît à la fois dans `POSTGRES_PASSWORD` et dans `MM_SQLSETTINGS_DATASOURCE` : les deux doivent rester identiques.

Quatre réglages nécessaires au bridge sont fixés directement dans `docker-compose.yml` (ils ne sont donc plus modifiables depuis la console système) :

| Variable                                               | Rôle                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `MM_SERVICESETTINGS_ENABLEPOSTUSERNAMEOVERRIDE=true`   | Afficher le pseudo Discord de l'auteur                         |
| `MM_SERVICESETTINGS_ENABLEPOSTICONOVERRIDE=true`       | Afficher l'avatar Discord de l'auteur                          |
| `MM_SERVICESETTINGS_ENABLELINKPREVIEWS=true`           | Aperçu des liens, dont les GIF Tenor/Giphy envoyés depuis Discord |
| `MM_SERVICESETTINGS_ALLOWEDUNTRUSTEDINTERNALCONNECTIONS=bridge` | Autoriser Mattermost à appeler le bridge (boutons des sondages) |

### Nginx

| Variable     | Description                     | Exemple |
| ------------ | ------------------------------- | ------- |
| `NGINX_PORT` | Port exposé sur la machine hôte | `80`    |

### Bridge Discord

| Variable               | Description                                |
| ---------------------- | ------------------------------------------ |
| `DISCORD_TOKEN`        | Token du bot Discord                       |
| `DISCORD_SERVER`       | ID (ou nom) du serveur Discord à relier    |
| `DISCORD_CHANNEL`      | Salon Discord relié (ex. `general`)        |
| `MATTERMOST_BOT_TOKEN` | Token d'accès du compte bot Mattermost     |
| `MATTERMOST_TEAM`      | Nom de l'équipe Mattermost                 |
| `MATTERMOST_CHANNEL`   | Canal Mattermost relié (ex. `town-square`) |

Variables optionnelles : `BRIDGE_DEBUG=true` (logs détaillés), `TZ` (fuseau des dates affichées dans les sondages, `Europe/Paris` par défaut).

---

## Configurer le bridge Discord

Le bridge est un service Node.js / TypeScript écrit pour ce projet ([`mattermost/bridge/src`](mattermost/bridge/src)), basé sur [discord.js](https://discord.js.org) et l'API REST + WebSocket de Mattermost. Il remplace Matterbridge, qui n'est plus maintenu et ne relaie ni les réactions, ni les stickers, ni les sondages. Au démarrage, il vérifie que les variables du `.env` sont renseignées : les secrets ne sont jamais écrits dans le dépôt.

Le bridge parle directement à `mattermost:8065` via le réseau `frontend` ; il n'a pas accès au réseau `backend` (base de données). Il expose le port `8080` sur ce réseau uniquement (healthcheck et boutons de vote), sans le publier sur l'hôte.

### Ce qui est relayé

| Fonctionnalité         | Discord → Mattermost                                                         | Mattermost → Discord                                                                  |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Messages               | ✅ avec le pseudo et l'avatar Discord                                         | ✅ via webhook, avec le pseudo Mattermost                                              |
| Modifications / suppressions | ✅                                                                     | ✅                                                                                     |
| Réponses               | ✅ réponse dans le fil du message cité                                        | ✅ ligne « ↪ En réponse à … » avec lien vers le message (les webhooks Discord ne peuvent pas répondre nativement) |
| Réactions              | ✅ ajout et retrait (portées par le bot Mattermost)                           | ✅ ajout et retrait (portées par le bot Discord)                                       |
| Images, vidéos, fichiers | ✅ ré-uploadés dans Mattermost (les liens du CDN Discord expirent), jusqu'à 50 Mo | ✅ ré-uploadés dans Discord, dans la limite du serveur (10 Mo, 50/100 Mo selon les boosts) |
| Messages audio         | ✅ message vocal ré-uploadé en `.ogg` avec sa durée                           | ✅ fichier audio ; un fichier Ogg/Opus seul devient un message vocal Discord            |
| GIF                    | ✅ lien Tenor/Giphy avec aperçu, ou fichier GIF ré-uploadé                     | ✅ les GIF du sélecteur Mattermost sont envoyés en lien et intégrés par Discord        |
| Stickers               | ✅ image du sticker (PNG/APNG/GIF) ; nom seul pour les stickers animés Lottie | — (Mattermost n'a pas de stickers)                                                    |
| Sondages               | ✅ sondage natif → post avec boutons de vote, résultats mis à jour en direct  | ✅ `!sondage Question ? \| Réponse 1 \| Réponse 2` crée un sondage natif Discord (24 h, `!sondage+` pour plusieurs réponses) |

Pour les sondages, chaque côté vote avec ses propres outils (sondage natif sur Discord, boutons sur Mattermost) : le post Mattermost affiche le total des deux, et un message sous le sondage Discord affiche les votes venus de Mattermost.

Limites connues : une réaction relayée apparaît au nom du bot et non de l'utilisateur d'origine ; les emoji personnalisés ne passent que s'ils existent sous le même nom des deux côtés.

### 1. Créer le bot Discord

1. Aller sur le [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Onglet **Bot** → **Reset Token** et copier le token dans `DISCORD_TOKEN`.
3. Activer **Message Content Intent**.
4. Onglet **OAuth2 → URL Generator** : cocher `bot`, puis les permissions _View Channels_, _Send Messages_, _Read Message History_, _Add Reactions_, _Attach Files_, _Embed Links_, _Manage Webhooks_ (obligatoire : affichage du pseudo Mattermost) et _Manage Messages_ (optionnel : relayer sur Discord la suppression d'un message Discord faite depuis Mattermost).
5. Ouvrir l'URL générée et inviter le bot sur votre serveur.
6. Récupérer l'ID du serveur (mode développeur Discord → clic droit sur le serveur → _Copier l'identifiant_) dans `DISCORD_SERVER`.

### 2. Créer le bot Mattermost

1. **Console système → Intégrations → Comptes bot** : activer la création de comptes bot.
2. **Intégrations → Comptes bot → Ajouter** : créer un bot (ex. `discord-bridge`) et copier son token dans `MATTERMOST_BOT_TOKEN`.
3. Ajouter le bot à l'équipe et au canal à relier.

### 3. Relancer le bridge

```bash
docker compose up -d bridge
```

```bash
docker compose logs -f bridge
```

Un message posté dans le canal Mattermost doit apparaître dans le salon Discord, et inversement. Les logs indiquent `Mattermost : WebSocket connecté` et `Discord : connecté en tant que …` ; `docker compose ps` affiche le bridge `healthy` quand les deux connexions sont établies.

---

## Stack de développement

Le fichier [`docker-compose.dev.yml`](docker-compose.dev.yml) surcharge la configuration de production pour faciliter le développement et la mise au point de la configuration :

- **Compose Watch** : modification de `nginx.conf` ou de la configuration du bridge → synchronisation et redémarrage automatique du service ;
- ports de debug exposés (Mattermost `:8065`, PostgreSQL `:5432`) uniquement en local ;
- logs plus verbeux et absence de limites de ressources strictes.

Lancer le stack de dev :

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build --watch
```

---

## Fonctionnalités Docker avancées

| Fonctionnalité               | Mise en œuvre dans le projet                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Fragments / YAML anchors** | Bloc `x-common` (`restart`, rotation des logs `json-file`) réutilisé par tous les services via `<<: *common`.                            |
| **Networking**               | Réseaux `frontend` et `backend` séparés ; seul Nginx publie un port ; la base n'est jamais exposée.                                      |
| **Healthchecks**             | `pg_isready` pour PostgreSQL, `/api/v4/system/ping` pour Mattermost, requête HTTP pour Nginx ; `depends_on: condition: service_healthy`. |
| **Images personnalisées**    | Un `Dockerfile` par service dans `mattermost/<service>/` (healthcheck embarqué, utilisateur non-root, configuration intégrée).           |
| **Multi-stage build**        | Bridge compilé (TypeScript → JS, table d'emoji générée) dans un stage `builder` ; l'image finale ne contient que le JS et les dépendances de production. |
| **Cgroups**                  | Limites `cpus`, `memory` et `pids_limit` par service pour éviter qu'un service n'affame les autres.                                      |
| **Compose Watch**            | Rechargement automatique de la configuration en développement (`develop.watch`).                                                         |

---

## Sécurité

- **Secrets hors du dépôt** : `.env` est ignoré par Git, seul `.env.example` (valeurs factices) est versionné.
- **Surface d'exposition minimale** : un seul port publié (Nginx). Mattermost, PostgreSQL et le bridge ne sont accessibles que sur les réseaux internes.
- **Isolation réseau** : la base de données n'est joignable que par Mattermost ; le bridge passe par l'API Mattermost avec un compte bot aux droits limités.
- **Utilisateurs non-root** dans les conteneurs (`USER mattermost`, utilisateur dédié pour le bridge).
- **Images légères** basées sur Alpine / distroless pour réduire la surface d'attaque.
- **Rotation des logs** (`max-size: 10m`, `max-file: 3`) pour éviter la saturation du disque.
- **Limites de ressources** (cgroups) pour contenir l'impact d'un service compromis ou défaillant.

---

## Structure du projet

```text
.
├── docker-compose.yml          # Stack de production
├── docker-compose.dev.yml      # Surcharge pour le développement (watch, ports de debug)
├── .env.example                # Modèle des variables d'environnement
└── mattermost/
    ├── db/
    │   └── Dockerfile          # PostgreSQL 15 Alpine + healthcheck
    ├── mattermost/
    │   ├── Dockerfile          # Mattermost + healthcheck, utilisateur non-root
    │   └── config.json         # Configuration Mattermost de base
    ├── nginx/
    │   ├── Dockerfile          # Nginx Alpine
    │   └── nginx.conf          # Reverse proxy + upgrade WebSocket
    └── bridge/
        ├── Dockerfile              # Build multi-stage, utilisateur non-root, healthcheck
        ├── package.json            # discord.js (+ TypeScript, emoji-datasource au build)
        ├── scripts/build-emoji.mjs # Table nom Mattermost ⇄ emoji Unicode
        └── src/
            ├── index.ts            # Point d'entrée
            ├── bridge.ts           # Relais Discord ⇄ Mattermost
            ├── polls.ts            # Sondages synchronisés
            ├── mattermost.ts       # Client API REST + WebSocket Mattermost
            ├── store.ts            # Correspondance des IDs de messages (volume /data)
            └── http.ts             # Healthcheck et boutons de vote
```

---

## Commandes utiles

Afficher l'état et la santé des services :

```bash
docker compose ps
```

Suivre les logs d'un service :

```bash
docker compose logs -f mattermost
```

Valider la configuration Compose résolue (variables, fragments, surcharges) :

```bash
docker compose config
```

Observer la consommation de ressources (cgroups) :

```bash
docker stats
```

Inspecter un réseau et les conteneurs qui y sont attachés :

```bash
docker network inspect docker_backend
```

Arrêter le stack en conservant les données :

```bash
docker compose down
```

Tout supprimer, volumes compris :

```bash
docker compose down -v
```
