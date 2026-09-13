import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceSessionController, parseControlIntent } from '../packages/voice/src/session.js';

test('voice session starts work without coupling microphone and speaking state', async () => {
  const calls: string[] = [];
  const session = new VoiceSessionController({
    sessionId: 'phone',
    runs: {
      start: async (text) => {
        calls.push(`start:${text}`);
        return 'run_1';
      },
      pause: async () => {},
      resume: async () => {},
      cancel: async () => {},
    },
  });

  session.microphone('connected');
  session.tts('started');
  const result = await session.transcript({ text: 'revisa GitHub', final: true, language: 'es' });

  assert.equal(result.kind, 'task');
  assert.equal(result.runId, 'run_1');
  assert.deepEqual(calls, ['start:revisa GitHub']);
  const snapshot = session.snapshot();
  assert.equal(snapshot.phase, 'working');
  assert.equal(snapshot.microphoneConnected, true);
  assert.equal(snapshot.speaking, true);
});

test('spoken pause resume and stop control the active run instead of creating new work', async () => {
  const calls: string[] = [];
  let runCounter = 0;
  const session = new VoiceSessionController({
    sessionId: 'phone',
    runs: {
      start: async (text) => {
        runCounter += 1;
        calls.push(`start:${text}`);
        return `run_${runCounter}`;
      },
      pause: async (runId) => calls.push(`pause:${runId}`),
      resume: async (runId) => calls.push(`resume:${runId}`),
      cancel: async (runId) => calls.push(`cancel:${runId}`),
    },
  });

  session.microphone('connected');
  await session.transcript({ text: 'haz una investigación', final: true });
  await session.transcript({ text: 'pausa', final: true });
  await session.transcript({ text: 'continúa', final: true });
  await session.transcript({ text: 'para', final: true });

  assert.deepEqual(calls, [
    'start:haz una investigación',
    'pause:run_1',
    'resume:run_1',
    'cancel:run_1',
  ]);
  assert.equal(session.snapshot().activeRunId, undefined);
  assert.equal(session.snapshot().phase, 'listening');
});

test('control intent parser keeps normal requests separate', () => {
  assert.equal(parseControlIntent('Janus, pausa.'), 'pause');
  assert.equal(parseControlIntent('Sigue'), 'resume');
  assert.equal(parseControlIntent('detente'), 'cancel');
  assert.equal(parseControlIntent('para buscar información sobre Paddle'), null);
});
