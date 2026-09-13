import type {
  SpeechInputChunk,
  SpeechToTextGateway,
  TextToSpeechGateway,
  TranscriptEvent,
  VoiceGateway,
} from '../../gateways/src/contracts.js';

export class CompositeVoiceGateway implements VoiceGateway {
  constructor(
    private readonly stt: SpeechToTextGateway,
    private readonly tts: TextToSpeechGateway,
  ) {}

  transcribeStream(chunks: AsyncIterable<SpeechInputChunk>): AsyncIterable<TranscriptEvent> {
    return this.stt.transcribeStream(chunks);
  }

  synthesize(text: string, voiceId: string): AsyncIterable<Uint8Array> {
    return this.tts.synthesize(text, voiceId);
  }
}
