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
  const displayNames: string[] = [];
  let stopped = false;
  let started = false;
  return {
    listeners,
    sent,
    displayNames,
    get stopped() {
      return stopped;
    },
    get started() {
      return started;
    },
    on(event: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(event, listener);
    },
    async getWhoAmI() {
      return { user_id: '@finances:matrix.test', device_id: 'FRESH_DEVICE' };
    },
    async getUserDevices() {
      return { device_keys: { '@finances:matrix.test': {} } };
    },
    async setDisplayName(displayName: string) {
      displayNames.push(displayName);
    },
    async start() {
      started = true;
    },
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
  const actions: Array<{ questionId: string; selectedOption: string; userId: string }> = [];
  const setup: ChannelSetup = {
    onInbound(platformId, _threadId, message) {
      inbound.push({ platformId, message });
    },
    onInboundEvent() {},
    onMetadata() {},
    onAction(questionId, selectedOption, userId) {
      actions.push({ questionId, selectedOption, userId });
    },
  };
  return { actions, inbound, setup };
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

  it('refuses an existing device when its local crypto state is missing', async () => {
    const fake = fakeMatrixClient();
    fake.getWhoAmI = async () => ({ user_id: '@finances:matrix.test', device_id: 'FINANCE_THRIA' });
    fake.getUserDevices = async () => ({
      device_keys: {
        '@finances:matrix.test': {
          FINANCE_THRIA: { user_id: '@finances:matrix.test', device_id: 'FINANCE_THRIA' },
        },
      },
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-matrix-missing-crypto-'));
    cleanup.push(stateDir);
    const adapter = new PersistentMatrixAdapter(
      {
        baseUrl: 'https://matrix.test',
        accessToken: 'reused-token',
        userId: '@finances:matrix.test',
        stateDir,
      },
      (async () => fake) as unknown as MatrixClientFactory,
    );

    await expect(adapter.setup(setupRecorder().setup)).rejects.toThrow(
      'Matrix device FINANCE_THRIA already has published encryption keys, but its local crypto state is missing',
    );
    expect(fake.started).toBe(false);
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
        displayName: 'Meowth',
        stateDir,
      },
      factory,
    );
    const { inbound, setup } = setupRecorder();
    await adapter.setup(setup);
    expect(fake.displayNames).toEqual(['Meowth']);
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

  it('keys a converted DM with three members by room ID', async () => {
    const fake = fakeMatrixClient();
    fake.getJoinedRoomMembers = async () => ['@finances:matrix.test', '@martin:matrix.test', '@codex:matrix.test'];
    fake.getJoinedRoomMembersWithProfiles = async () => ({
      '@finances:matrix.test': { display_name: 'Meowth' },
      '@martin:matrix.test': { display_name: 'Martin' },
      '@codex:matrix.test': { display_name: 'Codex' },
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-matrix-converted-dm-'));
    cleanup.push(stateDir);
    const adapter = new PersistentMatrixAdapter(
      {
        baseUrl: 'https://matrix.test',
        accessToken: 'secret',
        userId: '@finances:matrix.test',
        stateDir,
      },
      (async () => fake) as unknown as MatrixClientFactory,
    );
    const { inbound, setup } = setupRecorder();
    await adapter.setup(setup);

    fake.listeners.get('room.message')?.('!payday:matrix.test', {
      event_id: '$group-message',
      sender: '@codex:matrix.test',
      content: {
        msgtype: 'm.text',
        body: '@finances:matrix.test ping',
        'm.mentions': { user_ids: ['@finances:matrix.test'] },
      },
    });
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(inbound[0]).toMatchObject({
      platformId: 'matrix:!payday:matrix.test',
      message: { isMention: true, isGroup: true },
    });
  });

  it('persists Matrix question options and turns an exact text reply into an action after restart', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-matrix-actions-'));
    cleanup.push(stateDir);
    const firstFake = fakeMatrixClient();
    firstFake.dms.isDm = () => false;
    firstFake.getJoinedRoomMembers = async () => ['@finances:matrix.test', '@martin:matrix.test', '@codex:matrix.test'];
    const config: MatrixClientConfig = {
      baseUrl: 'https://matrix.test',
      accessToken: 'secret',
      userId: '@finances:matrix.test',
      stateDir,
    };
    const first = new PersistentMatrixAdapter(config, (async () => firstFake) as unknown as MatrixClientFactory);
    await first.setup(setupRecorder().setup);
    await first.deliver('matrix:!payday:matrix.test', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'mg-payday',
        title: 'Connect room',
        question: 'Choose an agent.',
        options: [{ label: 'Connect to Finances', value: 'connect:finance-agent' }],
      },
    });
    await first.teardown();

    const pendingFile = path.join(stateDir, 'pending-actions.json');
    expect(fs.statSync(pendingFile).mode & 0o777).toBe(0o600);

    const secondFake = fakeMatrixClient();
    secondFake.dms.isDm = () => false;
    secondFake.getJoinedRoomMembers = firstFake.getJoinedRoomMembers;
    const second = new PersistentMatrixAdapter(config, (async () => secondFake) as unknown as MatrixClientFactory);
    const { actions, inbound, setup } = setupRecorder();
    await second.setup(setup);
    secondFake.listeners.get('room.message')?.('!payday:matrix.test', {
      event_id: '$approval',
      sender: '@martin:matrix.test',
      content: { msgtype: 'm.text', body: '  connect TO finances  ' },
    });
    await vi.waitFor(() => expect(actions).toHaveLength(1));

    expect(actions).toEqual([
      {
        questionId: 'mg-payday',
        selectedOption: 'connect:finance-agent',
        userId: 'matrix:@martin:matrix.test',
      },
    ]);
    expect(inbound).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(pendingFile, 'utf8'))).toEqual({});
  });

  it('renders a question with its reply options and attachment names as one Matrix text body', async () => {
    const fake = fakeMatrixClient();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-matrix-render-'));
    cleanup.push(stateDir);
    const adapter = new PersistentMatrixAdapter(
      { baseUrl: 'https://matrix.test', accessToken: 'secret', userId: '@finances:matrix.test', stateDir },
      (async () => fake) as unknown as MatrixClientFactory,
    );
    await adapter.setup(setupRecorder().setup);

    await expect(
      adapter.deliver('matrix:@martin:matrix.test', null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'approval-1',
          title: 'Confirm',
          question: 'Proceed?',
          options: [
            { label: 'Yes', value: 'approved' },
            { label: 'No', value: 'rejected' },
          ],
        },
        files: [
          { filename: 'proof.bin', data: Buffer.from([0, 1, 255]) },
          { filename: 'log.txt', data: Buffer.from('ok') },
        ],
      }),
    ).resolves.toBe('$reply');

    expect(fake.sent).toEqual([
      {
        roomId: '!dm:matrix.test',
        content: {
          msgtype: 'm.text',
          body: 'Confirm\n\nProceed?\n\nReply with: Yes, No\n\nAttachments: proof.bin, log.txt',
        },
      },
    ]);
  });
});
