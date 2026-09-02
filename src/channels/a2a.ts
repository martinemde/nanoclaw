import { randomUUID, timingSafeEqual } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type Part,
  type Task,
} from '@a2a-js/sdk';
import { TaskNotCancelableError } from '@a2a-js/sdk/errors';
import {
  AgentEvent,
  DefaultRequestHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import express, { type Express, type RequestHandler } from 'express';

import { FileTaskStore } from '../a2a/file-task-store.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'a2a';
const PLATFORM_ID = 'a2a:gateway';
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

const A2A_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: true,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'strict',
  },
  group: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: true,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'strict',
  },
  mentions: 'never',
};

const ENV_KEYS = [
  'A2A_BIND_HOST',
  'A2A_PORT',
  'A2A_PUBLIC_URL',
  'A2A_BEARER_TOKEN_FILE',
  'A2A_TASK_STORE_DIR',
  'A2A_TASK_TIMEOUT_MS',
] as const;

export interface A2ADispatchRequest {
  contextId: string;
  messageId: string;
  text: string;
}

export type A2ADispatch = (request: A2ADispatchRequest) => Promise<string>;

interface PendingReply {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Correlates one in-flight A2A request per context with NanoClaw delivery. */
export class A2AChannelBridge {
  private setupConfig: ChannelSetup | null = null;
  private readonly pending = new Map<string, PendingReply>();

  constructor(private readonly timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {}

  attach(config: ChannelSetup): void {
    this.setupConfig = config;
  }

  async dispatch(request: A2ADispatchRequest): Promise<string> {
    if (!this.setupConfig) throw new Error('A2A channel is not initialized');
    if (this.pending.has(request.contextId)) {
      throw new Error(`A2A context ${request.contextId} already has a task in flight`);
    }

    let settle!: PendingReply;
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.contextId);
        reject(new Error(`NanoClaw did not answer A2A context ${request.contextId} within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      settle = { resolve, reject, timer };
    });
    this.pending.set(request.contextId, settle);

    try {
      await this.setupConfig.onInbound(PLATFORM_ID, request.contextId, {
        id: `a2a-${request.messageId || randomUUID()}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        isMention: false,
        isGroup: false,
        content: {
          text: request.text,
          sender: 'A2A client',
          senderId: PLATFORM_ID,
        },
      });
    } catch (error) {
      this.reject(request.contextId, error instanceof Error ? error : new Error(String(error)));
    }

    return reply;
  }

  deliver(platformId: string, threadId: string | null, message: OutboundMessage): string | undefined {
    if (platformId !== PLATFORM_ID || !threadId) return undefined;
    const pending = this.pending.get(threadId);
    if (!pending) {
      log.warn('A2A reply has no matching in-flight task', { contextId: threadId });
      return undefined;
    }
    const text = extractOutboundText(message);
    if (text === null) {
      this.reject(threadId, new Error('NanoClaw produced a non-text response for a text-only A2A task'));
      return undefined;
    }
    clearTimeout(pending.timer);
    this.pending.delete(threadId);
    pending.resolve(text);
    return `a2a-${randomUUID()}`;
  }

  close(): void {
    for (const contextId of this.pending.keys()) {
      this.reject(contextId, new Error('A2A gateway stopped before NanoClaw answered'));
    }
    this.setupConfig = null;
  }

  private reject(contextId: string, error: Error): void {
    const pending = this.pending.get(contextId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(contextId);
    pending.reject(error);
  }
}

export class NanoClawA2AExecutor implements AgentExecutor {
  constructor(private readonly dispatch: A2ADispatch) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    const timestamp = new Date().toISOString();
    const initialTask: Task = requestContext.task
      ? structuredClone(requestContext.task)
      : {
          id: taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp, message: undefined },
          artifacts: [],
          history: [userMessage],
          metadata: undefined,
        };

    eventBus.publish(AgentEvent.task(initialTask));
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined },
        metadata: undefined,
      }),
    );

    try {
      const text = extractInboundContent(userMessage);
      const response = await this.dispatch({ contextId, messageId: userMessage.messageId, text });
      const responseMessage = agentMessage(taskId, contextId, response);
      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: randomUUID(),
            name: 'NanoClaw response',
            description: 'The completed NanoClaw response.',
            parts: [textPart(response)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            timestamp: new Date().toISOString(),
            message: responseMessage,
          },
          metadata: undefined,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            timestamp: new Date().toISOString(),
            message: agentMessage(taskId, contextId, `NanoClaw A2A task failed: ${message}`),
          },
          metadata: undefined,
        }),
      );
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    throw new TaskNotCancelableError('NanoClaw A2A cancellation is not implemented');
  }
}

