import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
} from '../../gateways/src/contracts.js';

export interface ChatCompletionsModelAdapterOptions {
  baseUrl: string;
  model: string;
  providerName?: string;
  apiKey?: string;
  tokenProvider?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  supportsJsonMode?: boolean;
}

type JsonRecord = Record<string, unknown>;

export class ChatCompletionsModelAdapter implements ModelGateway {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly providerName: string;
  private readonly apiKey?: string;
  private readonly tokenProvider?: () => Promise<string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly supportsJsonMode: boolean;

  constructor(options: ChatCompletionsModelAdapterOptions) {
    const baseUrl = options.baseUrl.trim();
    const model = options.model.trim();
    if (!baseUrl) throw new Error('Model baseUrl is required');
    if (!model) throw new Error('Model name is required');

    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.providerName = options.providerName?.trim() || new URL(baseUrl).host;
    this.apiKey = options.apiKey;
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.supportsJsonMode = options.supportsJsonMode ?? false;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const token = (this.tokenProvider ? await this.tokenProvider() : this.apiKey)?.trim();
    const headers = new Headers({
      'content-type': 'application/json',
      accept: 'application/json',
    });
    if (token) headers.set('authorization', `Bearer ${token}`);

    const body: JsonRecord = {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
    };
    if (request.responseFormat === 'json' && this.supportsJsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const payload = await safeJson(response);
    if (!response.ok) {
      throw new Error(modelErrorMessage(payload, response.status));
    }

    const choices = Array.isArray(payload.choices) ? payload.choices.filter(isRecord) : [];
    const first = choices[0];
    const message = first && isRecord(first.message) ? first.message : undefined;
    const text = message && typeof message.content === 'string' ? message.content : undefined;
    if (!text) throw new Error('Model response did not contain message content');

    return {
      text,
      model: typeof payload.model === 'string' ? payload.model : this.model,
      provider: this.providerName,
      usage: normalizeUsage(payload.usage),
    };
  }
}

async function safeJson(response: Response): Promise<JsonRecord> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function modelErrorMessage(payload: JsonRecord, status: number): string {
  const error = isRecord(payload.error) ? payload.error : {};
  const message = typeof error.message === 'string' ? error.message : undefined;
  return message ? `Model HTTP ${status}: ${message}` : `Model request failed with HTTP ${status}`;
}

function normalizeUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'number' && Number.isFinite(item)) usage[key] = item;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
