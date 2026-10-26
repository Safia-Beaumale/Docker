import { createServer, type IncomingMessage } from 'node:http';
import { log } from './log.js';

const MAX_BODY = 64 * 1024;

interface Handlers {
  healthy: () => boolean;
  /** Boutons interactifs Mattermost (votes des sondages) */
  action: (body: object) => Promise<object>;
}

async function readJson(req: IncomingMessage): Promise<object> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('requête trop volumineuse');
    chunks.push(chunk as Buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof body !== 'object' || body === null) throw new Error('JSON invalide');
  return body;
}

/** Serveur HTTP interne : healthcheck Docker et callbacks des boutons Mattermost. */
export function startHttp(port: number, handlers: Handlers): void {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const ok = handlers.healthy();
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' }).end(ok ? 'ok' : 'starting');
      } else if (req.method === 'POST' && req.url === '/mattermost/actions') {
        const result = await handlers.action(await readJson(req));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      log.warn(`HTTP ${req.method} ${req.url} :`, err);
      if (!res.headersSent) res.writeHead(400).end();
    }
  });
  server.listen(port, () => log.info(`HTTP : écoute sur le port ${port}`));
}
