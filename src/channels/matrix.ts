/**
 * Native Matrix channel adapter with a persistent SQLite-backed E2EE store.
 *
 * matrix-js-sdk's Node crypto store is intentionally ephemeral. Reusing an
 * access token after a restart therefore reused the Matrix device ID with a
 * new Olm identity, producing replies that clients could not decrypt until
 * key sharing caught up. matrix-bot-sdk persists the Rust crypto machine and
 * keeps the device identity stable across restarts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  ConversationInfo,
  OutboundMessage,
  ResolvedConversation,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const MATRIX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
] as const;

interface MatrixEvent {
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  content?: {
    body?: string;
    msgtype?: string;
    'm.mentions'?: { user_ids?: string[] };
    'm.new_content'?: { body?: string; msgtype?: string };
  };
}

interface MatrixClientLike {
  on(event: string, listener: (...args: unknown[]) => unknown): unknown;
  getUserId(): Promise<string>;
  start(): Promise<unknown>;
  stop(): void;
  joinRoom(roomId: string): Promise<unknown>;
  getJoinedRooms(): Promise<string[]>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  getJoinedRoomMembersWithProfiles(
    roomId: string,
  ): Promise<Record<string, { display_name?: string; avatar_url?: string }>>;
  sendMessage(roomId: string, content: Record<string, unknown>): Promise<string>;
  sendEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string>;
  setTyping(roomId: string, typing: boolean, timeout?: number): Promise<unknown>;
  dms: {
    isDm(roomId: string): boolean;
    getOrCreateDm(userId: string): Promise<string>;
  };
  cryptoStore?: {
    storagePath: string;
    getDeviceId(): Promise<string>;
    setDeviceId(deviceId: string): Promise<void>;
  };
}

export interface MatrixClientConfig {
  baseUrl: string;
  accessToken: string;
  userId: string;
  stateDir: string;
}

export type MatrixClientFactory = (config: MatrixClientConfig) => Promise<MatrixClientLike>;

function lockDown(pathname: string, mode: number): void {
  try {
    fs.chmodSync(pathname, mode);
  } catch (err) {
    log.warn('Matrix: could not restrict persistent crypto state permissions', { pathname, err });
  }
}

/** Construct the real client lazily so registration stays side-effect free. */
export async function createPersistentMatrixClient(config: MatrixClientConfig): Promise<MatrixClientLike> {
  const { MatrixClient, RustSdkCryptoStorageProvider, SimpleFsStorageProvider } = await import('matrix-bot-sdk');
  const stateDir = path.resolve(config.stateDir);
  const cryptoDir = path.join(stateDir, 'crypto');
  const syncStateFile = path.join(stateDir, 'sync.json');

  fs.mkdirSync(cryptoDir, { recursive: true, mode: 0o700 });
  lockDown(stateDir, 0o700);
  lockDown(cryptoDir, 0o700);

  const storage = new SimpleFsStorageProvider(syncStateFile);
  lockDown(syncStateFile, 0o600);
  // StoreType.Sqlite is a const enum erased at runtime; SQLite is its only
  // value in the Rust bindings and is represented by zero.
  const crypto = new RustSdkCryptoStorageProvider(cryptoDir, 0);
  lockDown(path.join(cryptoDir, 'bot-sdk.json'), 0o600);

  return new MatrixClient(config.baseUrl, config.accessToken, storage, crypto) as unknown as MatrixClientLike;
}

function unprefix(value: string): string {
  return value.startsWith('matrix:') ? value.slice('matrix:'.length) : value;
}

function outboundText(message: OutboundMessage): string | null {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return null;
  const body = content as Record<string, unknown>;

  if (body.type === 'ask_question') {
    const title = typeof body.title === 'string' ? body.title : '';
    const question = typeof body.question === 'string' ? body.question : '';
    const options = Array.isArray(body.options)
      ? body.options
          .map((option) =>
            typeof option === 'string'
              ? option
              : option && typeof option === 'object' && typeof (option as Record<string, unknown>).label === 'string'
                ? ((option as Record<string, unknown>).label as string)
                : '',
          )
          .filter(Boolean)
      : [];
    return [title, question, options.length ? `Reply with: ${options.join(', ')}` : ''].filter(Boolean).join('\n\n');
  }

  if (body.type === 'card' && body.card && typeof body.card === 'object') {
    const card = body.card as Record<string, unknown>;
    const candidate = [card.title, card.description, body.fallbackText].find(
      (part) => typeof part === 'string' && part,
    );
    return typeof candidate === 'string' ? candidate : null;
  }

  if (body.terminalCard && typeof body.terminalCard === 'object') {
    const card = body.terminalCard as Record<string, unknown>;
    return [card.title, card.question, card.resolution].filter((part) => typeof part === 'string' && part).join('\n\n');
  }

  if (typeof body.markdown === 'string') return body.markdown;
  if (typeof body.text === 'string') return body.text;
  if (typeof body.fallbackText === 'string') return body.fallbackText;
  return null;
}

