import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRegistry } from '../packages/core/src/capability-registry.js';

test('available catalog exposes only capabilities ready for execution', () => {
  const registry = new CapabilityRegistry();
  registry.register({
    tool: 'github',
    actions: ['repo.get', 'file.read'],
    state: 'available',
  });
  registry.register({
    tool: 'google-workspace',
    actions: ['drive.files.search', 'gmail.messages.search'],
    state: 'needs_auth',
    reason: 'Google authorization required',
  });

  assert.deepEqual(registry.availableCatalog(), {
    github: ['file.read', 'repo.get'],
  });
  assert.equal(registry.check('github', 'repo.get').ok, true);
  assert.deepEqual(registry.check('google-workspace', 'drive.files.search'), {
    ok: false,
    state: 'needs_auth',
    reason: 'Google authorization required',
  });
});

test('unknown capabilities fail closed', () => {
  const registry = new CapabilityRegistry();
  const result = registry.check('unknown', 'do.anything');
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unavailable');
  assert.match(result.reason ?? '', /not registered/i);
});

test('state can be promoted after authentication without rebuilding registry', () => {
  const registry = new CapabilityRegistry();
  registry.register({
    tool: 'google-workspace',
    actions: ['calendar.events.list'],
    state: 'needs_auth',
  });

  assert.equal(registry.check('google-workspace', 'calendar.events.list').ok, false);
  registry.setState('google-workspace', 'available');
  assert.equal(registry.check('google-workspace', 'calendar.events.list').ok, true);
});

test('allowed policy catalog remains distinct from current availability', () => {
  const registry = new CapabilityRegistry();
  registry.register({
    tool: 'google-workspace',
    actions: ['drive.files.search'],
    state: 'needs_auth',
  });

  assert.equal(registry.allAllowedTools().has('google-workspace'), true);
  assert.equal(registry.allAllowedActions().get('google-workspace')?.has('drive.files.search'), true);
  assert.deepEqual(registry.availableCatalog(), {});
});
