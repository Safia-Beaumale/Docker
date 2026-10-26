import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Message, Poll, PollAnswer, PartialPollAnswer } from 'discord.js';
import type { Bridge } from './bridge.js';
import { config } from './config.js';
import { log } from './log.js';
import type { Post } from './mattermost.js';
import { Debouncer, truncate } from './util.js';

/**
 * Un sondage relayé. Le sondage natif Discord fait foi pour les votes Discord ;
 * les votes Mattermost (boutons interactifs) sont comptés par le bridge.
 * Chaque côté affiche le total des deux.
 */
export interface PollState {
  discordId: string;
  mmId: string;
  author: string;
  question: string;
  answers: { id: number; text: string; emoji?: string }[];
  multi: boolean;
  expiresAt: number | null;
  finalized: boolean;
  discordCounts: Record<string, number>;
  /** ID utilisateur Mattermost → réponses choisies */
  mmVotes: Record<string, number[]>;
  /** Props d'identité du post Mattermost (pseudo/avatar Discord) */
  mmProps: Record<string, unknown>;
  /** Message Discord qui affiche les votes Mattermost */
  companionId?: string;
}

interface PollCommand {
  question: string;
  answers: string[];
  multi: boolean;
}

interface ActionRequest {
  user_id?: string;
  context?: { poll?: string; answer?: number; sig?: string };
}

const POLL_HOURS = 24;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const USAGE = [
  'Pour créer un sondage visible sur Mattermost et Discord :',
  '`!sondage Question ? | Réponse 1 | Réponse 2 | …` (2 à 10 réponses, durée 24 h)',
  '`!sondage+ …` pour autoriser plusieurs réponses.',
].join('\n');

