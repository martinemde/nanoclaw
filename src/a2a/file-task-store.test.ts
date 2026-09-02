import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { Role, TaskState, type Task } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTaskStore } from './file-task-store.js';

let root: string;

const alice = new ServerCallContext({
  user: { isAuthenticated: true, userName: 'alice' },
  tenant: 'home',
});
const bob = new ServerCallContext({
  user: { isAuthenticated: true, userName: 'bob' },
  tenant: 'home',
});

function task(id: string, state: TaskState, timestamp: string): Task {
  return {
    id,
    contextId: 'context-1',
    status: { state, timestamp, message: undefined },
    artifacts: [
      {
        artifactId: `artifact-${id}`,
        name: 'response',
        description: '',
        parts: [{ content: { $case: 'text', value: id }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [
      {
        messageId: `message-${id}`,
        contextId: 'context-1',
        taskId: id,
        role: Role.ROLE_USER,
        parts: [{ content: { $case: 'text', value: id }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
    ],
    metadata: undefined,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-a2a-tasks-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FileTaskStore', () => {
  it('survives a new store instance and scopes tasks to the authenticated caller', async () => {
    await new FileTaskStore(root).save(task('task-1', TaskState.TASK_STATE_COMPLETED, '2026-09-02T10:00:00Z'), alice);

    expect((await new FileTaskStore(root).load('task-1', alice))?.id).toBe('task-1');
    expect(await new FileTaskStore(root).load('task-1', bob)).toBeUndefined();
  });

  it('filters, paginates, and projects artifacts and history', async () => {
    const store = new FileTaskStore(root);
    await store.save(task('older', TaskState.TASK_STATE_COMPLETED, '2026-09-02T10:00:00Z'), alice);
    await store.save(task('newer', TaskState.TASK_STATE_COMPLETED, '2026-09-02T11:00:00Z'), alice);
    await store.save(task('failed', TaskState.TASK_STATE_FAILED, '2026-09-02T12:00:00Z'), alice);

    const first = await store.list(
      {
        tenant: 'home',
        contextId: 'context-1',
        status: TaskState.TASK_STATE_COMPLETED,
        pageSize: 1,
        pageToken: '',
        historyLength: 0,
        statusTimestampAfter: undefined,
        includeArtifacts: false,
      },
      alice,
    );
    expect(first.tasks.map((item) => item.id)).toEqual(['newer']);
    expect(first.tasks[0].history).toEqual([]);
    expect(first.tasks[0].artifacts).toEqual([]);
    expect(first.totalSize).toBe(2);
    expect(first.nextPageToken).not.toBe('');

    const second = await store.list(
      {
        tenant: 'home',
        contextId: 'context-1',
        status: TaskState.TASK_STATE_COMPLETED,
        pageSize: 1,
        pageToken: first.nextPageToken,
        historyLength: 1,
        statusTimestampAfter: undefined,
        includeArtifacts: true,
      },
      alice,
    );
    expect(second.tasks.map((item) => item.id)).toEqual(['older']);
    expect(second.tasks[0].history).toHaveLength(1);
    expect(second.tasks[0].artifacts).toHaveLength(1);
    expect(second.nextPageToken).toBe('');
  });
});
