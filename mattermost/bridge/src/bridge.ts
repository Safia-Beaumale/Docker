import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildPremiumTier,
  MessageFlags,
  MessageReferenceType,
  MessageType,
  Partials,
  StickerFormatType,
  type Guild,
  type GuildEmoji,
  type Message,
  type MessageReaction,
  type OmitPartialGroupDMChannel,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type TextChannel,
  type User,
  type Webhook,
} from 'discord.js';
import { config } from './config.js';
import { nameToUnicode, replaceShortcodes, sameEmoji, unicodeToName } from './emoji.js';
import { log } from './log.js';
import { MattermostError, type Mattermost, type Post, type Reaction, type WsEvent } from './mattermost.js';
import { parsePollCommand, Polls } from './polls.js';
import type { Store } from './store.js';
import { download, formatSize, MB, oneLine, Queue, truncate } from './util.js';

type AnyMessage = OmitPartialGroupDMChannel<Message | PartialMessage>;

const DISCORD_MAX_LENGTH = 2000;
const MM_MAX_FILE = 50 * MB;
const MM_MAX_FILES_PER_POST = 10;

/** Liens produits par le sélecteur de GIF Discord */
const GIF_LINK = /https?:\/\/(?:www\.)?(?:klipy\.com|tenor\.com|giphy\.com)\//i;

/** Discord refuse « discord » et « clyde » dans le pseudo d'un webhook. */
const FORBIDDEN_WEBHOOK_NAMES = /discord|clyde/gi;