export class PersistentMatrixAdapter implements ChannelAdapter {
  readonly name = 'matrix';
  readonly channelType = 'matrix';
  readonly supportsThreads = false;
  readonly defaults = MATRIX_DEFAULTS;

  private client: MatrixClientLike | null = null;
  private setupConfig: ChannelSetup | null = null;
  private connected = false;
  private botUserId = '';
  private readonly userToRoom = new Map<string, string>();

  constructor(
    private readonly clientConfig: MatrixClientConfig,
    private readonly createClient: MatrixClientFactory = createPersistentMatrixClient,
    private readonly autojoin = true,
    private readonly inviteAllowlist = new Set<string>(),
  ) {}

  async setup(config: ChannelSetup): Promise<void> {
    this.setupConfig = config;
    this.client = await this.createClient(this.clientConfig);
    this.botUserId = await this.client.getUserId();
    if (this.botUserId !== this.clientConfig.userId) {
      throw new Error(`Matrix access token belongs to ${this.botUserId}, expected ${this.clientConfig.userId}`);
    }

    this.client.on('room.invite', (...args: unknown[]) => {
      const [roomId, event] = args as [string, MatrixEvent];
      const inviter = event.sender ?? '';
      if (!this.autojoin || (this.inviteAllowlist.size > 0 && !this.inviteAllowlist.has(inviter))) return;
      void this.client
        ?.joinRoom(roomId)
        .catch((err: unknown) => log.error('Matrix: failed to join invited room', { err }));
    });
    this.client.on('room.message', (...args: unknown[]) => {
      const [roomId, event] = args as [string, MatrixEvent];
      void this.handleMessage(roomId, event).catch((err) => log.error('Matrix: failed to handle message', { err }));
    });

    await this.client.start();
    this.connected = true;
    log.info('Matrix sync ready with persistent crypto');
  }