export function createA2AHttpApp(options: {
  publicUrl: string;
  bearerToken: string;
  taskStore: TaskStore;
  dispatch: A2ADispatch;
}): Express {
  const handler = createA2ARequestHandler(options);
  const app = express();

  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.status(200).json({ ok: true }));
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler, cache: { maxAge: 60 } }));
  app.use('/a2a', bearerAuth(options.bearerToken));
  app.use(
    '/a2a',
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: async () => ({ isAuthenticated: true, userName: PLATFORM_ID }),
    }),
  );

  return app;
}

export function createA2ARequestHandler(options: {
  publicUrl: string;
  taskStore: TaskStore;
  dispatch: A2ADispatch;
}): DefaultRequestHandler {
  return new DefaultRequestHandler(
    createAgentCard(options.publicUrl),
    options.taskStore,
    new NanoClawA2AExecutor(options.dispatch),
  );
}

export function createA2AChannelAdapter(options: {
  bindHost: string;
  port: number;
  publicUrl: string;
  bearerToken: string;
  taskStoreRoot: string;
  taskTimeoutMs?: number;
}): ChannelAdapter {
  const bridge = new A2AChannelBridge(options.taskTimeoutMs);
  let server: http.Server | null = null;

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: true,
    defaults: A2A_DEFAULTS,

    async setup(config): Promise<void> {
      bridge.attach(config);
      const app = createA2AHttpApp({
        publicUrl: options.publicUrl,
        bearerToken: options.bearerToken,
        taskStore: new FileTaskStore(options.taskStoreRoot),
        dispatch: (request) => bridge.dispatch(request),
      });
      server = http.createServer(app);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(options.port, options.bindHost, resolve);
      });
      log.info('A2A gateway listening', {
        bindHost: options.bindHost,
        port: options.port,
        publicUrl: options.publicUrl,
      });
    },

    async teardown(): Promise<void> {
      bridge.close();
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        closing.close((error) => (error ? reject(error) : resolve()));
      });
    },

    isConnected: () => server?.listening === true,
    deliver: async (platformId, threadId, message) => bridge.deliver(platformId, threadId, message),
  };
}

function createAgentCard(publicUrl: string): AgentCard {
  return {
    name: 'NanoClaw',
    description: 'A personal NanoClaw agent that accepts authenticated text tasks.',
    supportedInterfaces: [
      { url: publicUrl, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION, tenant: '' },
    ],
    provider: undefined,
    version: '2.3.0',
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'Opaque bearer token issued by the NanoClaw operator.',
            scheme: 'bearer',
            bearerFormat: '',
          },
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'nanoclaw-task',
        name: 'Run a NanoClaw task',
        description: 'Run a text task in an isolated NanoClaw session and return the response as an artifact.',
        tags: ['assistant', 'task', 'nanoclaw'],
        examples: ['Summarize the current project status.'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['text/plain'],
        securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      },
    ],
    signatures: [],
  };
}

function bearerAuth(expectedToken: string): RequestHandler {
  return (request, response, next) => {
    const authorization = request.header('authorization') ?? '';
    if (!isAuthorizedBearer(authorization, expectedToken)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      response.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

export function isAuthorizedBearer(authorization: string, expectedToken: string): boolean {
  const expected = Buffer.from(expectedToken);
  const supplied = authorization.startsWith('Bearer ') ? Buffer.from(authorization.slice(7)) : Buffer.alloc(0);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function extractInboundContent(message: Message): string {
  const text = message.parts
    .flatMap((part) => {
      if (part.content?.$case === 'text') return [part.content.value];
      if (part.content?.$case === 'data') return [JSON.stringify(part.content.value)];
      return [];
    })
    .join('\n')
    .trim();
  if (!text) throw new Error('NanoClaw A2A requires a text or data part');
  return text;
}

function extractOutboundText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    taskId,
    contextId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function readPositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    if (!env.A2A_PORT) return null;
    const bindHost = env.A2A_BIND_HOST || '127.0.0.1';
    const port = readPositiveInteger(env.A2A_PORT, 3100, 'A2A_PORT');
    if (port > 65535) throw new Error('A2A_PORT must be at most 65535');
    const tokenFile = env.A2A_BEARER_TOKEN_FILE;
    if (!tokenFile) throw new Error('A2A_BEARER_TOKEN_FILE is required when A2A_PORT is set');
    const bearerToken = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!bearerToken) throw new Error('A2A bearer token file is empty');
    const publicUrl = env.A2A_PUBLIC_URL || `http://${bindHost}:${port}/a2a`;
    const taskStoreRoot = env.A2A_TASK_STORE_DIR || path.join(DATA_DIR, 'a2a-tasks');
    const taskTimeoutMs = readPositiveInteger(env.A2A_TASK_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS, 'A2A_TASK_TIMEOUT_MS');
    return createA2AChannelAdapter({ bindHost, port, publicUrl, bearerToken, taskStoreRoot, taskTimeoutMs });
  },
  defaults: A2A_DEFAULTS,
});
