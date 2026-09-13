import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SpeechInputChunk,
  TranscriptEvent,
  VoiceGateway,
} from '../packages/gateways/src/contracts.js';
import { DuplexVoiceEngine, type DuplexVoiceEvent } from '../packages/voice/src/duplex-engine.js';
import { VoiceSessionController } from '../packages/voice/src/session.js';

const TTS_MIME = 'audio/pcm;rate=24000;channels=1;format=s16le';

class TranscriptGateway implements VoiceGateway {
  async *transcribeStream(chunks: AsyncIterable<SpeechInputChunk>): AsyncIterable<TranscriptEvent> {
    let count = 0;
    for await (const _chunk of chunks) {
      count += 1;
      if (count === 1) {
        yield { text: 'haz una investigación', final: false, language: 'es' };
        yield { text: 'haz una investigación', final: true, language: 'es' };
      } else if (count === 2) {
        yield { text: 'pausa', final: true, language: 'es' };
      }
    }
  }

  async *synthesize(_text: string, _voiceId: string) {
    yield { bytes: new Uint8Array([1]), mimeType: TTS_MIME };
  }
}

test('streaming transcription can start work and later control the same run', async () => {
  const calls: string[] = [];
  const session = new VoiceSessionController({
    sessionId: 'voice-live',
    runs: {
      start: async (text) => {
        calls.push(`start:${text}`);
        return 'run_1';
      },
      pause: async (runId) => { calls.push(`pause:${runId}`); },
      resume: async () => {},
      cancel: async () => {},
    },
  });
  const events: DuplexVoiceEvent[] = [];
  const engine = new DuplexVoiceEngine({
    gateway: new TranscriptGateway(),
    session,
    voiceId: 'janus-canonical',
    onEvent: async (event) => { events.push(event); },
  });

  engine.start();
  engine.pushAudio(chunk(1));
  engine.pushAudio(chunk(2));
  engine.endInput();
  await engine.waitForTranscription();

  assert.deepEqual(calls, [
    'start:haz una investigación',
    'pause:run_1',
  ]);
  assert.ok(events.some((event) => event.type === 'transcript.partial'));
  assert.equal(events.filter((event) => event.type === 'transcript.final').length, 2);
  assert.equal(session.snapshot().phase, 'paused');
});

test('barge-in interrupts TTS after the current emitted chunk without killing session', async () => {
  const session = new VoiceSessionController({
    sessionId: 'barge-in',
    runs: {
      start: async () => 'run_1',
      pause: async () => {},
      resume: async () => {},
      cancel: async () => {},
    },
  });
  session.microphone('connected');

  const gateway: VoiceGateway = {
    transcribeStream: async function* () {},
    synthesize: async function* () {
      yield { bytes: new Uint8Array([1, 2]), mimeType: TTS_MIME };
      yield { bytes: new Uint8Array([3, 4]), mimeType: TTS_MIME };
      yield { bytes: new Uint8Array([5, 6]), mimeType: TTS_MIME };
    },
  };

  const events: DuplexVoiceEvent[] = [];
  let engine: DuplexVoiceEngine;
  engine = new DuplexVoiceEngine({
    gateway,
    session,
    voiceId: 'janus-canonical',
    onEvent: async (event) => {
      events.push(event);
      if (event.type === 'speech.chunk' && event.sequence === 1) {
        engine.userSpeechStarted();
      }
    },
  });

  await engine.speak('Respuesta que debe poder interrumpirse.');

  const chunks = events.filter((event) => event.type === 'speech.chunk');
  assert.equal(chunks.length, 1);
  const firstChunk = chunks[0];
  assert.ok(firstChunk && firstChunk.type === 'speech.chunk');
  assert.equal(firstChunk.mimeType, TTS_MIME);
  const interrupted = events.find((event) => event.type === 'speech.interrupted');
  assert.ok(interrupted && interrupted.type === 'speech.interrupted');
  assert.equal(interrupted.reason, 'barge-in');
  assert.equal(interrupted.chunks, 1);
  assert.equal(session.snapshot().speaking, false);
  assert.equal(session.snapshot().microphoneConnected, true);
});

test('completed synthesis reports chunk count and returns speaking state to false', async () => {
  const session = new VoiceSessionController({
    sessionId: 'speech-complete',
    runs: {
      start: async () => 'run_1',
      pause: async () => {},
      resume: async () => {},
      cancel: async () => {},
    },
  });
  const gateway: VoiceGateway = {
    transcribeStream: async function* () {},
    synthesize: async function* () {
      yield { bytes: new Uint8Array([1]), mimeType: TTS_MIME };
      yield { bytes: new Uint8Array([2]), mimeType: TTS_MIME };
    },
  };
  const events: DuplexVoiceEvent[] = [];
  const engine = new DuplexVoiceEngine({
    gateway,
    session,
    voiceId: 'janus-canonical',
    onEvent: async (event) => { events.push(event); },
  });

  await engine.speak('Todo listo.');

  const completed = events.find((event) => event.type === 'speech.completed');
  assert.ok(completed && completed.type === 'speech.completed');
  assert.equal(completed.chunks, 2);
  assert.equal(session.snapshot().speaking, false);
});

function chunk(sequence: number): SpeechInputChunk {
  return {
    bytes: new Uint8Array([sequence]),
    mimeType: 'audio/pcm;rate=16000;channels=1;format=s16le',
    sequence,
  };
}
