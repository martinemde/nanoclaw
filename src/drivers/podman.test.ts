import { describe, expect, it, vi } from 'vitest';

import { FakeCli } from './fake-cli.js';
import { configuredPodmanHostTcpPorts, createPodmanDriver } from './podman.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

describe('Podman driver', () => {
  it('validates and de-duplicates host loopback ports', () => {
    expect(configuredPodmanHostTcpPorts({ NANOCLAW_PODMAN_HOST_TCP_PORTS: '1234, 4321,1234' })).toEqual([1234, 4321]);
    expect(() => configuredPodmanHostTcpPorts({ NANOCLAW_PODMAN_HOST_TCP_PORTS: '1234,nope' })).toThrow(
      'NANOCLAW_PODMAN_HOST_TCP_PORTS contains an invalid TCP port',
    );
  });

  it('realizes lifecycle and exec through Podman with the rootless UID mapping', async () => {
    const cli = new FakeCli('podman');
    cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
    const driver = createPodmanDriver(FIXTURE_POLICY, cli, [1234]);

    const handle = await driver.prepare(fixtureSpec());

    expect(driver.kind).toBe('podman');
    expect(cli.callMatching(/^create /)?.args).toContain('--userns=keep-id');
    expect(cli.callMatching(/^create /)?.args).toContain('pasta:-T,1234');
    expect(handle.execSpec(['true']).bin).toBe('podman');
  });
});
