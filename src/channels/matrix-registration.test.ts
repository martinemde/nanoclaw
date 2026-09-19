import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelSetup } from './adapter.js';
import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js';
import {
  createMatrixChannelAdapter,
  createPersistentMatrixClient,
  PersistentMatrixAdapter,
  type MatrixClientConfig,
  type MatrixClientFactory,
} from './matrix.js';

const cleanup: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeMatrixClient() {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const sent: Array<{ roomId: string; content: Record<string, unknown> }> = [];
  let stopped = false;
  return {
    listeners,
    sent,
    get stopped() {
      return stopped;
    },
    on(event: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(event, listener);
    },
    async getUserId() {
      return '@finances:matrix.test';
    },
    async start() {},
    stop() {
      stopped = true;
    },
    async joinRoom() {},
    async getJoinedRooms() {
      return ['!dm:matrix.test'];
    },
    async getJoinedRoomMembers() {
      return ['@finances:matrix.test', '@martin:matrix.test'];
    },
    async getJoinedRoomMembersWithProfiles() {
      return {
        '@finances:matrix.test': { display_name: 'Finances' },
        '@martin:matrix.test': { display_name: 'Martin' },
      };
    },
    async sendMessage(roomId: string, content: Record<string, unknown>) {
      sent.push({ roomId, content });
      return '$reply';
    },
    async sendEvent() {
      return '$event';
    },
    async setTyping() {},
    dms: {
      isDm: () => true,
      getOrCreateDm: async () => '!dm:matrix.test',
    },
  };
}

function setupRecorder() {
  const inbound: Array<{ platformId: string; message: unknown }> = [];
  const setup: ChannelSetup = {
    onInbound(platformId, _threadId, message) {
      inbound.push({ platformId, message });
    },
    onInboundEvent() {},
    onMetadata() {},
    onAction() {},
  };
  return { inbound, setup };
}

describe('matrix channel registration', () => {
  it('registers matrix via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('matrix');
  });

  it('requires an access token and stable user ID', () => {
    expect(createMatrixChannelAdapter({ MATRIX_BASE_URL: 'https://matrix.test' })).toBeNull();
    expect(
      createMatrixChannelAdapter({
        MATRIX_BASE_URL: 'https://matrix.test',
        MATRIX_ACCESS_TOKEN: 'secret',
        MATRIX_USER_ID: '@finances:matrix.test',
      }),
    ).toBeInstanceOf(PersistentMatrixAdapter);
  });
});

describe('persistent Matrix E2EE', () => {
  it('reuses one locked-down crypto store across client restarts', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-matrix-'));
    cleanup.push(stateDir);
    const config: MatrixClientConfig = {
      baseUrl: 'https://matrix.test',
      accessToken: 'not-used-without-start',
      userId: '@finances:matrix.test',
      stateDir,
    };

    const first = await createPersistentMatrixClient(config);
    await first.cryptoStore?.setDeviceId('PERSISTENT_DEVICE');
    const second = await createPersistentMatrixClient(config);

    expect(await second.cryptoStore?.getDeviceId()).toBe('PERSISTENT_DEVICE');
    expect(second.cryptoStore?.storagePath).toBe(path.join(stateDir, 'crypto'));
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(stateDir, 'crypto', 'bot-sdk.json')).mode & 0o777).toBe(0o600);
  });

  it('maps decrypted DMs to stable user IDs and encrypts replies through the client', async () => {
    const fake = fakeMatrixClient();
    const factory = (async () => fake) as unknown as MatrixClientFactory;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-matrix-adapter-'));
    cleanup.push(stateDir);
    const cryptoDir = path.join(stateDir, 'crypto');
    fs.mkdirSync(cryptoDir);
    const sqliteFile = path.join(cryptoDir, 'matrix-sdk-crypto.sqlite3');
    fs.writeFileSync(sqliteFile, 'test', { mode: 0o644 });
    const adapter = new PersistentMatrixAdapter(
      {
        baseUrl: 'https://matrix.test',
        accessToken: 'secret',
        userId: '@finances:matrix.test',
        stateDir,
      },
      factory,
    );
    const { inbound, setup } = setupRecorder();
    await adapter.setup(setup);
    expect(fs.statSync(sqliteFile).mode & 0o777).toBe(0o600);

    fake.listeners.get('room.message')?.('!dm:matrix.test', {
      event_id: '$inbound',
      sender: '@martin:matrix.test',
      origin_server_ts: 1_700_000_000_000,
      content: { msgtype: 'm.text', body: 'ping' },
    });
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(inbound[0].platformId).toBe('matrix:@martin:matrix.test');
    expect(inbound[0].message).toMatchObject({
      id: '$inbound',
      isMention: true,
      isGroup: false,
      content: { text: 'ping', senderId: 'matrix:@martin:matrix.test' },
    });

    await expect(
      adapter.deliver('matrix:@martin:matrix.test', null, { kind: 'chat', content: { markdown: 'pong' } }),
    ).resolves.toBe('$reply');
    expect(fake.sent).toEqual([{ roomId: '!dm:matrix.test', content: { msgtype: 'm.text', body: 'pong' } }]);

    await adapter.teardown();
    expect(fake.stopped).toBe(true);
  });
});
