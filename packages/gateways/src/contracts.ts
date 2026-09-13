export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  temperature?: number;
  responseFormat?: 'text' | 'json';
}

export interface ModelResponse {
  text: string;
  model: string;
  provider: string;
  usage?: Record<string, number>;
}

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface SpeechInputChunk {
  bytes: Uint8Array;
  mimeType: string;
  sequence: number;
}

export interface TranscriptEvent {
  text: string;
  final: boolean;
  language?: string;
}

export interface VoiceGateway {
  transcribeStream(
    chunks: AsyncIterable<SpeechInputChunk>,
  ): AsyncIterable<TranscriptEvent>;
  synthesize(text: string, voiceId: string): AsyncIterable<Uint8Array>;
}

export interface ToolRequest {
  tool: string;
  action: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ToolProgress {
  phase: 'started' | 'progress' | 'completed';
  message: string;
  percent?: number;
  data?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  externalReference?: string;
}

export interface ToolAdapter {
  readonly name: string;
  readonly capabilities: string[];
  execute(
    request: ToolRequest,
    onProgress: (progress: ToolProgress) => void | Promise<void>,
  ): Promise<ToolResult>;
}

export interface ToolGateway {
  register(adapter: ToolAdapter): void;
  execute(
    request: ToolRequest,
    onProgress: (progress: ToolProgress) => void | Promise<void>,
  ): Promise<ToolResult>;
}
