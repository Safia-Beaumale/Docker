# IM Bridge — Mattermost ⇄ Discord

> Un stack **Docker Compose** multi-services qui héberge un serveur de messagerie d'entreprise (**Mattermost**) et le relie en temps réel à **Discord** grâce à un bridge écrit sur mesure en TypeScript.

---

## 1. Le problème

Les utilisateurs sont dispersés sur plusieurs messageries concurrentes. L'entreprise utilise **Mattermost**, mais une partie des personnes reste sur **Discord** et ne veut pas changer d'outil.

**Objectif :** que chacun puisse discuter **depuis et vers** Mattermost avec son propre compte, sans quitter sa messagerie habituelle.

```mermaid
flowchart LR
    subgraph avant ["Avant : deux îlots"]
        direction TB
        A1([Équipe sur Mattermost])
        A2([Équipe sur Discord])
        A1 x--x A2
    end

    subgraph apres ["Après : une seule conversation"]
        direction TB
        B1([Équipe sur Mattermost]) <-->|messages, réactions,<br/>fichiers, sondages| BR{{Bridge}}
        BR <--> B2([Équipe sur Discord])
    end

    avant ==> apres
```

### Objectifs pédagogiques

| Thème              | Ce que le projet met en pratique                                |
| ------------------ | --------------------------------------------------------------- |
| Docker Compose     | Orchestrer 5 services qui dépendent les uns des autres          |
| Networking         | Réseaux séparés, DNS interne, un seul port exposé               |
| Sécurité           | Secrets hors dépôt, utilisateurs non-root, isolation de la base |
| Fonctions avancées | Fragments YAML, healthchecks, build multi-stage                 |
| Exploitation       | Page de statut, rotation des logs, persistance par volumes      |

---

## 2. Vue d'ensemble de l'architecture

```mermaid
flowchart TB
    user([Navigateur /<br/>app Mattermost])
    discord([Discord])

    subgraph host ["Machine hôte"]
        port{{"port 80"}}

        subgraph frontend ["réseau frontend"]
            nginx["Nginx<br/>reverse proxy"]
            bridge["Bridge<br/>Node.js / TypeScript<br/>:8080"]
            status["Gatus<br/>page de statut<br/>:8080"]
        end

        subgraph backend ["réseau backend"]
            db[("PostgreSQL 15")]
        end

        mattermost["Mattermost 9.11<br/>:8065"]
    end

    user -->|HTTP| port --> nginx
    nginx -->|localhost| mattermost
    nginx -->|status.localhost| status
    mattermost --> db
    bridge <-->|API REST + WebSocket<br/>compte bot| mattermost
    bridge <-->|Gateway + webhook<br/>bot Discord| discord
    status -.->|sonde toutes les 30 s| nginx & mattermost & bridge

    classDef net fill:#eef6ff,stroke:#4a90d9
    classDef data fill:#fff4e5,stroke:#e0a030
    class nginx,bridge,status net
    class db data
```

**Mattermost est le seul service présent sur les deux réseaux** : il fait le pont entre la partie exposée (frontend) et la base de données (backend).

### Les 5 services

| Service      | Image de base                                | Rôle                                                             | Réseaux            |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------- | ------------------ |
| `db`         | `postgres:15-alpine`                         | Base de données de Mattermost                                    | backend            |
| `mattermost` | `mattermost-enterprise-edition:release-9.11` | Serveur de messagerie (API + WebSocket)                          | frontend + backend |
| `nginx`      | `nginx:alpine`                               | Point d'entrée unique, upgrade WebSocket, routage par nom d'hôte | frontend           |
| `bridge`     | `node:24-alpine`                             | Relais Mattermost ⇄ Discord (code maison)                        | frontend           |
| `status`     | `gatus:v5.37.0`                              | Page de statut sur `status.localhost`                            | frontend           |

---

## 3. Networking : qui peut parler à qui ?

```mermaid
flowchart TB
    ext([Internet / hôte])

    subgraph frontend ["frontend"]
        nginx[Nginx]
        bridge[Bridge]
        status[Gatus]
        mm1[Mattermost]
    end

    subgraph backend ["backend"]
        mm2[Mattermost]
        db[(PostgreSQL)]
    end

    ext ==>|"seul port publié : 80"| nginx
    nginx --> mm1
    bridge --> mm1
    status --> mm1
    mm2 --> db

    mm1 -. "même conteneur" .- mm2

    ext x-.-x|aucun accès| db
    bridge x-.-x|aucun accès| db
    nginx x-.-x|aucun accès| db
```

