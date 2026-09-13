import type {
  ToolAdapter,
  ToolProgress,
  ToolRequest,
  ToolResult,
} from '../../gateways/src/contracts.js';

export interface GitHubAdapterOptions {
  token?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

type JsonRecord = Record<string, unknown>;

export class GitHubAdapter implements ToolAdapter {
  readonly name = 'github';
  readonly capabilities: string[] = ['repo.get', 'contents.list', 'file.read'];

  private readonly token?: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GitHubAdapterOptions = {}) {
    this.token = options.token;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'janus-core/0.1';
  }

  async execute(
    request: ToolRequest,
    onProgress: (progress: ToolProgress) => void | Promise<void>,
  ): Promise<ToolResult> {
    if (!this.capabilities.includes(request.action)) {
      return { ok: false, error: `Unsupported GitHub action: ${request.action}` };
    }

    const owner = requiredString(request.input, 'owner');
    const repo = requiredString(request.input, 'repo');
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repo);

    await onProgress({
      phase: 'progress',
      message: `GitHub: ${owner}/${repo}`,
      percent: 15,
    });

    if (request.action === 'repo.get') {
      const response = await this.getJson(`/repos/${encodedOwner}/${encodedRepo}`);
      if (!response.ok) return response;
      const body = response.output?.body as JsonRecord;
      return {
        ok: true,
        output: {
          owner,
          repo,
          fullName: body.full_name,
          private: body.private,
          defaultBranch: body.default_branch,
          description: body.description,
          updatedAt: body.updated_at,
          url: body.html_url,
        },
        externalReference: typeof body.html_url === 'string' ? body.html_url : undefined,
      };
    }

    if (request.action === 'contents.list') {
      const path = optionalString(request.input, 'path') ?? '';
      const ref = optionalString(request.input, 'ref');
      const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const response = await this.getJson(
        `/repos/${encodedOwner}/${encodedRepo}/contents/${encodePath(path)}${suffix}`,
      );
      if (!response.ok) return response;
      const body = response.output?.body;
      if (!Array.isArray(body)) {
        return { ok: false, error: 'GitHub contents response was not a directory listing' };
      }
      return {
        ok: true,
        output: {
          owner,
          repo,
          path,
          entries: body.map((entry) => {
            const item = entry as JsonRecord;
            return {
              name: item.name,
              path: item.path,
              type: item.type,
              size: item.size,
              sha: item.sha,
            };
          }),
        },
      };
    }

    const path = requiredString(request.input, 'path');
    const ref = optionalString(request.input, 'ref');
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const response = await this.getJson(
      `/repos/${encodedOwner}/${encodedRepo}/contents/${encodePath(path)}${suffix}`,
    );
    if (!response.ok) return response;
    const body = response.output?.body as JsonRecord;
    if (body.type !== 'file' || typeof body.content !== 'string') {
      return { ok: false, error: `GitHub path is not a readable file: ${path}` };
    }

    const encoding = typeof body.encoding === 'string' ? body.encoding : 'base64';
    if (encoding !== 'base64') {
      return { ok: false, error: `Unsupported GitHub file encoding: ${encoding}` };
    }

    const content = Buffer.from(body.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return {
      ok: true,
      output: {
        owner,
        repo,
        path,
        sha: body.sha,
        size: body.size,
        content,
      },
      externalReference: typeof body.html_url === 'string' ? body.html_url : undefined,
    };
  }

  private async getJson(path: string): Promise<ToolResult> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.userAgent,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: 'GET',
        headers,
      });
    } catch (error) {
      return {
        ok: false,
        error: `GitHub network error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const message = isRecord(body) && typeof body.message === 'string'
        ? body.message
        : `HTTP ${response.status}`;
      return { ok: false, error: `GitHub ${response.status}: ${message}` };
    }

    return { ok: true, output: { body } };
  }
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`GitHub input '${key}' is required`);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
