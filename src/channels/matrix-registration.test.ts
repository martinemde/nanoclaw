/**
 * Integration test for the matrix channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs matrix.ts's
 * top-level `registerChannelAdapter('matrix', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './matrix.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and matrix.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. It does require the adapter package (`@beeper/chat-adapter-matrix`) to be installed,
 * which holds in a composed install: the skill's `pnpm install` step runs before this
 * test — so this test also implicitly guards that dependency (an unmocked import throws
 * if the package is missing).
 *
 * matrix is a Chat SDK channel: matrix.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js. That core-consumption is a
 * typed call, so the build/typecheck leg (`pnpm run build`) guards it against upstream
 * drift, not this test. Every Chat SDK channel follows this same shape.
 */
import { createMatrixAdapter } from '@beeper/chat-adapter-matrix';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

afterEach(() => vi.unstubAllEnvs());

describe('matrix channel registration', () => {
  it('registers matrix via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('matrix');
  });

  it('declares Matrix as polling so it does not bind the shared webhook port', () => {
    vi.stubEnv('MATRIX_BASE_URL', 'https://matrix.example.test');
    vi.stubEnv('MATRIX_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('MATRIX_USER_ID', '@finances:matrix.example.test');

    const adapter = createMatrixAdapter();

    expect(adapter.runtimeMode).toBe('polling');
  });

  it('uses the Node crypto store when E2EE is enabled from the environment', () => {
    vi.stubEnv('MATRIX_BASE_URL', 'https://matrix.example.test');
    vi.stubEnv('MATRIX_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('MATRIX_USER_ID', '@finances:matrix.example.test');
    vi.stubEnv('MATRIX_DEVICE_ID', 'FINANCE_TEST');
    vi.stubEnv('MATRIX_RECOVERY_KEY', 'test-recovery-key');

    const adapter = createMatrixAdapter();

    expect(Reflect.get(adapter, 'e2eeConfig')).toMatchObject({ useIndexedDB: false });
  });

  it('does not configure a crypto store without E2EE', () => {
    vi.stubEnv('MATRIX_BASE_URL', 'https://matrix.example.test');
    vi.stubEnv('MATRIX_ACCESS_TOKEN', 'test-token');
    vi.stubEnv('MATRIX_USER_ID', '@finances:matrix.example.test');
    vi.stubEnv('MATRIX_DEVICE_ID', 'FINANCE_TEST');
    vi.stubEnv('MATRIX_RECOVERY_KEY', '');

    const adapter = createMatrixAdapter();

    expect(Reflect.get(adapter, 'e2eeConfig').useIndexedDB).toBeUndefined();
  });
});