Points clés :

- **Un seul port publié sur l'hôte** (Nginx). Mattermost, le bridge et Gatus ne sont joignables que par le réseau Docker.
- **PostgreSQL est enfermé dans `backend`** : ni l'extérieur, ni Nginx, ni le bridge ne peuvent l'atteindre.
- **DNS interne Docker** : les services s'appellent par leur nom (`mattermost:8065`, `bridge:8080`). Nginx utilise le résolveur `127.0.0.11` et re-résout l'adresse à chaque requête, pour ne pas renvoyer d'erreur 502 quand un conteneur est recréé.
- **Routage par nom d'hôte** : sur le même port 80, `localhost` → Mattermost et `status.localhost` → page de statut.

---

## 4. Démarrage ordonné par healthchecks

Chaque service attend que ses dépendances soient réellement **prêtes** (pas seulement démarrées) grâce à `depends_on: condition: service_healthy`.

```mermaid
flowchart LR
    db["db<br/><code>pg_isready</code>"]
    mm["mattermost<br/><code>GET /api/v4/system/ping</code>"]
    nginx["nginx<br/><code>curl localhost:80</code>"]
    bridge["bridge<br/><code>GET /health</code>"]
    status["status<br/>(indépendant)"]

    db -->|healthy| mm
    mm -->|healthy| nginx
    mm -->|healthy| bridge

    style db fill:#d4edda,stroke:#28a745
    style mm fill:#d4edda,stroke:#28a745
    style nginx fill:#d4edda,stroke:#28a745
    style bridge fill:#d4edda,stroke:#28a745
```

Le healthcheck du bridge renvoie **503 tant que l'une des deux connexions** (Mattermost ou Discord) est coupée : `docker compose ps` affiche donc un état fidèle à la réalité.

---

## 5. Le bridge : un service écrit pour le projet

Matterbridge (la solution habituelle) n'est plus maintenu et ne relaie ni les réactions, ni les stickers, ni les sondages. Le projet embarque donc **son propre bridge** (~1 400 lignes de TypeScript, basé sur `discord.js`).

### Architecture interne

```mermaid
flowchart TB
    index["index.ts<br/>point d'entrée, arrêt propre"]
    config["config.ts<br/>lecture et vérification du .env"]
    bridge["bridge.ts<br/>relais Discord ⇄ Mattermost"]
    polls["polls.ts<br/>sondages synchronisés"]
    mm["mattermost.ts<br/>client REST + WebSocket<br/>reconnexion automatique"]
    store["store.ts<br/>correspondance des IDs<br/>de messages"]
    http["http.ts<br/>/health + boutons de vote"]
    emoji["emoji.ts<br/>noms Mattermost ⇄ Unicode"]

    vol[("volume bridge-data<br/>/data/state.json")]
    djs[["discord.js"]]

    index --> config
    index --> bridge
    index --> http
    bridge --> polls
    bridge --> mm
    bridge --> store
    bridge --> emoji
    bridge --> djs
    polls --> store
    store --> vol
```

```mermaid
pie showData
    title Répartition du code du bridge (lignes)
    "bridge.ts (relais)" : 490
    "polls.ts (sondages)" : 315
    "mattermost.ts (client API)" : 206
    "store.ts (persistance)" : 124
    "utilitaires (http, config, emoji, log, util)" : 225
```

### Ce qui est relayé

