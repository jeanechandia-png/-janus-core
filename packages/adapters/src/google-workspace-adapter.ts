import type {
  ToolAdapter,
  ToolProgress,
  ToolRequest,
  ToolResult,
} from '../../gateways/src/contracts.js';

export interface GoogleWorkspaceAdapterOptions {
  accessToken?: string;
  tokenProvider?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

type JsonRecord = Record<string, unknown>;

export class GoogleWorkspaceAdapter implements ToolAdapter {
  readonly name = 'google-workspace';
  readonly capabilities = [
    'drive.files.search',
    'gmail.messages.search',
    'calendar.events.list',
  ];

  private readonly accessToken?: string;
  private readonly tokenProvider?: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleWorkspaceAdapterOptions = {}) {
    this.accessToken = options.accessToken;
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(
    request: ToolRequest,
    onProgress: (progress: ToolProgress) => void | Promise<void>,
  ): Promise<ToolResult> {
    if (!this.capabilities.includes(request.action)) {
      return { ok: false, error: `Unsupported Google Workspace action: ${request.action}` };
    }

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    await onProgress({
      phase: 'started',
      message: `Google Workspace: ${request.action}`,
      data: { action: request.action },
    });

    try {
      let result: ToolResult;
      if (request.action === 'drive.files.search') {
        result = await this.searchDrive(request.input, token);
      } else if (request.action === 'gmail.messages.search') {
        result = await this.searchGmail(request.input, token);
      } else {
        result = await this.listCalendarEvents(request.input, token);
      }

      await onProgress({
        phase: result.ok ? 'completed' : 'progress',
        message: result.ok ? 'Google Workspace completado' : 'Google Workspace devolvió un error',
        percent: result.ok ? 100 : undefined,
      });
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async getAccessToken(): Promise<string> {
    const token = (this.tokenProvider ? await this.tokenProvider() : this.accessToken)?.trim();
    if (!token) {
      throw new Error('Google Workspace is not authenticated; provide an ephemeral access token through the secure credential provider.');
    }
    return token;
  }

  private async searchDrive(input: JsonRecord, token: string): Promise<ToolResult> {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    const rawQuery = stringValue(input.rawQuery);
    const query = stringValue(input.query);
    const pageSize = boundedInteger(input.pageSize, 20, 1, 100);

    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,parents)',
    );

    if (rawQuery) {
      url.searchParams.set('q', rawQuery);
    } else if (query) {
      url.searchParams.set('q', `name contains '${escapeDriveLiteral(query)}' and trashed = false`);
    } else {
      url.searchParams.set('q', 'trashed = false');
    }

    const payload = await this.requestJson(url, token);
    if (!payload.ok) return payload;

    const body = payload.body;
    return {
      ok: true,
      output: {
        files: Array.isArray(body.files) ? body.files : [],
        nextPageToken: body.nextPageToken,
      },
      externalReference: 'google-drive',
    };
  }

  private async searchGmail(input: JsonRecord, token: string): Promise<ToolResult> {
    const query = stringValue(input.query);
    const maxResults = boundedInteger(input.maxResults, 10, 1, 25);
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('maxResults', String(maxResults));
    if (query) listUrl.searchParams.set('q', query);
    if (input.includeSpamTrash === true) listUrl.searchParams.set('includeSpamTrash', 'true');

    const listed = await this.requestJson(listUrl, token);
    if (!listed.ok) return listed;

    const messages = Array.isArray(listed.body.messages)
      ? listed.body.messages.filter(isJsonRecord).slice(0, maxResults)
      : [];

    const details: JsonRecord[] = [];
    for (const message of messages) {
      const id = stringValue(message.id);
      if (!id) continue;
      const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
      detailUrl.searchParams.set('format', 'metadata');
      detailUrl.searchParams.append('metadataHeaders', 'Subject');
      detailUrl.searchParams.append('metadataHeaders', 'From');
      detailUrl.searchParams.append('metadataHeaders', 'To');
      detailUrl.searchParams.append('metadataHeaders', 'Date');
      detailUrl.searchParams.set(
        'fields',
        'id,threadId,labelIds,snippet,internalDate,payload(headers)',
      );
      const detail = await this.requestJson(detailUrl, token);
      if (!detail.ok) return detail;
      details.push(normalizeGmailMessage(detail.body));
    }

    return {
      ok: true,
      output: {
        messages: details,
        resultSizeEstimate: listed.body.resultSizeEstimate,
        nextPageToken: listed.body.nextPageToken,
      },
      externalReference: 'gmail',
    };
  }

  private async listCalendarEvents(input: JsonRecord, token: string): Promise<ToolResult> {
    const calendarId = stringValue(input.calendarId) ?? 'primary';
    const maxResults = boundedInteger(input.maxResults, 25, 1, 100);
    const now = new Date();
    const defaultTimeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const timeMin = validIsoDate(input.timeMin) ?? now.toISOString();
    const timeMax = validIsoDate(input.timeMax) ?? defaultTimeMax.toISOString();

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', String(maxResults));
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set(
      'fields',
      'nextPageToken,timeZone,items(id,status,summary,description,location,htmlLink,start,end,attendees(email,responseStatus,self),organizer(email,displayName,self))',
    );
    const timeZone = stringValue(input.timeZone);
    if (timeZone) url.searchParams.set('timeZone', timeZone);

    const payload = await this.requestJson(url, token);
    if (!payload.ok) return payload;

    return {
      ok: true,
      output: {
        events: Array.isArray(payload.body.items) ? payload.body.items : [],
        timeZone: payload.body.timeZone,
        nextPageToken: payload.body.nextPageToken,
        window: { timeMin, timeMax },
      },
      externalReference: 'google-calendar',
    };
  }

  private async requestJson(
    url: URL,
    token: string,
  ): Promise<{ ok: true; body: JsonRecord } | { ok: false; error: string }> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });

    const body = await safeJson(response);
    if (!response.ok) {
      return {
        ok: false,
        error: googleErrorMessage(body, response.status),
      };
    }
    return { ok: true, body };
  }
}

function normalizeGmailMessage(message: JsonRecord): JsonRecord {
  const payload = isJsonRecord(message.payload) ? message.payload : {};
  const headers = Array.isArray(payload.headers) ? payload.headers.filter(isJsonRecord) : [];
  const headerMap: Record<string, string> = {};
  for (const header of headers) {
    const name = stringValue(header.name)?.toLowerCase();
    const value = stringValue(header.value);
    if (name && value) headerMap[name] = value;
  }

  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds,
    snippet: message.snippet,
    internalDate: message.internalDate,
    subject: headerMap.subject,
    from: headerMap.from,
    to: headerMap.to,
    date: headerMap.date,
  };
}

async function safeJson(response: Response): Promise<JsonRecord> {
  try {
    const value: unknown = await response.json();
    return isJsonRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function googleErrorMessage(body: JsonRecord, status: number): string {
  const error = isJsonRecord(body.error) ? body.error : {};
  const message = stringValue(error.message);
  return message ? `Google API ${status}: ${message}` : `Google API request failed with HTTP ${status}`;
}

function escapeDriveLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validIsoDate(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
