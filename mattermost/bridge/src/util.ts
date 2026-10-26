import { log } from './log.js';

export const MB = 1024 * 1024;

export function formatSize(bytes: number): string {
  return `${(bytes / MB).toFixed(1).replace('.', ',')} Mo`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** Télécharge une ressource en mémoire en refusant tout ce qui dépasse `maxBytes`. */
export async function download(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} en téléchargeant ${url}`);
  const announced = Number(res.headers.get('content-length') ?? 0);
  if (announced > maxBytes) throw new Error(`fichier trop volumineux (${formatSize(announced)})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`fichier trop volumineux (${formatSize(data.length)})`);
  return data;
}

/**
 * File d'exécution séquentielle : les événements sont traités dans l'ordre
 * d'arrivée, pour qu'une réponse ou une réaction ne soit jamais relayée avant
 * le message auquel elle se rapporte.
 */
export class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  push(label: string, task: () => Promise<unknown>): void {
    this.tail = this.tail.then(task).catch((err: unknown) => log.error(`${label} :`, err));
  }
}

/** Regroupe les appels rapprochés (ex. une rafale de votes) en un seul. */
export class Debouncer {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly delayMs: number) {}

  run(key: string, task: () => void): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        task();
      }, this.delayMs),
    );
  }
}
