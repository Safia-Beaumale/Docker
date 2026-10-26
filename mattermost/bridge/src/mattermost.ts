import { EventEmitter } from 'node:events';
import { log } from './log.js';

export interface Post {
  id: string;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  edit_at: number;
  file_ids?: string[];
  props?: Record<string, unknown>;
}

export interface NewPost {
  channel_id: string;
  message: string;
  root_id?: string;
  file_ids?: string[];
  props?: Record<string, unknown>;
}

export interface Reaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
}

export interface User {
  id: string;
  username: string;
  nickname: string;
}

export interface FileInfo {
  id: string;
  name: string;
  size: number;
  mime_type: string;
}

export interface WsEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: { channel_id?: string };
}

export class MattermostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const USER_CACHE_MS = 10 * 60 * 1000;
const PING_EVERY_MS = 30 * 1000;

/** Client minimal de l'API REST v4 et du WebSocket Mattermost, authentifié par le token du bot. */
export class Mattermost extends EventEmitter<{ event: [WsEvent] }> {
  connected = false;
  private users = new Map<string, { user: User; at: number }>();
  private retries = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.url}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new MattermostError(res.status, `Mattermost ${method} ${path} : HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T;
  }

  me(): Promise<User> {
    return this.json('GET', '/users/me');
  }

  async channelId(teamName: string, channelName: string): Promise<string> {
    const team = await this.json<{ id: string }>('GET', `/teams/name/${encodeURIComponent(teamName)}`);
    const channel = await this.json<{ id: string }>(
      'GET',
      `/teams/${team.id}/channels/name/${encodeURIComponent(channelName)}`,
    );
    return channel.id;
  }

  async user(id: string): Promise<User> {
    const cached = this.users.get(id);
    if (cached && Date.now() - cached.at < USER_CACHE_MS) return cached.user;
    const user = await this.json<User>('GET', `/users/${id}`);
    this.users.set(id, { user, at: Date.now() });
    return user;
  }

  getPost(id: string): Promise<Post> {
    return this.json('GET', `/posts/${id}`);
  }

  createPost(post: NewPost): Promise<Post> {
    return this.json('POST', '/posts', post);
  }

  patchPost(id: string, patch: { message?: string; props?: Record<string, unknown> }): Promise<Post> {
    return this.json('PUT', `/posts/${id}/patch`, patch);
  }

  async deletePost(id: string): Promise<void> {
    await this.request('DELETE', `/posts/${id}`);
  }

  async uploadFile(channelId: string, name: string, data: Buffer): Promise<string> {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('files', new Blob([new Uint8Array(data)]), name);
    const res = await this.json<{ file_infos: FileInfo[] }>('POST', '/files', form);
    const info = res.file_infos[0];
    if (!info) throw new Error(`upload de ${name} : réponse vide`);
    return info.id;
  }

  fileInfo(id: string): Promise<FileInfo> {
    return this.json('GET', `/files/${id}/info`);
  }

  async downloadFile(id: string): Promise<Buffer> {
    return Buffer.from(await (await this.request('GET', `/files/${id}`)).arrayBuffer());
  }

  async addReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    await this.request('POST', '/reactions', { user_id: userId, post_id: postId, emoji_name: emojiName });
  }

  async removeReaction(userId: string, postId: string, emojiName: string): Promise<void> {
    await this.request('DELETE', `/users/${userId}/posts/${postId}/reactions/${encodeURIComponent(emojiName)}`);
  }

  async reactions(postId: string): Promise<Reaction[]> {
    return (await this.json<Reaction[] | null>('GET', `/posts/${postId}/reactions`)) ?? [];
  }

  /** Ouvre le WebSocket et se reconnecte automatiquement (backoff exponentiel plafonné à 30 s). */
  connect(): void {
    const ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/api/v4/websocket`);
    let seq = 1;
    let lastSeen = Date.now();
    let pinger: NodeJS.Timeout | undefined;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ seq: seq++, action: 'authentication_challenge', data: { token: this.token } }));
      // Détecte une connexion morte sans fermeture propre
      pinger = setInterval(() => {
        if (Date.now() - lastSeen > 3 * PING_EVERY_MS) ws.close();
        else ws.send(JSON.stringify({ seq: seq++, action: 'ping' }));
      }, PING_EVERY_MS);
    });

    ws.addEventListener('message', (ev) => {
      lastSeen = Date.now();
      let msg: Partial<WsEvent>;
      try {
        msg = JSON.parse(String(ev.data)) as Partial<WsEvent>;
      } catch {
        return;
      }
      if (msg.event === 'hello') {
        this.connected = true;
        this.retries = 0;
        log.info('Mattermost : WebSocket connecté');
      } else if (msg.event) {
        this.emit('event', msg as WsEvent);
      }
    });

    ws.addEventListener('close', (ev) => {
      clearInterval(pinger);
      this.connected = false;
      const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
      log.warn(`Mattermost : WebSocket fermé (code ${ev.code}), reconnexion dans ${delay / 1000} s`);
      setTimeout(() => this.connect(), delay);
    });

    // Une erreur est toujours suivie d'un événement close, qui gère la reconnexion
    ws.addEventListener('error', () => {});
  }
}
