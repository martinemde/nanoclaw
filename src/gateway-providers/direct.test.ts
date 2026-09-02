import { describe, expect, it } from 'vitest';

import { getGatewayProviderFactory } from './gateway-provider-registry.js';
import { createDirectGatewayProvider } from './direct.js';

describe('direct gateway provider', () => {
  it('registers and contributes no credentials or mounts', async () => {
    expect(getGatewayProviderFactory('direct')).toBe(createDirectGatewayProvider);

    const provider = createDirectGatewayProvider();
    expect(provider.kind).toBe('direct');
    await expect(provider.contribute({} as never)).resolves.toEqual({});
    expect(provider.approvals).toBeUndefined();
  });
});
