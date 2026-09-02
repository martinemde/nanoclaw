import fs from 'fs';
import os from 'os';
import path from 'path';

import { Task, TaskState } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, defaultServerCallContextBuilder } from '@a2a-js/sdk/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileTaskStore } from '../a2a/file-task-store.js';
import type { ChannelSetup } from './adapter.js';
import { A2AChannelBridge, createA2ARequestHandler, isAuthorizedBearer } from './a2a.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('A2AChannelBridge', () => {
  it('maps contextId to the NanoClaw thread and resolves from normal channel delivery', async () => {
    const bridge = new A2AChannelBridge(1_000);
    const onInbound = vi.fn(async (_platformId: string, threadId: string | null) => {
      queueMicrotask(() => bridge.deliver('a2a:gateway', threadId, { kind: 'chat', content: { text: 'A2A_OK' } }));
    });
    bridge.attach({ onInbound } as unknown as ChannelSetup);

    await expect(bridge.dispatch({ contextId: 'context-1', messageId: 'message-1', text: 'test' })).resolves.toBe(
      'A2A_OK',
    );
    expect(onInbound).toHaveBeenCalledWith(
      'a2a:gateway',
      'context-1',
      expect.objectContaining({ content: expect.objectContaining({ text: 'test' }) }),
    );
  });

  it('rejects a second in-flight task in the same context', async () => {
    const bridge = new A2AChannelBridge(1_000);
    bridge.attach({ onInbound: vi.fn() } as unknown as ChannelSetup);
    const first = bridge.dispatch({ contextId: 'busy', messageId: 'message-1', text: 'first' });

    await expect(bridge.dispatch({ contextId: 'busy', messageId: 'message-2', text: 'second' })).rejects.toThrow(
      'already has a task in flight',
    );
    bridge.close();
    await expect(first).rejects.toThrow('gateway stopped');
  });
});

describe('A2A HTTP gateway', () => {
  it('validates bearer credentials in constant time', () => {
    expect(isAuthorizedBearer('Bearer test-token', 'test-token')).toBe(true);
    expect(isAuthorizedBearer('Bearer wrong-token', 'test-token')).toBe(false);
    expect(isAuthorizedBearer('', 'test-token')).toBe(false);
  });

  it('runs an official SendMessage request and persists the completed task', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-a2a-http-'));
    roots.push(root);
    const taskStore = new FileTaskStore(root);
    const requestHandler = createA2ARequestHandler({
      publicUrl: 'http://127.0.0.1/a2a',
      taskStore,
      dispatch: async ({ contextId, text }) => `reply:${contextId}:${text}`,
    });
    const transport = new JsonRpcTransportHandler(requestHandler);
    const context = defaultServerCallContextBuilder({
      extensions: undefined,
      user: { isAuthenticated: true, userName: 'a2a:gateway' },
      headers: { 'a2a-version': '1.0' },
      requestedVersion: '1.0',
      tenant: '',
    });

    const envelope = await transport.handle(sendMessageRequest(), context);
    if (Symbol.asyncIterator in envelope) throw new Error('blocking SendMessage unexpectedly returned a stream');
    const result = envelope.result as { task: unknown };
    const task = Task.fromJSON(result.task);
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task.contextId).toBe('context-1');
    expect(task.artifacts?.[0]?.parts[0]?.content).toEqual({
      $case: 'text',
      value: 'reply:context-1:run this',
    });

    const saved = await taskStore.load(task.id, context);
    expect(saved?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});

function sendMessageRequest(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 'request-1',
    method: 'SendMessage',
    params: {
      tenant: '',
      message: {
        messageId: 'message-1',
        contextId: 'context-1',
        role: 'ROLE_USER',
        parts: [{ text: 'run this' }],
      },
      configuration: { blocking: true, acceptedOutputModes: ['text/plain'] },
    },
  };
}
