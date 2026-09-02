import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { Task, TaskState, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';

interface PageToken {
  offset: number;
}

/** Durable, caller-scoped A2A task storage using one atomic JSON file per task. */
export class FileTaskStore implements TaskStore {
  constructor(private readonly root: string) {}

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const dir = this.scopeDir(context);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const destination = this.taskPath(dir, task.id);
    const temporary = path.join(dir, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(Task.toJSON(task))}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    try {
      const raw = await fs.readFile(this.taskPath(this.scopeDir(context), taskId), 'utf8');
      return Task.fromJSON(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const tasks = await this.readScope(context);
    const filtered = tasks
      .filter((task) => !params.contextId || task.contextId === params.contextId)
      .filter(
        (task) =>
          params.status === TaskState.TASK_STATE_UNSPECIFIED ||
          params.status === TaskState.UNRECOGNIZED ||
          task.status?.state === params.status,
      )
      .filter((task) => {
        if (!params.statusTimestampAfter) return true;
        const timestamp = task.status?.timestamp;
        return timestamp !== undefined && timestamp >= params.statusTimestampAfter;
      })
      .sort((a, b) => (b.status?.timestamp ?? '').localeCompare(a.status?.timestamp ?? ''));

    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
    const offset = decodePageToken(params.pageToken);
    const page = filtered.slice(offset, offset + pageSize).map((task) => projectTask(task, params));
    const nextOffset = offset + page.length;

    return {
      tasks: page,
      nextPageToken: nextOffset < filtered.length ? encodePageToken({ offset: nextOffset }) : '',
      pageSize,
      totalSize: filtered.length,
    };
  }

  private scopeDir(context: ServerCallContext): string {
    const tenant = context.tenant ?? '';
    const owner = context.user?.isAuthenticated ? context.user.userName : 'anonymous';
    const scope = createHash('sha256').update(tenant).update('\0').update(owner).digest('hex');
    return path.join(this.root, scope);
  }

  private taskPath(dir: string, taskId: string): string {
    const filename = createHash('sha256').update(taskId).digest('hex');
    return path.join(dir, `${filename}.json`);
  }

  private async readScope(context: ServerCallContext): Promise<Task[]> {
    const dir = this.scopeDir(context);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => Task.fromJSON(JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')))),
    );
  }
}

function projectTask(task: Task, params: ListTasksRequest): Task {
  const projected = structuredClone(task);
  if (!params.includeArtifacts) projected.artifacts = [];
  if (params.historyLength === 0) projected.history = [];
  else if (params.historyLength !== undefined) projected.history = projected.history.slice(-params.historyLength);
  return projected;
}

function encodePageToken(token: PageToken): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

function decodePageToken(raw: string): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PageToken>;
    return Number.isSafeInteger(parsed.offset) && (parsed.offset ?? -1) >= 0 ? parsed.offset! : 0;
  } catch (_error) {
    return 0;
  }
}