export function parsePollCommand(text: string): PollCommand | undefined {
  const match = /^!sondage(\+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return undefined;
  const parts = (match[2] ?? '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  return { multi: Boolean(match[1]), question: parts[0] ?? '', answers: parts.slice(1) };
}

function sign(pollId: string): string {
  return createHmac('sha256', config.mattermost.token).update(`poll:${pollId}`).digest('hex');
}

function validSignature(pollId: string, sig: unknown): boolean {
  if (typeof sig !== 'string') return false;
  const expected = Buffer.from(sign(pollId));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function answerEmoji(answer: PollAnswer | PartialPollAnswer): string | undefined {
  const emoji = answer.emoji;
  if (!emoji?.name) return undefined;
  return emoji.id ? `:${emoji.name.toLowerCase()}:` : emoji.name;
}

function countsOf(poll: Poll): Record<string, number> {
  return Object.fromEntries([...poll.answers.values()].map((answer) => [answer.id, answer.voteCount ?? 0]));
}

function plural(n: number): string {
  return `${n} vote${n > 1 ? 's' : ''}`;
}

export class Polls {
  private debounce = new Debouncer(1500);
  private expiryTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly bridge: Bridge) {}

  /** Programme la mise à jour des sondages encore ouverts (après un redémarrage). */
  resume(): void {
    for (const poll of this.bridge.store.polls.values()) {
      if (!poll.finalized) this.watchExpiry(poll);
    }
  }

  /** Sondage natif créé sur Discord → post Mattermost avec boutons de vote. */
  async fromDiscord(msg: Message): Promise<void> {
    const poll = msg.poll;
    if (!poll) return;
    const identity = this.bridge.identity(msg);
    const state: PollState = {
      discordId: msg.id,
      mmId: '',
      author: String(identity.override_username),
      question: poll.question.text ?? '',
      answers: [...poll.answers.values()].map((a) => ({ id: a.id, text: a.text ?? '', emoji: answerEmoji(a) })),
      multi: poll.allowMultiselect,
      expiresAt: poll.expiresTimestamp,
      finalized: poll.resultsFinalized,
      discordCounts: countsOf(poll),
      mmVotes: {},
      mmProps: identity,
    };
    const post = await this.bridge.mm.createPost({ channel_id: this.bridge.mmChannelId, ...this.render(state) });
    state.mmId = post.id;
    this.bridge.store.link(msg.id, post.id);
    this.bridge.store.savePoll(state);
    this.watchExpiry(state);
  }

  /** Commande `!sondage` sur Mattermost → sondage natif Discord + post Mattermost avec boutons. */
  async fromMattermost(post: Post, cmd: PollCommand): Promise<void> {
    const bridge = this.bridge;
    if (!cmd.question || cmd.answers.length < 2 || cmd.answers.length > 10) {
      await bridge.mm.createPost({ channel_id: bridge.mmChannelId, root_id: post.root_id || post.id, message: USAGE });
      return;
    }
    const author = await bridge.mmDisplayName(post.user_id);
    const sent = await bridge.webhook.send({
      username: bridge.webhookName(author),
      allowedMentions: { parse: [] },
      poll: {
        question: { text: truncate(cmd.question, 300) },
        answers: cmd.answers.map((text) => ({ text: truncate(text, 55) })),
        duration: POLL_HOURS,
        allowMultiselect: cmd.multi,
      },
    });
    const poll = sent.poll;
    const state: PollState = {
      discordId: sent.id,
      mmId: '',
      author,
      question: cmd.question,
      answers: poll
        ? [...poll.answers.values()].map((a) => ({ id: a.id, text: a.text ?? '' }))
        : cmd.answers.map((text, i) => ({ id: i + 1, text })),
      multi: cmd.multi,
      expiresAt: poll?.expiresTimestamp ?? Date.now() + POLL_HOURS * 3600 * 1000,
      finalized: false,
      discordCounts: {},
      mmVotes: {},
      mmProps: {},
    };
    const mmPost = await bridge.mm.createPost({
      channel_id: bridge.mmChannelId,
      root_id: post.root_id || undefined,
      ...this.render(state),
    });
    state.mmId = mmPost.id;
    bridge.store.link(sent.id, mmPost.id, post.root_id);
    bridge.store.savePoll(state);
    this.watchExpiry(state);
  }

  /** Appelé à chaque vote Discord ou mise à jour du message de sondage. */
  discordChanged(messageId: string): void {
    if (!this.bridge.store.polls.has(messageId)) return;
    this.debounce.run(`discord:${messageId}`, () =>
      this.bridge.queue.push('mise à jour du sondage', () => this.refresh(messageId)),
    );
  }

  forget(discordId: string): void {
    clearTimeout(this.expiryTimers.get(discordId));
    this.expiryTimers.delete(discordId);
    this.bridge.store.deletePoll(discordId);
  }

  /** Clic sur un bouton de vote Mattermost (requête envoyée par le serveur Mattermost). */
  async handleAction(body: ActionRequest): Promise<object> {
    const pollId = String(body.context?.poll ?? '');
    if (!validSignature(pollId, body.context?.sig)) return { ephemeral_text: 'Action invalide.' };
    const state = this.bridge.store.polls.get(pollId);
    if (!state) return { ephemeral_text: 'Ce sondage n’existe plus.' };
    if (this.closed(state)) return { update: this.render(state), ephemeral_text: 'Ce sondage est terminé.' };
    const answer = state.answers.find((a) => a.id === Number(body.context?.answer));
    const userId = body.user_id;
    if (!answer || !userId) return { ephemeral_text: 'Action invalide.' };

    const current = state.mmVotes[userId] ?? [];
    const removing = current.includes(answer.id);
    const next = removing ? current.filter((id) => id !== answer.id) : state.multi ? [...current, answer.id] : [answer.id];
    if (next.length > 0) state.mmVotes[userId] = next;
    else delete state.mmVotes[userId];
    this.bridge.store.savePoll(state);

    this.debounce.run(`companion:${pollId}`, () =>
      this.bridge.queue.push('votes Mattermost vers Discord', () => this.updateCompanion(pollId)),
    );
    return {
      update: this.render(state),
      ephemeral_text: `${removing ? 'Vote retiré' : 'Vote enregistré'} : ${answer.text}`,
    };
  }

  private closed(state: PollState): boolean {
    return state.finalized || (state.expiresAt !== null && Date.now() >= state.expiresAt);
  }

  private mmCount(state: PollState, answerId: number): number {
    return Object.values(state.mmVotes).filter((votes) => votes.includes(answerId)).length;
  }

  private render(state: PollState): { message: string; props: Record<string, unknown> } {
    const closed = this.closed(state);
    const lines = state.answers.map((answer) => {
      const fromDiscord = state.discordCounts[answer.id] ?? 0;
      const fromMm = this.mmCount(state, answer.id);
      const label = `${answer.emoji ? `${answer.emoji} ` : ''}**${answer.text}**`;
      return `${label} — ${plural(fromDiscord + fromMm)} _(Discord ${fromDiscord} · Mattermost ${fromMm})_`;
    });
    const end = state.expiresAt
      ? new Date(state.expiresAt).toLocaleString('fr-FR', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: config.timeZone,
        })
      : undefined;
    const footer = [
      state.multi ? 'Plusieurs réponses possibles' : 'Une seule réponse',
      closed ? 'Sondage terminé' : end ? `Fin : ${end}` : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    const sig = sign(state.discordId);
    return {
      message: `📊 **Sondage de ${state.author}** : ${state.question}`,
      props: {
        ...state.mmProps,
        attachments: [
          {
            fallback: state.question,
            color: closed ? '#8e9297' : '#5865F2',
            text: lines.join('\n'),
            footer,
            actions: closed
              ? []
              : state.answers.map((answer) => ({
                  id: `vote${answer.id}`,
                  type: 'button',
                  name: truncate(answer.text, 40),
                  integration: {
                    url: `${config.http.url}/mattermost/actions`,
                    context: { poll: state.discordId, answer: answer.id, sig },
                  },
                })),
          },
        ],
      },
    };
  }

  private async refresh(discordId: string): Promise<void> {
    const state = this.bridge.store.polls.get(discordId);
    if (!state) return;
    const msg = await this.bridge.channel.messages.fetch({ message: discordId, force: true });
    if (msg.poll) {
      state.discordCounts = countsOf(msg.poll);
      state.finalized = msg.poll.resultsFinalized;
      state.expiresAt = msg.poll.expiresTimestamp;
    }
    this.bridge.store.savePoll(state);
    await this.bridge.mm.patchPost(state.mmId, this.render(state));
  }

  /** Message (en réponse au sondage Discord) qui affiche les votes faits depuis Mattermost. */
  private async updateCompanion(discordId: string): Promise<void> {
    const state = this.bridge.store.polls.get(discordId);
    if (!state) return;
    const summary = state.answers.map((a) => `${a.text} : ${this.mmCount(state, a.id)}`).join(' · ');
    const content = truncate(`-# 🗳️ Votes depuis Mattermost — ${summary}`, 2000);
    const channel = this.bridge.channel;
    if (state.companionId) {
      try {
        await channel.messages.edit(state.companionId, { content });
        return;
      } catch (err) {
        log.debug('Message de votes Mattermost introuvable, recréation :', err);
      }
    }
    const sent = await channel.send({
      content,
      reply: { messageReference: discordId, failIfNotExists: false },
      allowedMentions: { parse: [], repliedUser: false },
    });
    state.companionId = sent.id;
    this.bridge.store.savePoll(state);
  }

  /** Rafraîchit le post Mattermost à l'échéance pour retirer les boutons. */
  private watchExpiry(state: PollState): void {
    if (state.expiresAt === null) return;
    const delay = state.expiresAt - Date.now() + 5000;
    if (delay > MAX_TIMEOUT_MS) return;
    clearTimeout(this.expiryTimers.get(state.discordId));
    this.expiryTimers.set(
      state.discordId,
      setTimeout(() => this.discordChanged(state.discordId), Math.max(0, delay)),
    );
  }
}
