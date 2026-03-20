import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  MATRIX_HOMESERVER_URL: 'https://matrix.example.com',
  MATRIX_ACCESS_TOKEN: 'syt_test_token',
  MATRIX_USER_ID: '@bot:example.com',
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock fs for sync token persistence
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import type { Channel, RegisteredGroup } from '../types.js';
import type { ChannelOpts } from './registry.js';

// We need to import the module to get the MatrixChannel class
// but also need access to the factory for testing registration
let MatrixChannel: new (opts: ChannelOpts) => Channel;
let channelFactory: (opts: ChannelOpts) => Channel | null;

// --- Helpers ---

function makeOpts(overrides: Partial<ChannelOpts> = {}): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

function makeSyncResponse(opts: {
  nextBatch?: string;
  rooms?: Record<string, unknown>;
  invites?: Record<string, unknown>;
} = {}) {
  return {
    next_batch: opts.nextBatch ?? 'batch_2',
    rooms: {
      join: opts.rooms ?? {},
      invite: opts.invites ?? {},
    },
  };
}

function makeRoomEvents(events: Array<{
  type?: string;
  sender?: string;
  content?: Record<string, unknown>;
  event_id?: string;
  origin_server_ts?: number;
}>) {
  return {
    timeline: {
      events: events.map((e) => ({
        type: e.type ?? 'm.room.message',
        sender: e.sender ?? '@alice:example.com',
        content: e.content ?? { msgtype: 'm.text', body: 'hello' },
        event_id: e.event_id ?? `$${Math.random().toString(36).slice(2)}`,
        origin_server_ts: e.origin_server_ts ?? Date.now(),
      })),
    },
  };
}

/**
 * Returns a promise that rejects when the given AbortSignal fires,
 * simulating a long-polling fetch that can be cancelled.
 */
function abortableHang(_url: string, init?: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }
    // Without a signal, this promise hangs forever (test will time out)
  });
}

// --- Fetch mock setup ---

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as typeof fetch;

  // Default: sync returns empty, other calls succeed
  fetchMock.mockImplementation(async (url: string, _init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/sync')) {
      return {
        ok: true,
        json: async () => makeSyncResponse(),
      };
    }
    return { ok: true, json: async () => ({}) };
  });

  // Dynamic import to get fresh module state
  const mod = await import('./matrix.js');
  MatrixChannel = mod.MatrixChannel;
  channelFactory = mod.matrixFactory;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// --- Tests ---

