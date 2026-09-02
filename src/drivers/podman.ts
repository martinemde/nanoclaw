/** Rootless Podman realization for Linux service identities. */
import os from 'os';

import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from '../egress-lockdown.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import { realCli, type Cli } from './cli.js';
import { DockerSessionDriver, agentContainerName } from './docker-driver.js';
import { registerSessionDriver } from './driver-registry.js';
import type { MountPolicy, SessionSpec } from './types.js';

const HOST_TCP_PORTS_SETTING = 'NANOCLAW_PODMAN_HOST_TCP_PORTS';

export function configuredPodmanHostTcpPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw =
    env[HOST_TCP_PORTS_SETTING]?.trim() || readEnvFile([HOST_TCP_PORTS_SETTING])[HOST_TCP_PORTS_SETTING] || '';
  if (!raw) return [];
  return [...new Set(raw.split(',').map((value) => Number(value.trim())))].map((port) => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${HOST_TCP_PORTS_SETTING} contains an invalid TCP port: ${port}`);
    }
    return port;
  });
}

function podmanNetworkArgs(spec: SessionSpec, hostTcpPorts: number[]): string[] {
  if (ensureEgressNetwork()) {
    log.info('Egress lockdown active', { containerName: agentContainerName(spec), network: EGRESS_NETWORK });
    return egressNetworkArgs();
  }
  if (hostTcpPorts.length > 0) {
    return ['--network', `pasta:${hostTcpPorts.map((port) => `-T,${port}`).join(',')}`];
  }
  return os.platform() === 'linux' ? ['--add-host=host.docker.internal:host-gateway'] : [];
}

export function createPodmanDriver(
  policy: MountPolicy,
  cli: Cli = realCli('podman'),
  hostTcpPorts = configuredPodmanHostTcpPorts(),
): DockerSessionDriver {
  return new DockerSessionDriver({
    ...policy,
    kind: 'podman',
    cli,
    // A rootless process otherwise maps the requested container UID into a
    // subordinate host UID and loses write access to NanoClaw's bind mounts.
    runtimeArgsFor: () => ['--userns=keep-id'],
    networkArgsFor: (spec) => podmanNetworkArgs(spec, hostTcpPorts),
  });
}

registerSessionDriver('podman', createPodmanDriver);
