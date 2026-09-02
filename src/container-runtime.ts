/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell
 * Docker for something that is not a session: per-group image builds and the
 * egress lockdown network.
 */

/**
 * The container runtime binary name for image and network operations.
 *
 * Session lifecycle has its own driver selection. Deployments using a
 * compatible runtime must set this alongside NANOCLAW_RUNTIME_DRIVER so image
 * builds and egress-network operations use the same engine.
 */
export const CONTAINER_RUNTIME_BIN = process.env.CONTAINER_RUNTIME?.trim() || 'docker';
