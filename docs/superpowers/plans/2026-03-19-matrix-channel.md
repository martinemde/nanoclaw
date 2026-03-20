# Matrix Channel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Matrix as a second messaging channel in NanoClaw so the bot can participate in Matrix rooms on the private Tuwunel homeserver.

**Architecture:** Implement `MatrixChannel` class following the upstream channel registry pattern. The channel module self-registers via `registerChannel()` at import time, with a factory that returns `null` when credentials are missing. The channel uses `matrix-bot-sdk` to connect to Tuwunel, auto-joins rooms on invite, and routes messages through the existing group queue and container agent pipeline. Both WhatsApp and Matrix channels run simultaneously.

**Tech Stack:** TypeScript, matrix-bot-sdk, vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/channels/matrix.ts` | MatrixChannel class + self-registration via registerChannel() |
| Create | `src/channels/matrix.test.ts` | Unit tests for MatrixChannel |
| Modify | `src/config.ts` | Add Matrix env var exports |
| Modify | `src/channels/index.ts` | Add matrix import to channel barrel file |
| Modify | `package.json` | Add matrix-bot-sdk dependency |
| Modify | `ansible/roles/nanoclaw/templates/nanoclaw-env.j2` (homestead repo) | Add Matrix env vars |
| Modify | `ansible/inventory/host_vars/pi/vault.yml` (homestead repo) | Add Matrix access token |

---

## Chunk 1: MatrixChannel Implementation

### Task 1: Add matrix-bot-sdk dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install matrix-bot-sdk**

```bash
cd /home/martinemde/src/qwibitai/nanoclaw
npm install matrix-bot-sdk
```

- [ ] **Step 2: Verify it installed**

Run: `node -e "require('matrix-bot-sdk')"`
Expected: No error

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add matrix-bot-sdk dependency"
```

---

### Task 2: Add Matrix config variables

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add Matrix env var reads to config.ts**

Add after the existing `TRIGGER_PATTERN` block (around line 58):

```typescript
// Matrix channel (optional — channel only starts if all three are set)
export const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL || '';
export const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || '';
export const MATRIX_USER_ID = process.env.MATRIX_USER_ID || '';
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "Add Matrix channel config variables"
```

---

### Task 3: Write MatrixChannel tests

**Files:**
- Create: `src/channels/matrix.test.ts`

Follow the same mock/test structure as the WhatsApp channel tests. Mock `matrix-bot-sdk` instead of Baileys.

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({
  MATRIX_HOMESERVER_URL: 'https://matrix.example.ts.net',
  MATRIX_ACCESS_TOKEN: 'test-token',
  MATRIX_USER_ID: '@bot:matrix',
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Build a fake MatrixClient
function createFakeClient() {
  const emitter = new EventEmitter();
  const client = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    getUserId: vi.fn().mockReturnValue('@bot:matrix'),
    getJoinedRooms: vi.fn().mockResolvedValue([]),
    joinRoom: vi.fn().mockResolvedValue('!joined:matrix'),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
      return client;
    },
    _emitter: emitter,
  };
  return client;
}

let fakeClient: ReturnType<typeof createFakeClient>;

vi.mock('matrix-bot-sdk', () => {
  return {
    MatrixClient: vi.fn(() => fakeClient),
    AutojoinRoomsMixin: {
      setupOnClient: vi.fn(),
    },
    SimpleFsStorageProvider: vi.fn(),
  };
});

