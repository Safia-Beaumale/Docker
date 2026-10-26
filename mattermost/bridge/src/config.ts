// Toute la configuration vient du .env (via docker-compose). Aucun secret dans le code.
const REQUIRED = [
  'DISCORD_TOKEN',
  'DISCORD_SERVER',
  'DISCORD_CHANNEL',
  'MATTERMOST_BOT_TOKEN',
  'MATTERMOST_TEAM',
  'MATTERMOST_CHANNEL',
] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`bridge: variables manquantes dans .env : ${missing.join(' ')}`);
  process.exit(1);
}

const env = (name: (typeof REQUIRED)[number]): string => process.env[name] as string;
const trimSlash = (url: string): string => url.replace(/\/+$/, '');

export const config = {
  discord: {
    token: env('DISCORD_TOKEN'),
    // ID ou nom du serveur / du salon
    server: env('DISCORD_SERVER'),
    channel: env('DISCORD_CHANNEL').replace(/^#/, ''),
  },
  mattermost: {
    // Accès direct au conteneur via le réseau Docker (pas de passage par Nginx)
    url: trimSlash(process.env.MATTERMOST_URL ?? 'http://mattermost:8065'),
    token: env('MATTERMOST_BOT_TOKEN'),
    team: env('MATTERMOST_TEAM'),
    channel: env('MATTERMOST_CHANNEL'),
  },
  http: {
    port: Number(process.env.BRIDGE_PORT ?? 8080),
    // URL à laquelle Mattermost joint le bridge (boutons des sondages)
    url: trimSlash(process.env.BRIDGE_URL ?? 'http://bridge:8080'),
  },
  dataFile: process.env.BRIDGE_DATA_FILE ?? '/data/state.json',
  timeZone: process.env.TZ ?? 'Europe/Paris',
};
