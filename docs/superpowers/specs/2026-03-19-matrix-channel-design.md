# Matrix Channel for NanoClaw

Add Matrix as a second messaging channel in NanoClaw, allowing the bot to
participate in rooms on the private Tuwunel homeserver alongside the existing
WhatsApp channel.

## Goal

Route Matrix room messages through the same agent pipeline that WhatsApp
uses today. Both channels run simultaneously in the same process.

## Architecture

```
Matrix room ──► MatrixChannel (matrix-bot-sdk)
                   │
                   ├─► onMessage / onChatMetadata callbacks (shared)
                   │
                   ▼
              router.findChannel(jid)  ◄── ownsJid("!room:matrix") → true
                   │
                   ▼
              GroupQueue / processGroupMessages (unchanged)
                   │
                   ▼
              Container agent (unchanged)
```

No changes to the container, IPC, group queue, or agent runner.

## Components

### `src/channels/matrix.ts` — MatrixChannel class

Implements the `Channel` interface:

- **name**: `"matrix"`
- **connect()**: Create `MatrixClient` from `matrix-bot-sdk`, login with
  access token, enable autojoin, start syncing, listen for `room.message`
  events. Resolve once initial sync completes.
- **sendMessage(jid, text)**: Send `m.room.message` (msgtype `m.text`)
  to the room.
- **isConnected()**: Track sync state.
- **ownsJid(jid)**: Return true for Matrix room IDs (`!` prefix).
- **setTyping(jid, isTyping)**: Use Matrix typing notification API.
- **disconnect()**: Stop the client sync.

Message handling mirrors WhatsApp:
- Extract sender display name, body, timestamp from Matrix event
- Skip events from the bot's own user ID (mark as `is_bot_message`)
- Call `onMessage` for registered rooms, `onChatMetadata` for all rooms

### Configuration

New env vars (all optional — Matrix channel only starts if set):

| Variable | Example | Notes |
|----------|---------|-------|
| `MATRIX_HOMESERVER_URL` | `https://matrix.tail67a9d.ts.net` | Tuwunel URL |
| `MATRIX_ACCESS_TOKEN` | (vault) | Bot account token |
| `MATRIX_USER_ID` | `@yo:matrix` | Bot's Matrix user ID |

Read in `config.ts`. Export as optional values.

### Wiring in `index.ts`

```typescript
if (MATRIX_HOMESERVER_URL && MATRIX_ACCESS_TOKEN) {
  const matrix = new MatrixChannel(channelOpts);
  channels.push(matrix);
  await matrix.connect();
}
```

Existing `findChannel`/`routeOutbound` in `router.ts` already dispatch by
JID, so Matrix rooms route correctly with no changes.

### Deployment (Ansible)

- Add `MATRIX_ACCESS_TOKEN` to vault
- Add Matrix env vars to `nanoclaw-env.j2`
- Register a bot user on Tuwunel (e.g. `@yo:matrix`)
- No new containers or systemd units

## Decisions

- **No E2EE** — private tailnet, unnecessary complexity
- **Auto-join on invite** — simplest room onboarding; admin invites bot
- **Access token auth** — no password stored, token from registration API
- **matrix-bot-sdk** over matrix-js-sdk — lighter, bot-focused, no browser deps

## Out of Scope

- E2E encryption
- Media/file message support (text only for now)
- Matrix-specific admin commands
- Federation (Tuwunel has it disabled)