| Fonctionnalité                            | Discord → Mattermost | Mattermost → Discord |
| ----------------------------------------- | :------------------: | :------------------: |
| Messages (avec pseudo + avatar d'origine) |          ✅          |          ✅          |
| Modifications / suppressions              |          ✅          |          ✅          |
| Réponses dans un fil                      |          ✅          |          ✅          |
| Réactions (ajout / retrait)               |          ✅          |          ✅          |
| Images, vidéos, fichiers                  |          ✅          |          ✅          |
| Messages vocaux                           |          ✅          |          ✅          |
| GIF (Tenor, Giphy…)                       |          ✅          |          ✅          |
| Stickers                                  |          ✅          |          —           |
| Sondages (votes croisés)                  |          ✅          |          ✅          |

---

## 6. Parcours d'un message : Discord → Mattermost

```mermaid
sequenceDiagram
    autonumber
    actor Alice as Alice (Discord)
    participant D as Discord
    participant B as Bridge
    participant S as Store
    participant M as Mattermost
    actor Bob as Bob (Mattermost)

    Alice->>D: Envoie un message + une image
    D->>B: Événement MessageCreate (Gateway)
    B->>B: Message posté par le bridge lui-même ? sinon on continue
    B->>D: Télécharge l'image (le lien du CDN Discord expire)
    B->>M: Upload du fichier (API REST)
    B->>M: Crée le post avec pseudo et avatar d'Alice
    M-->>B: ID du post Mattermost
    B->>S: Mémorise ID Discord ⇄ ID Mattermost
    M->>Bob: Affiche « Alice (Discord) » en temps réel
```

La table de correspondance des IDs (`store.ts`) est la clé de voûte : sans elle, impossible de relayer une **réponse**, une **réaction**, une **modification** ou une **suppression** sur le bon message. Elle est persistée dans un volume pour survivre aux redémarrages.

---

## 7. Parcours d'un message : Mattermost → Discord

```mermaid
sequenceDiagram
    autonumber
    actor Bob as Bob (Mattermost)
    participant M as Mattermost
    participant B as Bridge
    participant S as Store
    participant W as Webhook Discord
    actor Alice as Alice (Discord)

    Bob->>M: Répond au message d'Alice
    M->>B: Événement « posted » (WebSocket)
    B->>B: Post du bot ou message système ? sinon on continue
    B->>S: Quel message Discord correspond au fil ?
    S-->>B: ID du message d'Alice
    B->>W: Envoie le texte sous le nom de Bob + ligne « ↪ En réponse à … »
    W-->>B: ID du message Discord
    B->>S: Mémorise la nouvelle correspondance
    W->>Alice: Affiche le message de Bob
```

**Anti-boucle :** le bridge ignore systématiquement ses propres messages (webhook ou compte bot), sinon chaque message serait renvoyé à l'infini entre les deux plateformes.

---

## 8. Cas avancé : les sondages synchronisés

Chaque plateforme vote avec ses propres outils, et le bridge additionne les résultats.

```mermaid
sequenceDiagram
    autonumber
    actor Alice as Alice (Discord)
    participant D as Discord
    participant B as Bridge
    participant M as Mattermost
    actor Bob as Bob (Mattermost)

    Alice->>D: Crée un sondage natif Discord
    D->>B: MessageCreate avec un sondage
    B->>M: Post avec un bouton par réponse
    Bob->>M: Clique sur « Réponse 2 »
    M->>B: POST bridge:8080/mattermost/actions
    B->>M: Met à jour le post (total Discord + Mattermost)
    B->>D: Met à jour le message « votes Mattermost » sous le sondage
    Alice->>D: Vote sur Discord
    D->>B: MessagePollVoteAdd
    B->>M: Rafraîchit les résultats (regroupés toutes les 1,5 s)
```

Côté Mattermost, la commande `!sondage Question ? | Réponse 1 | Réponse 2` crée un sondage natif Discord. Cet appel retour de Mattermost vers le bridge est rendu possible par `MM_SERVICESETTINGS_ALLOWEDUNTRUSTEDINTERNALCONNECTIONS=bridge`.

---

## 9. Images Docker personnalisées

Chaque service a son propre `Dockerfile` dans `mattermost/<service>/`.

### Build multi-stage du bridge

```mermaid
flowchart TB
    subgraph builder ["Stage builder : node:24-alpine"]
        direction LR
        a["npm ci<br/>(toutes les dépendances)"] --> b["tsc<br/>TypeScript → JavaScript"]
        b --> c["build-emoji.mjs<br/>génère la table d'emoji"]
        c --> d["npm prune --omit=dev"]
    end

    subgraph final ["Image finale : node:24-alpine"]
        direction LR
        e["dist/ (JS compilé)"]
        f["node_modules<br/>production uniquement"]
        g["USER node<br/>HEALTHCHECK /health"]
    end

    d -->|COPY --from=builder| e & f

    x["❌ TypeScript, sources,<br/>emoji-datasource, types"]
    builder -.->|non copié| x
```

L'image finale ne contient **ni le compilateur, ni les sources, ni les dépendances de développement** : elle est plus légère et offre moins de surface d'attaque.

### Gatus : un mini multi-stage pour une image `FROM scratch`

L'image Gatus n'a pas de shell. Le dossier `/data` est préparé dans un stage Alpine puis copié avec le bon propriétaire (`nobody`), ce qui permet de faire tourner Gatus **en non-root**.

---

## 10. Fragments YAML : ne pas se répéter

```mermaid
flowchart LR
    common["x-common: &common<br/>restart: unless-stopped<br/>logs json-file<br/>max-size 10m, max-file 3"]

    common -->|"<<: *common"| db & mattermost & nginx & bridge & status
```

Un seul bloc définit la politique de redémarrage et la **rotation des logs** (3 fichiers de 10 Mo maximum par service, pour ne jamais saturer le disque). Tous les services en héritent.

---

## 11. Supervision : la page de statut

Gatus sonde les services toutes les 30 secondes et conserve l'historique (SQLite dans un volume).

```mermaid
flowchart LR
    g["Gatus<br/>status.localhost"]

    g -->|"GET nginx/api/v4/system/ping"| n["Nginx<br/>chemin complet utilisateur"]
    g -->|"GET mattermost:8065/…/ping"| m["Mattermost<br/>+ stockage fichiers"]
    m -->|"champ database_status"| p[("PostgreSQL")]
    g -->|"GET bridge:8080/health"| b1["Bridge : connexion Mattermost"]
    g -->|"GET bridge:8080/health"| b2["Bridge : connexion Discord"]
    g -->|"toutes les 5 min"| api(["API Discord publique"])
```

Gatus n'est que sur `frontend` : **il ne touche jamais la base**. L'état de PostgreSQL est lu indirectement, via la réponse de Mattermost.

---

## 12. Sécurité : défense en profondeur

```mermaid
mindmap
  root((Sécurité))
    Secrets
      .env ignoré par Git
      .env.example avec valeurs factices
      vérification des variables au démarrage
    Réseau
      un seul port publié
      base isolée dans backend
      bridge limité à l'API Mattermost
    Conteneurs
      utilisateurs non-root
      images Alpine légères
      multi-stage sans outils de build
    Comptes
      bot Mattermost dédié
      bot Discord aux permissions ciblées
    Robustesse
      healthchecks
      rotation des logs
      taille des fichiers et requêtes bornée
```

---

## 13. Persistance des données

```mermaid
flowchart TB
    db[db] --- v1[(db-data)]
    mm[mattermost] --- v2[(mm-data)] & v3[(mm-config)] & v4[(mm-logs)] & v5[(mm-plugins)]
    bridge[bridge] --- v6[("bridge-data<br/>correspondance des IDs")]
    status[status] --- v7[("status-data<br/>historique")]
```

`docker compose down` conserve tout ; seul `docker compose down -v` efface les volumes.

---

## 14. Démonstration

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

```bash
docker compose ps
```

1. Ouvrir <http://localhost> : Mattermost.
2. Ouvrir <http://status.localhost> : tous les services au vert.
3. Écrire sur Discord → le message apparaît sur Mattermost avec le pseudo et l'avatar Discord.
4. Répondre, réagir, envoyer une image depuis Mattermost → tout arrive sur Discord.
5. Lancer `!sondage Pizza ou burger ? | Pizza | Burger` et voter des deux côtés.

---

## 15. Bilan et perspectives

**Réalisé**

- Stack de 5 services orchestrés, démarrage ordonné par healthchecks.
- Isolation réseau frontend / backend, un seul port exposé.
- Images personnalisées, non-root, build multi-stage.
- Bridge complet : messages, fils, réactions, fichiers, audio, GIF, stickers, sondages.
- Page de statut et persistance de l'état du bridge.

**Pistes d'amélioration**

- Ajouter des limites cgroups (`cpus`, `memory`, `pids_limit`) par service.
- Passer en HTTPS (certificat sur Nginx).
- Relier plusieurs salons, voire d'autres messageries (Slack, Teams…).
