/**
 * Credential-free gateway for sessions that only use uncredentialed local
 * services. It contributes no environment or mounts; selecting it is an
 * explicit opt-out from the built-in OneCLI credential gateway.
 */
import { registerGatewayProvider, type GatewayProvider } from './gateway-provider-registry.js';

export function createDirectGatewayProvider(): GatewayProvider {
  return {
    kind: 'direct',
    async contribute() {
      return {};
    },
  };
}

registerGatewayProvider('direct', createDirectGatewayProvider);
