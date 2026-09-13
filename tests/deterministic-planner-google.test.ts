import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicPlan } from '../packages/orchestrator/src/deterministic-planner.js';

test('plans a Drive search from natural Spanish', () => {
  const plan = deterministicPlan('busca en Drive Proyecto Janus');
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  const [step] = plan.steps;
  assert.ok(step);
  assert.equal(step.tool, 'google-workspace');
  assert.equal(step.action, 'drive.files.search');
  assert.equal(step.input.query, 'Proyecto Janus');
  assert.equal(step.requiresApproval, false);
});

test('plans a Gmail search without inventing a write action', () => {
  const plan = deterministicPlan('revisa correos de Menzis');
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  const [step] = plan.steps;
  assert.ok(step);
  assert.equal(step.tool, 'google-workspace');
  assert.equal(step.action, 'gmail.messages.search');
  assert.equal(step.input.query, 'Menzis');
  assert.equal(step.risk, 'none');
});

test('plans upcoming Calendar reads with configurable timezone context', () => {
  const plan = deterministicPlan('mira mi calendario', { timeZone: 'Europe/Amsterdam' });
  assert.ok(plan);
  assert.equal(plan.steps.length, 1);
  const [step] = plan.steps;
  assert.ok(step);
  assert.equal(step.action, 'calendar.events.list');
  assert.equal(step.input.timeZone, 'Europe/Amsterdam');
  assert.equal(step.input.calendarId, 'primary');
});
