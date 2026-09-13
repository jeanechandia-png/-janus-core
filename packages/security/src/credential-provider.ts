export interface CredentialRequest {
  service: string;
  scopes?: readonly string[];
}

export interface CredentialLease {
  accessToken: string;
  source: string;
  expiresAt?: string;
}

export interface CredentialStatus {
  configured: boolean;
  source?: string;
  reason?: string;
}

export interface CredentialProvider {
  get(request: CredentialRequest): Promise<CredentialLease | null>;
  status(service: string): Promise<CredentialStatus>;
}

export class CredentialBroker {
  private readonly providers: readonly CredentialProvider[];
  private readonly now: () => Date;

  constructor(providers: readonly CredentialProvider[], now: () => Date = () => new Date()) {
    this.providers = providers;
    this.now = now;
  }

  async lease(request: CredentialRequest): Promise<CredentialLease | null> {
    for (const provider of this.providers) {
      const lease = await provider.get(request);
      if (!lease) continue;
      if (!lease.accessToken.trim()) continue;
      if (lease.expiresAt && isExpired(lease.expiresAt, this.now())) continue;
      return {
        accessToken: lease.accessToken,
        source: lease.source,
        ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
      };
    }
    return null;
  }

  async accessToken(service: string, scopes?: readonly string[]): Promise<string | undefined> {
    const lease = await this.lease({ service, ...(scopes ? { scopes } : {}) });
    return lease?.accessToken;
  }

  async status(service: string): Promise<CredentialStatus> {
    for (const provider of this.providers) {
      const status = await provider.status(service);
      if (status.configured) return status;
    }
    return { configured: false, reason: `No credential provider is configured for ${service}` };
  }
}

export interface EnvironmentCredentialProviderOptions {
  serviceVariables: Readonly<Record<string, string>>;
  environment?: Readonly<Record<string, string | undefined>>;
  sourceName?: string;
}

/**
 * Development bridge only. Production/local-first Janus should replace this
 * with an OS-backed provider (Keychain, Credential Manager, secret service, etc.).
 */
export class EnvironmentCredentialProvider implements CredentialProvider {
  private readonly serviceVariables: Readonly<Record<string, string>>;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly sourceName: string;

  constructor(options: EnvironmentCredentialProviderOptions) {
    this.serviceVariables = options.serviceVariables;
    this.environment = options.environment ?? process.env;
    this.sourceName = options.sourceName ?? 'environment-development-bridge';
  }

  configured(service: string): boolean {
    const variable = this.serviceVariables[service];
    if (!variable) return false;
    return Boolean(this.environment[variable]?.trim());
  }

  async get(request: CredentialRequest): Promise<CredentialLease | null> {
    const variable = this.serviceVariables[request.service];
    if (!variable) return null;
    const accessToken = this.environment[variable]?.trim();
    if (!accessToken) return null;
    return {
      accessToken,
      source: this.sourceName,
    };
  }

  async status(service: string): Promise<CredentialStatus> {
    if (!this.configured(service)) return { configured: false };
    return {
      configured: true,
      source: this.sourceName,
      reason: 'Temporary environment credential configured; migrate to OS secure storage for production.',
    };
  }
}

function isExpired(expiresAt: string, now: Date): boolean {
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return true;
  return timestamp <= now.getTime();
}
