import { createHash } from 'node:crypto';
import { request } from 'node:http';
import type { InboundEvent } from './channels/adapter.js';
import { readEnvFile } from './env.js';
import type { AgentGroup } from './types.js';

export type InboundDecision = { route: 'handled'; text: string } | { route: 'agent'; context: string };
export type InboundProcessor = (event: InboundEvent, group: AgentGroup) => Promise<InboundDecision | undefined>;
let processor: InboundProcessor | null = null;

export function setInboundProcessor(next: InboundProcessor | null): void {
  processor = next;
}
export function processInbound(event: InboundEvent, group: AgentGroup): Promise<InboundDecision | undefined> {
  return processor ? processor(event, group) : Promise.resolve(undefined);
}

export function initInboundProcessor(): void {
  const env = readEnvFile(['NANOCLAW_INBOUND_PROCESSOR_SOCKET', 'NANOCLAW_INBOUND_PROCESSOR_FOLDER']);
  if (!env.NANOCLAW_INBOUND_PROCESSOR_SOCKET && !env.NANOCLAW_INBOUND_PROCESSOR_FOLDER) return;
  if (!env.NANOCLAW_INBOUND_PROCESSOR_SOCKET || !env.NANOCLAW_INBOUND_PROCESSOR_FOLDER)
    throw new Error('Inbound processor requires both socket and agent folder');
  setInboundProcessor(
    socketMessageProcessor(env.NANOCLAW_INBOUND_PROCESSOR_SOCKET, env.NANOCLAW_INBOUND_PROCESSOR_FOLDER),
  );
}

/** Trusted host capability, called only after the router's sender and command gates. */
export function socketMessageProcessor(socketPath: string, folder: string): InboundProcessor {
  return async (event, group) => {
    if (group.folder !== folder) return;
    let content: { text?: string; attachments?: unknown[] };
    try {
      content = JSON.parse(event.message.content);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (!content || typeof content !== 'object') return;
    if (typeof content.text !== 'string' || !content.text.trim() || content.text.trimStart().startsWith('/')) return;
    const id = `native:${createHash('sha256')
      .update(
        JSON.stringify([
          group.id,
          event.instance ?? event.channelType,
          event.platformId,
          event.threadId,
          event.message.id,
        ]),
      )
      .digest('hex')}`;
    const body = JSON.stringify({
      operation: 'message.handle',
      correlationId: id,
      message: { id, text: content.text, attachments: (content.attachments?.length ?? 0) > 0 },
    });
    try {
      const result = await post(socketPath, body);
      if (result.route === 'handled' && typeof result.text === 'string' && result.text.trim())
        return { route: 'handled', text: result.text };
      if (result.route !== 'agent') throw new Error('Invalid processor response');
      return { route: 'agent', context: JSON.stringify(result) };
      // eslint-disable-next-line no-catch-all/no-catch-all -- all transport/protocol failures need an uncertain handoff; never expose response bodies
    } catch {
      // The request may have reached the broker. Missing output does not prove no write occurred.
      return {
        route: 'agent',
        context: JSON.stringify({
          route: 'agent',
          reason: 'Message processor unavailable or response lost; inspect current state before retrying any mutation.',
          outcomeUncertain: true,
        }),
      };
    }
  };
}

function post(socketPath: string, body: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/v1/request',
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1_048_576) req.destroy(new Error('Processor response too large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('Processor request failed');
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')).result;
            if (!value || typeof value !== 'object' || Array.isArray(value))
              throw new Error('Invalid processor result');
            resolve(value);
            // eslint-disable-next-line no-catch-all/no-catch-all -- asynchronous callback must reject the request promise
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(180_000, () => req.destroy(new Error('Processor timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
