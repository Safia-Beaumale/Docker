import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';
import type { PollState } from './polls.js';

/** Un message relayé : ID Discord, ID du post Mattermost et racine de son fil Mattermost. */
interface Link {
  d: string;
  m: string;
  r?: string;
}

interface Persisted {
  links?: Link[];
  polls?: PollState[];
}

const MAX_LINKS = 20_000;
const POLL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Correspondance des IDs de messages entre les deux plateformes, indispensable
 * pour relayer réponses, réactions, modifications et suppressions. Persistée en
 * JSON dans le volume /data pour survivre aux redémarrages.
 */
export class Store {
  private byDiscord = new Map<string, Link>();
  private byMm = new Map<string, Link>();
  readonly polls = new Map<string, PollState>();
  private saveTimer?: NodeJS.Timeout;

  constructor(private readonly file: string) {
    let data: Persisted;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as Persisted;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`État illisible (${file}), on repart de zéro :`, err);
      return;
    }
    for (const link of data.links ?? []) this.add(link);
    const now = Date.now();
    for (const poll of data.polls ?? []) {
      if (!poll.finalized || (poll.expiresAt ?? now) > now - POLL_RETENTION_MS) this.polls.set(poll.discordId, poll);
    }
    log.info(`État chargé : ${this.byDiscord.size} messages, ${this.polls.size} sondages`);
  }

  link(discordId: string, mmId: string, mmRootId?: string): void {
    this.add({ d: discordId, m: mmId, r: mmRootId || undefined });
    this.save();
  }

  mmFor(discordId: string): string | undefined {
    return this.byDiscord.get(discordId)?.m;
  }

  discordFor(mmId: string): string | undefined {
    return this.byMm.get(mmId)?.d;
  }

  /** Racine du fil Mattermost d'un post relayé (Mattermost n'accepte de répondre qu'à une racine). */
  mmRootFor(mmId: string): string {
    return this.byMm.get(mmId)?.r ?? mmId;
  }

  unlinkDiscord(discordId: string): string | undefined {
    const link = this.byDiscord.get(discordId);
    if (link) this.remove(link);
    return link?.m;
  }

  unlinkMm(mmId: string): string | undefined {
    const link = this.byMm.get(mmId);
    if (link) this.remove(link);
    return link?.d;
  }

  savePoll(poll: PollState): void {
    this.polls.set(poll.discordId, poll);
    this.save();
  }

  deletePoll(discordId: string): void {
    if (this.polls.delete(discordId)) this.save();
  }

  /** Écriture différée : regroupe les modifications rapprochées en une seule écriture disque. */
  save(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 1000);
  }

  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      const data: Persisted = { links: [...this.byDiscord.values()], polls: [...this.polls.values()] };
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.file);
    } catch (err) {
      log.error(`Impossible d'écrire ${this.file} :`, err);
    }
  }

  private add(link: Link): void {
    this.byDiscord.set(link.d, link);
    this.byMm.set(link.m, link);
    // Les Map gardent l'ordre d'insertion : on oublie les messages les plus anciens
    for (const oldest of this.byDiscord.values()) {
      if (this.byDiscord.size <= MAX_LINKS) break;
      this.remove(oldest);
    }
  }

  private remove(link: Link): void {
    this.byDiscord.delete(link.d);
    this.byMm.delete(link.m);
    this.save();
  }
}
