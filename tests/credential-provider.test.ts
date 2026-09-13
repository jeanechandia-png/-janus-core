import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CredentialBroker,
  EnvironmentCredentialProvider,
  type CredentialProvider,
} from '../packages/security/src/credential-provider.js';

test('environment provider exposes status without exposing token value', async () => {
  const provider = new EnvironmentCredentialProvider({
    serviceVariables: { 'google-workspace': 'GOOGLE_TOKEN' },
    environment: { GOOGLE_TOKEN: 'super-secret-google-token' },
  });

  const status = await provider.status('google-workspace');
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('super-secret-google-token'), false);

  const lease = await provider.get({ service: 'google-workspace' });
  assert.equal(lease?.accessToken, 'super-secret-google-token');
});

test('broker skips expired leases and falls back to next provider', async () => {
  const expired: CredentialProvider = {
    get: async () => ({
      accessToken: 'expired-token',
      source: 'expired-provider',
      expiresAt: '2026-09-13T10:00:00.000Z',
    }),
    status: async () => ({ configured: true, source: 'expired-provider' }),
  };
  const current: CredentialProvider = {
    get: async () => ({
      accessToken: 'current-token',
      source: 'secure-provider',
      expiresAt: '2026-09-13T20:00:00.000Z',
    }),
    status: async () => ({ configured: true, source: 'secure-provider' }),
  };

  const broker = new CredentialBroker(
    [expired, current],
    () => new Date('2026-09-13T18:00:00.000Z'),
  );
  const lease = await broker.lease({ service: 'google-workspace' });
  assert.equal(lease?.accessToken, 'current-token');
  assert.equal(lease?.source, 'secure-provider');
});

test('broker fails closed when no provider has a credential', async () => {
  const provider = new EnvironmentCredentialProvider({
    serviceVariables: { github: 'GITHUB_TOKEN' },
    environment: {},
  });
  const broker = new CredentialBroker([provider]);

  assert.equal(await broker.accessToken('github'), undefined);
  const status = await broker.status('github');
  assert.equal(status.configured, false);
  assert.equal(JSON.stringify(status).includes('token'), false);
});
