/**
 * Matrix channel — lightweight fetch-based client using Matrix CS API.
 *
 * No external deps required (matrix-bot-sdk native crypto module is
 * unsupported on ARM64 Linux / Raspberry Pi). Uses long-polling /sync
 * for receiving messages and direct HTTP calls for sending.
 */

import fs from 'fs';
import path from 'path';

import {
  MATRIX_HOMESERVER_URL,
  MATRIX_ACCESS_TOKEN,
  MATRIX_USER_ID,
  STORE_DIR,
} from '../config.js';
import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';
import { registerChannel } from './registry.js';

// --- Helpers ---

/** Extract local part from MXID: @alice:matrix.org → alice */
function displayNameFromMxid(mxid: string): string {
  const match = mxid.match(/^@([^:]+)/);
  return match ? match[1] : mxid;
}

/** File path for persisting the sync token between restarts. */
function syncTokenPath(): string {
  return path.join(STORE_DIR, 'matrix-sync-token.json');
}

function loadSyncToken(): string | undefined {
  try {
    if (fs.existsSync(syncTokenPath())) {
      const data = JSON.parse(fs.readFileSync(syncTokenPath(), 'utf-8'));
      return data.nextBatch ?? undefined;
    }
  } catch {
    // Ignore — will do initial sync
  }
  return undefined;
}

function saveSyncToken(token: string): void {
  try {
    fs.mkdirSync(path.dirname(syncTokenPath()), { recursive: true });
    fs.writeFileSync(
      syncTokenPath(),
      JSON.stringify({ nextBatch: token }),
      'utf-8',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to persist Matrix sync token');
  }
}

// --- Matrix CS API helpers ---

function apiUrl(endpoint: string): string {
  return `${MATRIX_HOMESERVER_URL}${endpoint}`;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${MATRIX_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// --- MatrixChannel ---

export class MatrixChannel implements Channel {
  readonly name = 'matrix';

  private connected = false;
  private abortController: AbortController | null = null;
  private syncLoopPromise: Promise<void> | null = null;
  private nextBatch: string | undefined;
  private txnCounter = 0;

  private readonly onMessage: ChannelOpts['onMessage'];
  private readonly onChatMetadata: ChannelOpts['onChatMetadata'];
  private readonly registeredGroups: ChannelOpts['registeredGroups'];

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.nextBatch = loadSyncToken();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('!');
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.abortController = new AbortController();
    this.connected = true;

    // Start background sync loop — it handles initial and subsequent syncs
    this.syncLoopPromise = this.syncLoop();

    logger.info('Matrix channel connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.syncLoopPromise) {
      // Wait for the loop to finish (it should exit quickly after abort)
      await this.syncLoopPromise.catch(() => {});
      this.syncLoopPromise = null;
    }
    logger.info('Matrix channel disconnected');
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    const txnId = `nanoclaw_${Date.now()}_${this.txnCounter++}`;
    const url = apiUrl(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    );
    const resp = await fetch(url, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ msgtype: 'm.text', body: text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Matrix sendMessage failed: ${resp.status} ${body}`);
    }
  }

  async setTyping(roomId: string, isTyping: boolean): Promise<void> {
    try {
      const url = apiUrl(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(MATRIX_USER_ID)}`,
      );
      await fetch(url, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          typing: isTyping,
          timeout: isTyping ? 30000 : undefined,
        }),
      });
    } catch (err) {
      logger.debug({ err }, 'Matrix setTyping failed (non-fatal)');
    }
  }

  // --- Sync loop ---

  private async doSync(
    since?: string,
  ): Promise<{ next_batch: string; rooms?: SyncRooms }> {
    const params = new URLSearchParams({ timeout: '30000' });
    if (since) params.set('since', since);

    const url = apiUrl(`/_matrix/client/v3/sync?${params}`);
    const resp = await fetch(url, {
      method: 'GET',
      headers: authHeaders(),
      signal: this.abortController?.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Matrix sync failed: ${resp.status} ${body}`);
    }

    return resp.json() as Promise<{ next_batch: string; rooms?: SyncRooms }>;
  }

  private async syncLoop(): Promise<void> {
    while (this.connected) {
      try {
        const resp = await this.doSync(this.nextBatch);
        if (!this.connected) break;

        this.nextBatch = resp.next_batch;
        saveSyncToken(this.nextBatch);
        this.processSyncResponse(resp);
      } catch (err: unknown) {
        if (!this.connected) break;
        // AbortError means we're shutting down
        if (err instanceof DOMException && err.name === 'AbortError') break;
        if (
          err instanceof Error &&
          err.message?.includes('abort')
        )
          break;
        logger.error({ err }, 'Matrix sync error, retrying in 5s');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private processSyncResponse(resp: {
    next_batch: string;
    rooms?: SyncRooms;
  }): void {
    const rooms = resp.rooms;
    if (!rooms) return;

    // Handle invites — auto-join
    if (rooms.invite) {
      for (const roomId of Object.keys(rooms.invite)) {
        this.autoJoin(roomId);
      }
    }

    // Handle joined room events
    if (rooms.join) {
      for (const [roomId, roomData] of Object.entries(rooms.join)) {
        this.handleRoomEvents(roomId, roomData as SyncRoomData);
      }
    }
  }

  private async autoJoin(roomId: string): Promise<void> {
    try {
      const url = apiUrl(
        `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      );
      await fetch(url, {
        method: 'POST',
        headers: authHeaders(),
        body: '{}',
      });
      logger.info({ roomId }, 'Auto-joined Matrix room');
    } catch (err) {
      logger.warn({ err, roomId }, 'Failed to auto-join Matrix room');
    }
  }

  private handleRoomEvents(roomId: string, roomData: SyncRoomData): void {
    const events = roomData?.timeline?.events;
    if (!events || !Array.isArray(events)) return;

    for (const event of events) {
      // Only process m.room.message events
      if (event.type !== 'm.room.message') continue;

      // Skip own messages
      if (event.sender === MATRIX_USER_ID) continue;

      // Skip non-text messages
      if (event.content?.msgtype !== 'm.text') continue;

      const timestamp = new Date(event.origin_server_ts).toISOString();

      // Emit metadata for all rooms
      this.onChatMetadata(roomId, timestamp, undefined, 'matrix', true);

      // Only deliver full message for registered groups
      const groups = this.registeredGroups();
      if (!(roomId in groups)) continue;

      const msg: NewMessage = {
        id: event.event_id,
        chat_jid: roomId,
        sender: event.sender,
        sender_name: displayNameFromMxid(event.sender),
        content: event.content.body ?? '',
        timestamp,
        is_from_me: false,
      };

      this.onMessage(roomId, msg);
    }
  }
}

// --- Types for Matrix sync response ---

interface SyncRooms {
  join?: Record<string, SyncRoomData>;
  invite?: Record<string, unknown>;
}

interface SyncRoomData {
  timeline?: {
    events?: SyncEvent[];
  };
}

interface SyncEvent {
  type: string;
  sender: string;
  event_id: string;
  origin_server_ts: number;
  content: {
    msgtype?: string;
    body?: string;
    membership?: string;
    [key: string]: unknown;
  };
}

// --- Factory + self-registration ---

/** Returns true when all required Matrix credentials are configured. */
export function hasMatrixCredentials(): boolean {
  return !!(MATRIX_HOMESERVER_URL && MATRIX_ACCESS_TOKEN && MATRIX_USER_ID);
}

export function matrixFactory(opts: ChannelOpts): Channel | null {
  if (!hasMatrixCredentials()) {
    return null;
  }
  return new MatrixChannel(opts);
}

registerChannel('matrix', matrixFactory);
