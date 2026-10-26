import { Bridge } from './bridge.js';
import { config } from './config.js';
import { startHttp } from './http.js';
import { log } from './log.js';
import { Mattermost } from './mattermost.js';
import { Store } from './store.js';

const store = new Store(config.dataFile);
const bridge = new Bridge(new Mattermost(config.mattermost.url, config.mattermost.token), store);

startHttp(config.http.port, {
  status: () => bridge.status(),
  action: (body) => bridge.polls.handleAction(body),
});

process.on('unhandledRejection', (err) => log.error('Erreur non gérée :', err));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} reçu, arrêt du bridge`);
    store.flush();
    void bridge.discord.destroy().finally(() => process.exit(0));
  });
}

try {
  await bridge.start();
} catch (err) {
  log.error('Démarrage impossible :', err);
  store.flush();
  process.exit(1);
}