export class Bridge {
  readonly discord = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMessagePolls,
    ],
    // Permet de recevoir réactions / suppressions sur des messages absents du cache
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });
  readonly queue = new Queue();
  readonly polls = new Polls(this);

  guild!: Guild;
  channel!: TextChannel;
  webhook!: Webhook;
  mmChannelId!: string;
  private mmBotId!: string;
  /** Dernière date de modification relayée par post, pour ignorer les post_edited sans changement de texte */
  private mmEdits = new Map<string, number>();

  constructor(
    readonly mm: Mattermost,
    readonly store: Store,
  ) {}

  healthy(): boolean {
    return this.discord.isReady() && this.mm.connected;
  }

  async start(): Promise<void> {
    this.mmBotId = (await this.mm.me()).id;
    this.mmChannelId = await this.mm.channelId(config.mattermost.team, config.mattermost.channel);
    log.info(`Mattermost : canal ${config.mattermost.team}/${config.mattermost.channel} trouvé`);

    const ready = new Promise<void>((resolve) => this.discord.once(Events.ClientReady, () => resolve()));
    await this.discord.login(config.discord.token);
    await ready;
    await this.resolveDiscordChannel();
    log.info(`Discord : connecté en tant que ${this.discord.user?.tag}, salon #${this.channel.name}`);

    this.listenDiscord();
    this.mm.on('event', (ev) => this.onMmEvent(ev));
    this.mm.connect();
    this.polls.resume();
  }

  private async resolveDiscordChannel(): Promise<void> {
    const { server, channel } = config.discord;
    const guild = this.discord.guilds.cache.get(server) ?? this.discord.guilds.cache.find((g) => g.name === server);
    if (!guild) throw new Error(`Discord : serveur « ${server} » introuvable (le bot y est-il invité ?)`);
    const channels = await guild.channels.fetch();
    const found = channels.get(channel) ?? channels.find((c) => c?.name === channel);
    if (found?.type !== ChannelType.GuildText) throw new Error(`Discord : salon textuel « ${channel} » introuvable`);
    this.guild = guild;
    this.channel = found;

    // Webhook pour afficher le pseudo Mattermost d'origine (permission « Gérer les webhooks »)
    const me = this.discord.user?.id;
    const hooks = await found.fetchWebhooks();
    this.webhook =
      hooks.find((hook) => hook.owner?.id === me && hook.token !== null) ??
      (await found.createWebhook({ name: 'Mattermost', reason: 'Bridge Mattermost ⇄ Discord' }));
  }

  // ───────────────────────────── Discord → Mattermost ─────────────────────────────

  private listenDiscord(): void {
    const d = this.discord;
    d.on(Events.MessageCreate, (msg) => this.queue.push('Discord → Mattermost', () => this.onDiscordMessage(msg)));
    d.on(Events.MessageUpdate, (before, after) =>
      this.queue.push('modification Discord', () => this.onDiscordEdit(before, after)),
    );
    d.on(Events.MessageDelete, (msg) => this.queue.push('suppression Discord', () => this.onDiscordDelete(msg)));
    d.on(Events.MessageBulkDelete, (msgs) => {
      for (const msg of msgs.values()) this.queue.push('suppression Discord', () => this.onDiscordDelete(msg));
    });
    d.on(Events.MessageReactionAdd, (reaction, user) =>
      this.queue.push('réaction Discord', () => this.onDiscordReaction(reaction, user, true)),
    );
    d.on(Events.MessageReactionRemove, (reaction, user) =>
      this.queue.push('réaction Discord', () => this.onDiscordReaction(reaction, user, false)),
    );
    d.on(Events.MessagePollVoteAdd, (answer) => this.polls.discordChanged(answer.poll.messageId));
    d.on(Events.MessagePollVoteRemove, (answer) => this.polls.discordChanged(answer.poll.messageId));
    d.on(Events.Error, (err) => log.error('Discord :', err));
  }

  /** Messages postés par le bridge lui-même (webhook ou bot) : jamais relayés, sinon boucle. */
  private isOwn(msg: Pick<Message | PartialMessage, 'webhookId' | 'author'>): boolean {
    return msg.webhookId === this.webhook.id || msg.author?.id === this.discord.user?.id;
  }

  identity(msg: Message): Record<string, unknown> {
    const name = msg.member?.displayName ?? msg.author.displayName;
    return {
      from_webhook: 'true',
      override_username: `${name} (Discord)`,
      override_icon_url: (msg.member ?? msg.author).displayAvatarURL({ extension: 'png', size: 128 }),
    };
  }

  private discordText(msg: Message): string {
    let text = msg.cleanContent
      // Emoji personnalisés Discord <:nom:id> → :nom: (affiché si Mattermost a un emoji du même nom)
      .replace(/<a?:(\w+):\d+>/g, (_, name: string) => `:${name.toLowerCase()}:`)
      // Évite qu'un message Discord notifie tout le canal Mattermost
      .replace(/@(channel|all|here)\b/gi, '@​$1');
    // GIF du sélecteur Discord (Klipy, Giphy…) : le lien pointe vers une page que Mattermost
    // ne sait pas prévisualiser ; on le remplace par l'image animée fournie dans l'embed
    for (const embed of msg.embeds) {
      const image = embed.thumbnail?.url;
      if (embed.data.type !== 'gifv' || !image || !/\.(gif|webp)(\?|$)/i.test(image)) continue;
      const inline = `![${(embed.title ?? 'GIF').replace(/[[\]]/g, '')}](${image})`;
      text = embed.url && text.includes(embed.url) ? text.replace(embed.url, inline) : `${text}\n${inline}`.trim();
    }
    const embeds = msg.embeds
      .filter((embed) => embed.data.type === 'rich')
      .map((embed) => [embed.title && `**${embed.title}**`, embed.description, embed.url].filter(Boolean).join('\n'));
    return [text, ...embeds].filter(Boolean).join('\n');
  }

  private async uploadToMm(url: string, name: string, size = 0): Promise<string | undefined> {
    if (size > MM_MAX_FILE) return undefined;
    try {
      return await this.mm.uploadFile(this.mmChannelId, name, await download(url, MM_MAX_FILE));
    } catch (err) {
      log.warn(`Fichier ${name} non transféré vers Mattermost :`, err);
      return undefined;
    }
  }

  private async onDiscordMessage(msg: Message): Promise<void> {
    if (msg.channelId !== this.channel.id || this.isOwn(msg)) return;
    if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return;
    if (msg.poll) return this.polls.fromDiscord(msg);
    msg = await this.withGifEmbed(msg);

    const lines = [this.discordText(msg)];
    const fileIds: string[] = [];
    const voice = msg.flags.has(MessageFlags.IsVoiceMessage);

    // Pièces jointes (images, GIF, vidéos, audio…) : ré-uploadées, car les liens du CDN Discord expirent
    for (const att of msg.attachments.values()) {
      if (voice) lines.push(`🎤 *Message vocal${att.duration ? ` (${Math.round(att.duration)} s)` : ''}*`);
      const id =
        fileIds.length < MM_MAX_FILES_PER_POST
          ? await this.uploadToMm(att.url, voice ? 'message-vocal.ogg' : att.name, att.size)
          : undefined;
      if (id) fileIds.push(id);
      else lines.push(`📎 [${att.name}](${att.url}) (${formatSize(att.size)})`);
    }

    // Stickers : image PNG/APNG/GIF ré-uploadée ; les stickers Lottie (animations JSON) ne sont pas affichables
    for (const sticker of msg.stickers.values()) {
      if (sticker.format !== StickerFormatType.Lottie && fileIds.length < MM_MAX_FILES_PER_POST) {
        const ext = sticker.format === StickerFormatType.GIF ? 'gif' : 'png';
        const id = await this.uploadToMm(sticker.url, `sticker-${sticker.name}.${ext}`);
        if (id) {
          fileIds.push(id);
          continue;
        }
      }
      lines.push(`🏷️ *Sticker « ${sticker.name} »*`);
    }

    const message = lines.filter(Boolean).join('\n');
    if (!message && fileIds.length === 0) return;

    // Réponse Discord → réponse dans le fil Mattermost du message cité
    const ref = msg.reference;
    let rootId: string | undefined;
    if (ref?.messageId && ref.type === MessageReferenceType.Default && ref.channelId === msg.channelId) {
      const parent = this.store.mmFor(ref.messageId);
      if (parent) rootId = this.store.mmRootFor(parent);
    }

    const post = await this.mm.createPost({
      channel_id: this.mmChannelId,
      message,
      root_id: rootId,
      file_ids: fileIds,
      props: this.identity(msg),
    });
    this.store.link(msg.id, post.id, rootId);
  }

  /**
   * Discord ajoute parfois l'embed d'un GIF juste après l'envoi du message : on attend
   * brièvement plutôt que de relayer un simple lien puis de modifier le post.
   */
  private async withGifEmbed(msg: Message): Promise<Message> {
    if (msg.embeds.length > 0 || !GIF_LINK.test(msg.content)) return msg;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const fresh = await msg.fetch(true).catch(() => msg);
      if (fresh.embeds.length > 0) return fresh;
    }
    return msg;
  }

  private async onDiscordEdit(before: AnyMessage, after: AnyMessage): Promise<void> {
    if (after.channelId !== this.channel.id) return;
    if (this.store.polls.has(after.id)) return this.polls.discordChanged(after.id);
    const mmId = this.store.mmFor(after.id);
    if (!mmId) return;
    const msg = after.partial ? await after.fetch() : after;
    // Discord émet aussi un update quand il génère un aperçu de lien : on ne relaie que les vraies modifications
    if (this.isOwn(msg) || !msg.editedTimestamp || (!before.partial && before.content === msg.content)) return;
    const message = this.discordText(msg);
    if (message) await this.mm.patchPost(mmId, { message });
  }

  private async onDiscordDelete(msg: AnyMessage): Promise<void> {
    if (msg.channelId !== this.channel.id) return;
    if (this.store.polls.has(msg.id)) this.polls.forget(msg.id);
    const mmId = this.store.unlinkDiscord(msg.id);
    if (mmId) await this.mm.deletePost(mmId);
  }

  private async onDiscordReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    added: boolean,
  ): Promise<void> {
    if (user.id === this.discord.user?.id || reaction.message.channelId !== this.channel.id) return;
    const mmId = this.store.mmFor(reaction.message.id);
    if (!mmId) return;
    const emoji = reaction.emoji;
    const name = emoji.id ? emoji.name?.toLowerCase() : unicodeToName(emoji.name ?? '');
    if (!name) return;

    try {
      if (added) {
        await this.mm.addReaction(this.mmBotId, mmId, name);
        return;
      }
      // Le bot Mattermost porte la réaction pour tous les utilisateurs Discord :
      // on ne la retire que si plus personne côté Discord n'a cette réaction
      let remaining = 0;
      try {
        const current = reaction.partial ? await reaction.fetch() : reaction;
        remaining = (current.count ?? 0) - (current.me ? 1 : 0);
      } catch {
        // Réaction disparue du message : plus personne ne l'a
      }
      if (remaining <= 0) await this.mm.removeReaction(this.mmBotId, mmId, name);
    } catch (err) {
      // Typiquement : emoji personnalisé Discord sans équivalent sur Mattermost
      if (err instanceof MattermostError) log.debug(`Réaction :${name}: ignorée :`, err.message);
      else throw err;
    }
  }

  // ───────────────────────────── Mattermost → Discord ─────────────────────────────

  private onMmEvent(ev: WsEvent): void {
    switch (ev.event) {
      case 'posted':
      case 'post_edited':
      case 'post_deleted': {
        const post = JSON.parse(String(ev.data.post)) as Post;
        if (post.channel_id !== this.mmChannelId) return;
        if (ev.event === 'posted') this.queue.push('Mattermost → Discord', () => this.onMmPost(post));
        else if (ev.event === 'post_edited') this.queue.push('modification Mattermost', () => this.onMmEdit(post));
        else this.queue.push('suppression Mattermost', () => this.onMmDelete(post));
        return;
      }
      case 'reaction_added':
      case 'reaction_removed': {
        const reaction = JSON.parse(String(ev.data.reaction)) as Reaction;
        if (ev.broadcast.channel_id !== this.mmChannelId || reaction.user_id === this.mmBotId) return;
        const added = ev.event === 'reaction_added';
        this.queue.push('réaction Mattermost', () => this.onMmReaction(reaction, added));
        return;
      }
    }
  }

  async mmDisplayName(userId: string): Promise<string> {
    const user = await this.mm.user(userId);
    return user.nickname || user.username;
  }

  webhookName(name: string): string {
    const safe = `${name} (Mattermost)`.replace(FORBIDDEN_WEBHOOK_NAMES, (word) => `${word[0]}​${word.slice(1)}`);
    return truncate(safe, 80);
  }

  /** Ne relaie que les messages des utilisateurs (pas ceux du bot ni les messages système). */
  private relayable(post: Post): boolean {
    return post.user_id !== this.mmBotId && (post.type === '' || post.type === 'me');
  }

  private uploadLimit(): number {
    switch (this.guild.premiumTier) {
      case GuildPremiumTier.Tier2:
        return 50 * MB;
      case GuildPremiumTier.Tier3:
        return 100 * MB;
      default:
        return 10 * MB;
    }
  }

  /** Discord ne gère pas les réponses via webhook : on ajoute une ligne de contexte avec un lien vers le message. */
  private async replyHeader(rootId: string): Promise<string> {
    let author = 'un message';
    let excerpt = '';
    try {
      const root = await this.mm.getPost(rootId);
      author =
        root.user_id === this.mmBotId
          ? String(root.props?.override_username ?? 'Mattermost')
          : await this.mmDisplayName(root.user_id);
      excerpt = oneLine(root.message.replace(/[`*_~|>]/g, ''), 80);
    } catch (err) {
      log.debug('Post parent introuvable :', err);
    }
    const discordId = this.store.discordFor(rootId);
    const label = `↪ En réponse à ${author}`;
    const link = discordId
      ? `[${label}](https://discord.com/channels/${this.guild.id}/${this.channel.id}/${discordId})`
      : label;
    return `-# ${link}${excerpt ? ` : ${excerpt}` : ''}`;
  }

  private async mmText(post: Post): Promise<string> {
    let text = replaceShortcodes(
      // Images Markdown (dont les GIF du sélecteur Mattermost) → URL seule, que Discord intègre
      post.message.replace(/!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)/g, '$1'),
    );
    if (post.type === 'me' && text) text = `_${text}_`;
    if (post.root_id) text = `${await this.replyHeader(post.root_id)}\n${text}`;
    return text;
  }

  private async onMmPost(post: Post): Promise<void> {
    if (!this.relayable(post)) return;
    const pollCommand = parsePollCommand(post.message);
    if (pollCommand) return this.polls.fromMattermost(post, pollCommand);

    let content = await this.mmText(post);
    const files: AttachmentBuilder[] = [];
    let voice: { duration: number } | undefined;
    let budget = this.uploadLimit();

    for (const id of post.file_ids ?? []) {
      const info = await this.mm.fileInfo(id);
      if (info.size > budget) {
        content += `\n📎 *${info.name}* (${formatSize(info.size)}) — trop volumineux pour Discord`;
        continue;
      }
      budget -= info.size;
      const data = await this.mm.downloadFile(id);
      files.push(new AttachmentBuilder(data, { name: info.name }));
      // Un fichier Ogg/Opus seul, sans texte, est envoyé comme message vocal natif Discord
      const duration = opusDuration(data);
      if (post.file_ids?.length === 1 && !post.message.trim() && !post.root_id && duration !== undefined) {
        voice = { duration };
      }
    }

    content = truncate(content.trim(), DISCORD_MAX_LENGTH);
    if (!content && files.length === 0) return;

    const base = {
      username: this.webhookName(await this.mmDisplayName(post.user_id)),
      allowedMentions: { parse: [] },
    };
    let sent: Message | undefined;
    if (voice && files[0]) {
      const file = files[0].setName('message-vocal.ogg').setDuration(voice.duration).setWaveform(FLAT_WAVEFORM);
      try {
        sent = await this.webhook.send({ ...base, files: [file], flags: MessageFlags.IsVoiceMessage });
      } catch (err) {
        log.debug('Envoi en message vocal refusé, envoi en fichier audio :', err);
      }
    }
    sent ??= await this.webhook.send({ ...base, content: content || undefined, files });
    this.store.link(sent.id, post.id, post.root_id);
  }

  private async onMmEdit(post: Post): Promise<void> {
    if (!this.relayable(post) || !post.edit_at || this.mmEdits.get(post.id) === post.edit_at) return;
    const discordId = this.store.discordFor(post.id);
    if (!discordId) return;
    this.mmEdits.set(post.id, post.edit_at);
    const content = truncate(await this.mmText(post), DISCORD_MAX_LENGTH);
    if (content) await this.webhook.editMessage(discordId, { content });
  }

  private async onMmDelete(post: Post): Promise<void> {
    const discordId = this.store.unlinkMm(post.id);
    if (!discordId) return;
    this.mmEdits.delete(post.id);
    if (this.store.polls.has(discordId)) this.polls.forget(discordId);
    try {
      await this.webhook.deleteMessage(discordId);
    } catch {
      // Message d'un utilisateur Discord : nécessite la permission « Gérer les messages »
      await this.channel.messages.delete(discordId);
    }
  }

  private async onMmReaction(reaction: Reaction, added: boolean): Promise<void> {
    const discordId = this.store.discordFor(reaction.post_id);
    if (!discordId) return;
    const emoji: string | GuildEmoji | undefined =
      nameToUnicode(reaction.emoji_name) ??
      this.guild.emojis.cache.find((e) => e.name?.toLowerCase() === reaction.emoji_name);
    if (!emoji) {
      log.debug(`Réaction :${reaction.emoji_name}: sans équivalent Discord`);
      return;
    }
    const msg = await this.channel.messages.fetch(discordId);
    if (added) {
      await msg.react(emoji);
      return;
    }
    // Le bot Discord porte la réaction pour tous les utilisateurs Mattermost
    const others = (await this.mm.reactions(reaction.post_id)).some(
      (r) => r.emoji_name === reaction.emoji_name && r.user_id !== this.mmBotId,
    );
    if (others) return;
    const existing = msg.reactions.cache.find((r) =>
      typeof emoji === 'string' ? sameEmoji(r.emoji.name ?? '', emoji) : r.emoji.id === emoji.id,
    );
    await existing?.users.remove(this.discord.user?.id);
  }
}

/** Forme d'onde neutre : Discord l'exige pour un message vocal, Mattermost ne la fournit pas. */
const FLAT_WAVEFORM = Buffer.alloc(64, 0x60).toString('base64');

/** Durée (s) d'un fichier Ogg/Opus, lue dans la dernière page Ogg ; undefined si ce n'est pas de l'Opus. */
function opusDuration(data: Buffer): number | undefined {
  const head = data.indexOf('OpusHead');
  const lastPage = data.lastIndexOf('OggS');
  if (data.indexOf('OggS') !== 0 || head < 0 || lastPage < 0 || lastPage + 14 > data.length) return undefined;
  const preSkip = data.readUInt16LE(head + 10);
  const granule = Number(data.readBigUInt64LE(lastPage + 6));
  return Math.max(0, (granule - preSkip) / 48_000);
}