describe('MatrixChannel', () => {
  it('has name "matrix"', () => {
    const ch = new MatrixChannel(makeOpts());
    expect(ch.name).toBe('matrix');
  });

  it('ownsJid returns true for Matrix room IDs (! prefix)', () => {
    const ch = new MatrixChannel(makeOpts());
    expect(ch.ownsJid('!roomid:example.com')).toBe(true);
    expect(ch.ownsJid('!abc:matrix.org')).toBe(true);
  });

  it('ownsJid returns false for WhatsApp JIDs', () => {
    const ch = new MatrixChannel(makeOpts());
    expect(ch.ownsJid('123@g.us')).toBe(false);
    expect(ch.ownsJid('123@s.whatsapp.net')).toBe(false);
  });

  it('ownsJid returns false for empty string', () => {
    const ch = new MatrixChannel(makeOpts());
    expect(ch.ownsJid('')).toBe(false);
  });

  it('isConnected returns false before connect', () => {
    const ch = new MatrixChannel(makeOpts());
    expect(ch.isConnected()).toBe(false);
  });

  it('connect starts sync and sets isConnected true', async () => {
    const ch = new MatrixChannel(makeOpts());
    let syncCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCount++;
        if (syncCount === 1) {
          return { ok: true, json: async () => makeSyncResponse() };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    await ch.disconnect();
  });

  it('disconnect stops sync and sets isConnected false', async () => {
    const ch = new MatrixChannel(makeOpts());
    let syncCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCount++;
        if (syncCount === 1) {
          return { ok: true, json: async () => makeSyncResponse() };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    expect(ch.isConnected()).toBe(true);

    await ch.disconnect();
    expect(ch.isConnected()).toBe(false);
  });

  it('delivers message for registered rooms', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const roomId = '!registered:example.com';
    const groups: Record<string, RegisteredGroup> = {
      [roomId]: {
        name: 'test-group',
        folder: 'test-group',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00Z',
      },
    };

    const ch = new MatrixChannel(
      makeOpts({
        onMessage,
        onChatMetadata,
        registeredGroups: () => groups,
      }),
    );

    let syncCall = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCall++;
        if (syncCall === 1) {
          return {
            ok: true,
            json: async () =>
              makeSyncResponse({
                rooms: {
                  [roomId]: makeRoomEvents([
                    {
                      sender: '@alice:example.com',
                      content: { msgtype: 'm.text', body: 'Hello bot' },
                      event_id: '$msg1',
                      origin_server_ts: 1700000000000,
                    },
                  ]),
                },
              }),
          };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    // Allow sync loop to process
    await new Promise((r) => setTimeout(r, 50));

    expect(onChatMetadata).toHaveBeenCalledWith(
      roomId,
      expect.any(String),
      undefined,
      'matrix',
      true,
    );
    expect(onMessage).toHaveBeenCalledWith(
      roomId,
      expect.objectContaining({
        id: '$msg1',
        chat_jid: roomId,
        sender: '@alice:example.com',
        sender_name: 'alice',
        content: 'Hello bot',
      }),
    );

    await ch.disconnect();
  });

  it('emits metadata only for unregistered rooms', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const roomId = '!unregistered:example.com';

    const ch = new MatrixChannel(
      makeOpts({
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({}),
      }),
    );

    let syncCall = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCall++;
        if (syncCall === 1) {
          return {
            ok: true,
            json: async () =>
              makeSyncResponse({
                rooms: {
                  [roomId]: makeRoomEvents([
                    {
                      sender: '@someone:example.com',
                      content: { msgtype: 'm.text', body: 'hi' },
                    },
                  ]),
                },
              }),
          };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(onChatMetadata).toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();

    await ch.disconnect();
  });

  it('skips own messages', async () => {
    const onMessage = vi.fn();
    const onChatMetadata = vi.fn();
    const roomId = '!room:example.com';
    const groups: Record<string, RegisteredGroup> = {
      [roomId]: {
        name: 'test',
        folder: 'test',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00Z',
      },
    };

    const ch = new MatrixChannel(
      makeOpts({
        onMessage,
        onChatMetadata,
        registeredGroups: () => groups,
      }),
    );

    let syncCall = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCall++;
        if (syncCall === 1) {
          return {
            ok: true,
            json: async () =>
              makeSyncResponse({
                rooms: {
                  [roomId]: makeRoomEvents([
                    {
                      sender: '@bot:example.com', // Own user
                      content: { msgtype: 'm.text', body: 'my own msg' },
                    },
                  ]),
                },
              }),
          };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(onMessage).not.toHaveBeenCalled();

    await ch.disconnect();
  });

  it('skips non-text messages', async () => {
    const onMessage = vi.fn();
    const roomId = '!room:example.com';
    const groups: Record<string, RegisteredGroup> = {
      [roomId]: {
        name: 'test',
        folder: 'test',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00Z',
      },
    };

    const ch = new MatrixChannel(
      makeOpts({
        onMessage,
        registeredGroups: () => groups,
      }),
    );

    let syncCall = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCall++;
        if (syncCall === 1) {
          return {
            ok: true,
            json: async () =>
              makeSyncResponse({
                rooms: {
                  [roomId]: makeRoomEvents([
                    {
                      sender: '@alice:example.com',
                      content: { msgtype: 'm.image', body: 'photo.jpg' },
                    },
                  ]),
                },
              }),
          };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(onMessage).not.toHaveBeenCalled();

    await ch.disconnect();
  });

  it('sendMessage calls fetch with correct URL and body', async () => {
    const ch = new MatrixChannel(makeOpts());
    const roomId = '!room:example.com';

    await ch.sendMessage(roomId, 'Hello world');

    const sendCall = fetchMock.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === 'string' &&
        args[0].includes('/send/m.room.message/'),
    );
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall!;
    expect(url).toContain(
      `https://matrix.example.com/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`,
    );
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      msgtype: 'm.text',
      body: 'Hello world',
    });
    expect(init.headers['Authorization']).toBe('Bearer syt_test_token');
  });

  it('sendMessage throws on HTTP error', async () => {
    const ch = new MatrixChannel(makeOpts());

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => '{"errcode":"M_LIMIT_EXCEEDED"}',
    } as Response);

    await expect(
      ch.sendMessage('!room:example.com', 'Hello'),
    ).rejects.toThrow('Matrix sendMessage failed: 429');
  });

  it('setTyping calls fetch with correct URL', async () => {
    const ch = new MatrixChannel(makeOpts());
    const roomId = '!room:example.com';

    await ch.setTyping!(roomId, true);

    const typingCall = fetchMock.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('/typing/'),
    );
    expect(typingCall).toBeDefined();
    const [url, init] = typingCall!;
    expect(url).toContain(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent('@bot:example.com')}`,
    );
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toMatchObject({ typing: true });
  });

  it('setTyping handles failure gracefully', async () => {
    const ch = new MatrixChannel(makeOpts());

    fetchMock.mockImplementation(async () => {
      throw new Error('Network error');
    });

    // Should not throw
    await expect(
      ch.setTyping!('!room:example.com', true),
    ).resolves.toBeUndefined();
  });

  it('auto-joins on invite', async () => {
    const ch = new MatrixChannel(makeOpts());
    const inviteRoomId = '!invite:example.com';

    let syncCall = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCall++;
        if (syncCall === 1) {
          return {
            ok: true,
            json: async () =>
              makeSyncResponse({
                invites: {
                  [inviteRoomId]: {
                    invite_state: {
                      events: [
                        {
                          type: 'm.room.member',
                          sender: '@admin:example.com',
                          state_key: '@bot:example.com',
                          content: { membership: 'invite' },
                        },
                      ],
                    },
                  },
                },
              }),
          };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    await new Promise((r) => setTimeout(r, 50));

    const joinCall = fetchMock.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('/join/'),
    );
    expect(joinCall).toBeDefined();
    const [joinUrl] = joinCall!;
    expect(joinUrl).toContain(encodeURIComponent(inviteRoomId));

    await ch.disconnect();
  });

  it('extracts display name from MXID', async () => {
    const onMessage = vi.fn();
    const roomId = '!room:example.com';
    const groups: Record<string, RegisteredGroup> = {
      [roomId]: {
        name: 'test',
        folder: 'test',
        trigger: '@Bot',
        added_at: '2024-01-01T00:00:00Z',
      },
    };

    const ch = new MatrixChannel(
      makeOpts({
        onMessage,
        registeredGroups: () => groups,
      }),
    );

    let syncCall = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync')) {
        syncCall++;
        if (syncCall === 1) {
          return {
            ok: true,
            json: async () =>
              makeSyncResponse({
                rooms: {
                  [roomId]: makeRoomEvents([
                    {
                      sender: '@charlie:matrix.org',
                      content: { msgtype: 'm.text', body: 'hi' },
                      event_id: '$name_test',
                    },
                  ]),
                },
              }),
          };
        }
        return abortableHang(url, init);
      }
      return { ok: true, json: async () => ({}) };
    });

    await ch.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(onMessage).toHaveBeenCalledWith(
      roomId,
      expect.objectContaining({
        sender_name: 'charlie',
      }),
    );

    await ch.disconnect();
  });
});

describe('matrixFactory', () => {
  it('returns a Channel when credentials are set', () => {
    const ch = channelFactory(makeOpts());
    expect(ch).not.toBeNull();
    expect(ch!.name).toBe('matrix');
  });

  it('returns null when credentials are missing', async () => {
    const config = await import('../config.js');
    const saved = config.MATRIX_ACCESS_TOKEN;
    // Temporarily clear the access token
    Object.defineProperty(config, 'MATRIX_ACCESS_TOKEN', { value: '', writable: true });
    expect(channelFactory(makeOpts())).toBeNull();
    // Restore
    Object.defineProperty(config, 'MATRIX_ACCESS_TOKEN', { value: saved, writable: true });
  });
});