import { MatrixChannel } from './matrix.js';
import type { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<ChannelOpts>,
): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      '!registered:matrix': {
        name: 'Test Room',
        folder: 'test-room',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

// --- Tests ---

describe('MatrixChannel', () => {
  beforeEach(() => {
    fakeClient = createFakeClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('channel properties', () => {
    it('has name "matrix"', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.name).toBe('matrix');
    });
  });

  describe('connection lifecycle', () => {
    it('connects and starts syncing', async () => {
      const channel = new MatrixChannel(createTestOpts());
      await channel.connect();
      expect(fakeClient.start).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const channel = new MatrixChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();
      expect(fakeClient.stop).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('ownsJid', () => {
    it('owns Matrix room IDs (! prefix)', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('!abc123:matrix')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new MatrixChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });
  });

  describe('message handling', () => {
    it('delivers message for registered room', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);
      await channel.connect();

      fakeClient._emitter.emit('room.message', '!registered:matrix', {
        type: 'm.room.message',
        sender: '@alice:matrix',
        origin_server_ts: Date.now(),
        content: {
          msgtype: 'm.text',
          body: 'Hello Andy',
        },
        event_id: '$event1',
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '!registered:matrix',
        expect.any(String),
        undefined,
        'matrix',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        '!registered:matrix',
        expect.objectContaining({
          id: '$event1',
          content: 'Hello Andy',
          sender: '@alice:matrix',
          sender_name: 'alice',
          is_bot_message: false,
        }),
      );
    });

    it('only emits metadata for unregistered rooms', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);
      await channel.connect();

      fakeClient._emitter.emit('room.message', '!unregistered:matrix', {
        type: 'm.room.message',
        sender: '@bob:matrix',
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.text', body: 'Hello' },
        event_id: '$event2',
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips messages from the bot itself', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);
      await channel.connect();

      fakeClient._emitter.emit('room.message', '!registered:matrix', {
        type: 'm.room.message',
        sender: '@bot:matrix',
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.text', body: 'My own message' },
        event_id: '$event3',
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips non-text message types', async () => {
      const opts = createTestOpts();
      const channel = new MatrixChannel(opts);
      await channel.connect();

      fakeClient._emitter.emit('room.message', '!registered:matrix', {
        type: 'm.room.message',
        sender: '@alice:matrix',
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.image', body: 'photo.jpg', url: 'mxc://...' },
        event_id: '$event4',
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('sends m.text message to room', async () => {
      const channel = new MatrixChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('!room:matrix', 'Hello from bot');

      expect(fakeClient.sendMessage).toHaveBeenCalledWith(
        '!room:matrix',
        {
          msgtype: 'm.text',
          body: 'Hello from bot',
        },
      );
    });
  });

  describe('setTyping', () => {
    it('sends typing notification', async () => {
      const channel = new MatrixChannel(createTestOpts());
      await channel.connect();

      await channel.setTyping('!room:matrix', true);
      expect(fakeClient.sendTyping).toHaveBeenCalledWith(
        '!room:matrix',
        true,
        30000,
      );
    });

    it('sends stop typing notification', async () => {
      const channel = new MatrixChannel(createTestOpts());
      await channel.connect();

      await channel.setTyping('!room:matrix', false);
      expect(fakeClient.sendTyping).toHaveBeenCalledWith(
        '!room:matrix',
        false,
        0,
      );
    });

    it('handles typing failure gracefully', async () => {
      const channel = new MatrixChannel(createTestOpts());
      await channel.connect();

      fakeClient.sendTyping.mockRejectedValueOnce(new Error('Failed'));
      await expect(
        channel.setTyping('!room:matrix', true),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/martinemde/src/qwibitai/nanoclaw && npx vitest run src/channels/matrix.test.ts`
Expected: FAIL — `./matrix.js` module not found

- [ ] **Step 3: Commit test file**

```bash
git add src/channels/matrix.test.ts
git commit -m "Add Matrix channel tests"
```

---

### Task 4: Implement MatrixChannel

**Files:**
- Create: `src/channels/matrix.ts`

- [ ] **Step 1: Write the MatrixChannel implementation**

```typescript
import {
  AutojoinRoomsMixin,
  MatrixClient,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';

import {
  MATRIX_ACCESS_TOKEN,
  MATRIX_HOMESERVER_URL,
  MATRIX_USER_ID,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client: MatrixClient;
  private connected = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const storage = new SimpleFsStorageProvider('store/matrix-bot.json');
    this.client = new MatrixClient(
      MATRIX_HOMESERVER_URL,
      MATRIX_ACCESS_TOKEN,
      storage,
    );
  }

  async connect(): Promise<void> {
    AutojoinRoomsMixin.setupOnClient(this.client);

    this.client.on('room.message', (roomId: string, event: any) => {
      this.handleMessage(roomId, event);
    });

    await this.client.start();
    this.connected = true;
    logger.info('Connected to Matrix');
  }

  private handleMessage(roomId: string, event: any): void {
    if (!event?.content) return;
    if (event.content.msgtype !== 'm.text') return;

    const sender = event.sender || '';

    // Skip messages from the bot itself
    if (sender === MATRIX_USER_ID) return;

    const timestamp = new Date(event.origin_server_ts).toISOString();
    const body = event.content.body || '';

    // Always emit chat metadata
    this.opts.onChatMetadata(
      roomId,
      timestamp,
      undefined,
      'matrix',
      true, // Matrix rooms are always "groups"
    );

    // Only deliver full message for registered rooms
    const groups = this.opts.registeredGroups();
    if (!groups[roomId]) return;

    // Extract display name from MXID: @alice:matrix → alice
    const senderName = sender.startsWith('@')
      ? sender.slice(1).split(':')[0]
      : sender;

    this.opts.onMessage(roomId, {
      id: event.event_id || '',
      chat_jid: roomId,
      sender,
      sender_name: senderName,
      content: body,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      await this.client.sendMessage(jid, {
        msgtype: 'm.text',
        body: text,
      });
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('!');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client.stop();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const timeout = isTyping ? 30000 : 0;
      await this.client.sendTyping(jid, isTyping, timeout);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update Matrix typing status');
    }
  }
}

// Self-register: factory returns null when credentials are missing
registerChannel('matrix', (opts) => {
  if (!MATRIX_HOMESERVER_URL || !MATRIX_ACCESS_TOKEN) return null;
  return new MatrixChannel(opts);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /home/martinemde/src/qwibitai/nanoclaw && npx vitest run src/channels/matrix.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/channels/matrix.ts
git commit -m "Add MatrixChannel implementation"
```

---

## Chunk 2: Wiring & Deployment

### Task 5: Register Matrix in channel barrel file

**Files:**
- Modify: `src/channels/index.ts`

The upstream channel registry auto-discovers channels via the barrel file.
Each import triggers the channel module's `registerChannel()` call.

- [ ] **Step 1: Add matrix import to `src/channels/index.ts`**

Add after the existing commented channel lines:

```typescript
// matrix
import './matrix.js';
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/channels/index.ts
git commit -m "Register Matrix channel in barrel file"
```

---

### Task 6: Create bot user and deploy config

**Files (homestead repo):**
- Modify: `ansible/roles/nanoclaw/templates/nanoclaw-env.j2`
- Modify: `ansible/inventory/host_vars/pi/vault.yml`

- [ ] **Step 1: Register a Matrix bot user**

```bash
SESSION=$(curl -sk https://matrix.tail67a9d.ts.net/_matrix/client/v3/register \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['session'])")

curl -sk https://matrix.tail67a9d.ts.net/_matrix/client/v3/register \
  -X POST -H 'Content-Type: application/json' -d "{
  \"username\": \"yo\",
  \"password\": \"$(openssl rand -base64 32)\",
  \"auth\": {
    \"type\": \"m.login.registration_token\",
    \"token\": \"GryQtv1t9KArO6TEZT-wQJTvvKTPn2AhQdyw411_Hew\",
    \"session\": \"$SESSION\"
  }
}"
```

Save the `access_token` from the response.

- [ ] **Step 2: Add access token to Ansible vault**

```bash
cd ~/homestead/ansible
ansible-vault edit inventory/host_vars/pi/vault.yml
```

Add:
```yaml
nanoclaw_matrix_access_token: <token-from-step-1>
```

- [ ] **Step 3: Add Matrix env vars to nanoclaw-env.j2**

Append to the template:

```
MATRIX_HOMESERVER_URL=https://matrix.tail67a9d.ts.net
MATRIX_ACCESS_TOKEN={{ nanoclaw_matrix_access_token }}
MATRIX_USER_ID=@yo:matrix
```

- [ ] **Step 4: Deploy**

```bash
cd ~/homestead/ansible
ansible-playbook playbooks/site.yml --tags nanoclaw
```

- [ ] **Step 5: Verify NanoClaw starts with Matrix connected**

```bash
sudo journalctl _UID=1001 -u nanoclaw -n 20 --no-pager
```

Expected: Log line containing "Connected to Matrix"

- [ ] **Step 6: Commit homestead changes**

```bash
cd ~/homestead
git add ansible/roles/nanoclaw/templates/nanoclaw-env.j2 ansible/inventory/host_vars/pi/vault.yml
git commit -m "Add Matrix channel config for NanoClaw"
```

---

### Task 7: Test end-to-end

- [ ] **Step 1: Create a Matrix room and invite the bot**

From your Matrix client (Element/FluffyChat), create a room and invite `@yo:matrix`.

- [ ] **Step 2: Register the room as a NanoClaw group**

Use the existing IPC mechanism or send a message in the main WhatsApp group to register the Matrix room ID.

- [ ] **Step 3: Send a test message in the Matrix room**

Send `@yo hello` and verify the bot responds.

- [ ] **Step 4: Verify in logs**

```bash
sudo journalctl _UID=1001 -u nanoclaw -f
```

Confirm message receipt and agent container launch.
