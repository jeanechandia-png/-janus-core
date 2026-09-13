import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicPlan } from '../packages/orchestrator/src/deterministic-planner.js';

test('plans a Drive search from natural Spanish', () => {
  const plan = deterministicPlan('busca en Drive Proyecto Janus');
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'google-workspace');
  assert.equal(plan.steps[0].action, 'drive.files.search');
  assert.equal(plan.steps[0].input.query, 'Proyecto Janus');
  assert.equal(plan.steps[0].requiresApproval, false);
});

test('plans a Gmail search without inventing a write action', () => {
  const plan = deterministicPlan('revisa correos de Menzis');
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].tool, 'google-workspace');
  assert.equal(plan.steps[0].action, 'gmail.messages.search');
  assert.equal(plan.steps[0].input.query, 'Menzis');
  assert.equal(plan.steps[0].risk, 'none');
});

test('plans upcoming Calendar reads with configurable timezone context', () => {
  const plan = deterministicPlan('mira mi calendario', { timeZone: 'Europe/Amsterdam' });
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].action, 'calendar.events.list');
  assert.equal(plan.steps[0].input.timeZone, 'Europe/Amsterdam');
  assert.equal(plan.steps[0].input.calendarId, 'primary');
});