  async teardown(): Promise<void> {
    this.connected = false;
    this.client?.stop();
    this.client = null;
    this.setupConfig = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const client = this.requireClient();
    const roomId = await this.resolveRoom(platformId);
    const content = message.content as Record<string, unknown> | undefined;

    if (
      content?.operation === 'reaction' &&
      typeof content.messageId === 'string' &&
      typeof content.emoji === 'string'
    ) {
      return client.sendEvent(roomId, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: content.messageId, key: content.emoji },
      });
    }

    const text = outboundText(message);
    if (!text && !message.files?.length) return undefined;
    const fileNote = message.files?.length
      ? `\n\nAttachments: ${message.files.map((file) => file.filename).join(', ')}`
      : '';
    const body = `${text ?? ''}${fileNote}`;
    const matrixContent: Record<string, unknown> = { msgtype: 'm.text', body };

    if (content?.operation === 'edit' && typeof content.messageId === 'string') {
      matrixContent['m.new_content'] = { msgtype: 'm.text', body };
      matrixContent['m.relates_to'] = { rel_type: 'm.replace', event_id: content.messageId };
    }

    return client.sendMessage(roomId, matrixContent);
  }

  async setTyping(platformId: string, _threadId: string | null): Promise<void> {
    const roomId = await this.resolveRoom(platformId);
    await this.requireClient().setTyping(roomId, true, 30_000);
  }

  async syncConversations(): Promise<ConversationInfo[]> {
    const client = this.requireClient();
    const rooms = await client.getJoinedRooms();
    return Promise.all(
      rooms.map(async (roomId) => {
        const members = await client.getJoinedRoomMembers(roomId);
        const other = members.find((member) => member !== this.botUserId);
        const isGroup = !other || members.length > 2;
        if (!isGroup && other) this.rememberDm(roomId, other);
        return {
          platformId: isGroup ? `matrix:${roomId}` : `matrix:${other}`,
          name: isGroup ? roomId : other,
          isGroup,
        };
      }),
    );
  }

  async resolveConversation(platformId: string): Promise<ResolvedConversation | null> {
    const roomId = await this.resolveRoom(platformId);
    const profiles = await this.requireClient().getJoinedRoomMembersWithProfiles(roomId);
    const participantIds = Object.keys(profiles).filter((id) => id !== this.botUserId);
    const participantNames = participantIds.map((id) => profiles[id]?.display_name || id);
    return {
      type: participantIds.length <= 1 ? 'direct' : 'group_dm',
      name: participantNames.join(', ') || null,
      participantIds,
      participantNames,
    };
  }

  private requireClient(): MatrixClientLike {
    if (!this.client) throw new Error('Matrix channel is not initialized');
    return this.client;
  }

  private rememberDm(roomId: string, userId: string): void {
    this.userToRoom.set(userId, roomId);
  }

  private async resolveRoom(platformId: string): Promise<string> {
    const id = unprefix(platformId);
    if (id.startsWith('!')) return id;
    const cached = this.userToRoom.get(id);
    if (cached) return cached;
    const roomId = await this.requireClient().dms.getOrCreateDm(id);
    this.rememberDm(roomId, id);
    return roomId;
  }

  private async handleMessage(roomId: string, event: MatrixEvent): Promise<void> {
    const client = this.requireClient();
    const sender = event.sender;
    if (!sender || sender === this.botUserId) return;
    const body = event.content?.['m.new_content']?.body ?? event.content?.body;
    const msgtype = event.content?.['m.new_content']?.msgtype ?? event.content?.msgtype;
    if (!body || (msgtype !== 'm.text' && msgtype !== 'm.notice')) return;

    const members = await client.getJoinedRoomMembers(roomId);
    const isDm = client.dms.isDm(roomId) || members.length <= 2;
    if (isDm) this.rememberDm(roomId, sender);
    const platformId = isDm ? `matrix:${sender}` : `matrix:${roomId}`;

    let senderName = sender;
    try {
      const profiles = await client.getJoinedRoomMembersWithProfiles(roomId);
      senderName = profiles[sender]?.display_name || sender;
    } catch (err) {
      log.warn('Matrix: could not resolve sender profile', { err });
    }

    const mentioned =
      event.content?.['m.mentions']?.user_ids?.includes(this.botUserId) ?? body.includes(this.botUserId);
    this.setupConfig?.onMetadata(platformId, isDm ? senderName : roomId, !isDm);
    await this.setupConfig?.onInbound(platformId, null, {
      id: event.event_id || `matrix-${event.origin_server_ts || Date.now()}`,
      kind: 'chat',
      timestamp: new Date(event.origin_server_ts || Date.now()).toISOString(),
      isMention: isDm || mentioned,
      isGroup: !isDm,
      content: {
        text: body,
        sender: senderName,
        senderName,
        senderId: `matrix:${sender}`,
        author: { userId: sender, userName: senderName, fullName: senderName },
      },
    });
  }
}

export function createMatrixChannelAdapter(
  env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  createClient: MatrixClientFactory = createPersistentMatrixClient,
  stateDir = path.join(DATA_DIR, 'matrix'),
): ChannelAdapter | null {
  if (!env.MATRIX_BASE_URL || !env.MATRIX_ACCESS_TOKEN || !env.MATRIX_USER_ID) return null;
  const allowlist = new Set(
    (env.MATRIX_INVITE_AUTOJOIN_ALLOWLIST || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return new PersistentMatrixAdapter(
    {
      baseUrl: env.MATRIX_BASE_URL,
      accessToken: env.MATRIX_ACCESS_TOKEN,
      userId: env.MATRIX_USER_ID,
      stateDir,
    },
    createClient,
    env.MATRIX_INVITE_AUTOJOIN !== 'false',
    allowlist,
  );
}

registerChannelAdapter('matrix', {
  factory: () => createMatrixChannelAdapter(readEnvFile([...ENV_KEYS])),
  defaults: MATRIX_DEFAULTS,
});
