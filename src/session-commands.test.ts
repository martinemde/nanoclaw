import { describe, it, expect, vi } from 'vitest';
import { extractSessionCommand, handleSessionCommand, isSessionCommandAllowed } from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toEqual({ command: '/compact' });
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toEqual({ command: '/compact' });
  });

  it('detects bare /clear', () => {
    expect(extractSessionCommand('/clear', trigger)).toEqual({ command: '/clear' });
  });

  it('detects /clear with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /clear', trigger)).toEqual({ command: '/clear' });
  });

  it('detects /resume with session ID', () => {
    expect(extractSessionCommand('/resume abc-123', trigger)).toEqual({ command: '/resume', arg: 'abc-123' });
  });

  it('detects /resume with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /resume abc-123', trigger)).toEqual({ command: '/resume', arg: 'abc-123' });
  });

  it('rejects /resume without session ID', () => {
    expect(extractSessionCommand('/resume', trigger)).toBeNull();
  });

  it('rejects /resume with multiple args', () => {
    expect(extractSessionCommand('/resume abc 123', trigger)).toBeNull();
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects /clear with extra text', () => {
    expect(extractSessionCommand('/clear all history', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
    expect(extractSessionCommand('/cleared', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(extractSessionCommand('please compact the conversation', trigger)).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toEqual({ command: '/compact' });
    expect(extractSessionCommand('  /clear  ', trigger)).toEqual({ command: '/clear' });
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
    expect(extractSessionCommand('/Clear', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(content: string, overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SessionCommandDeps> = {}): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    setSession: vi.fn(),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  // --- /compact ---

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/compact', expect.any(Function));
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith('<formatted>', expect.any(Function));
    expect(deps.runAgent).toHaveBeenCalledWith('/compact', expect.any(Function));
  });

  it('reports failure when /compact runAgent returns error', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
      await onOutput({ status: 'success', result: null });
      return 'error';
    })});
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to process'));
  });

  // --- /clear ---

  it('forwards /clear to container as SDK slash command', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/clear', expect.any(Function));
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('/clear skips pre-command messages since session is being wiped', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('some context', { timestamp: '99' }),
      makeMsg('/clear', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).not.toHaveBeenCalled();
    // Only one runAgent call — just /clear, no pre-command processing
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    expect(deps.runAgent).toHaveBeenCalledWith('/clear', expect.any(Function));
  });

  // --- /resume ---

  it('handles authorized /resume in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/resume abc-123')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.closeStdin).toHaveBeenCalled();
    expect(deps.setSession).toHaveBeenCalledWith('abc-123');
    expect(deps.sendMessage).toHaveBeenCalledWith('Resumed session: abc-123');
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  // --- auth ---

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Session commands require admin access.');
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({ canSenderInteract: vi.fn().mockReturnValue(false) });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/clear', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith('/compact', expect.any(Function));
  });
});
