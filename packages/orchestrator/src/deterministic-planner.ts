import { createPlan, type JanusPlan, type PlannedToolStep } from './plan.js';

interface GitHubTarget {
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
}

export interface DeterministicPlannerContext {
  timeZone?: string;
}

export function deterministicPlan(
  command: string,
  context: DeterministicPlannerContext = {},
): JanusPlan | null {
  const github = parseGitHubTarget(command);
  if (github) return githubPlan(command, github);

  const driveQuery = parseDriveQuery(command);
  if (driveQuery !== null) return drivePlan(command, driveQuery);

  const gmailQuery = parseGmailQuery(command);
  if (gmailQuery !== null) return gmailPlan(command, gmailQuery);

  if (mentionsCalendar(command)) return calendarPlan(command, context.timeZone);
  return null;
}

function githubPlan(command: string, target: GitHubTarget): JanusPlan {
  const steps: PlannedToolStep[] = [
    {
      id: 'github-repository',
      kind: 'tool',
      label: `Revisar GitHub ${target.owner}/${target.repo}`,
      tool: 'github',
      action: 'repo.get',
      input: { owner: target.owner, repo: target.repo },
      risk: 'none',
      reversible: true,
      requiresApproval: false,
      resultMode: 'summary',
    },
  ];

  const input: Record<string, unknown> = {
    owner: target.owner,
    repo: target.repo,
  };
  if (target.path) input.path = target.path;
  if (target.ref) input.ref = target.ref;

  steps.push({
    id: 'github-content',
    kind: 'tool',
    label: target.path ? `Leer ${target.path}` : 'Listar contenido principal',
    tool: 'github',
    action: target.path ? 'file.read' : 'contents.list',
    input,
    risk: 'none',
    reversible: true,
    requiresApproval: false,
    resultMode: 'summary',
  });

  return createPlan(command, steps, 'deterministic');
}

function drivePlan(command: string, query: string): JanusPlan {
  return createPlan(
    command,
    [
      {
        id: 'google-drive-search',
        kind: 'tool',
        label: query ? `Buscar en Drive: ${query}` : 'Listar archivos recientes de Drive',
        tool: 'google-workspace',
        action: 'drive.files.search',
        input: query ? { query, pageSize: 20 } : { pageSize: 20 },
        risk: 'none',
        reversible: true,
        requiresApproval: false,
        resultMode: 'summary',
      },
    ],
    'deterministic',
  );
}

function gmailPlan(command: string, query: string): JanusPlan {
  return createPlan(
    command,
    [
      {
        id: 'google-gmail-search',
        kind: 'tool',
        label: query ? `Buscar en Gmail: ${query}` : 'Revisar mensajes recientes de Gmail',
        tool: 'google-workspace',
        action: 'gmail.messages.search',
        input: query ? { query, maxResults: 10 } : { maxResults: 10 },
        risk: 'none',
        reversible: true,
        requiresApproval: false,
        resultMode: 'summary',
      },
    ],
    'deterministic',
  );
}

function calendarPlan(command: string, timeZone?: string): JanusPlan {
  const input: Record<string, unknown> = {
    calendarId: 'primary',
    maxResults: 25,
  };
  if (timeZone) input.timeZone = timeZone;

  return createPlan(
    command,
    [
      {
        id: 'google-calendar-upcoming',
        kind: 'tool',
        label: 'Revisar próximos eventos del calendario',
        tool: 'google-workspace',
        action: 'calendar.events.list',
        input,
        risk: 'none',
        reversible: true,
        requiresApproval: false,
        resultMode: 'summary',
      },
    ],
    'deterministic',
  );
}

function parseGitHubTarget(command: string): GitHubTarget | null {
  const urlMatch = command.match(
    /https?:\/\/(?:www\.)?github\.com\/(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)(?:\/blob\/(?<ref>[^/\s]+)\/(?<path>[^\s?#]+))?/i,
  );
  if (urlMatch?.groups?.owner && urlMatch.groups.repo) {
    return {
      owner: urlMatch.groups.owner,
      repo: urlMatch.groups.repo.replace(/\.git$/i, ''),
      ref: urlMatch.groups.ref,
      path: urlMatch.groups.path,
    };
  }

  const shortMatch = command.match(
    /\bgithub\s+(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)(?:\s+(?<path>\S+))?/i,
  );
  if (shortMatch?.groups?.owner && shortMatch.groups.repo) {
    return {
      owner: shortMatch.groups.owner,
      repo: shortMatch.groups.repo.replace(/\.git$/i, ''),
      path: shortMatch.groups.path,
    };
  }

  return null;
}

function parseDriveQuery(command: string): string | null {
  const normalized = command.trim();
  const search = normalized.match(
    /\b(?:busca|buscar|encuentra|encontrar|revisa|revisar)\s+(?:en\s+)?(?:google\s+)?drive(?:\s+(?<query>.+))?$/i,
  );
  if (search) return cleanNaturalQuery(search.groups?.query ?? '');

  const direct = normalized.match(/^(?:google\s+)?drive(?:\s+(?<query>.+))?$/i);
  if (direct) return cleanNaturalQuery(direct.groups?.query ?? '');
  return null;
}

function parseGmailQuery(command: string): string | null {
  const normalized = command.trim();
  const search = normalized.match(
    /\b(?:busca|buscar|revisa|revisar|mira|mirar)\s+(?:en\s+)?(?:gmail|correo|correos|email|emails)(?:\s+(?<query>.+))?$/i,
  );
  if (search) return cleanNaturalQuery(search.groups?.query ?? '');

  const direct = normalized.match(/^(?:gmail|correo|correos|email|emails)(?:\s+(?<query>.+))?$/i);
  if (direct) return cleanNaturalQuery(direct.groups?.query ?? '');
  return null;
}

function mentionsCalendar(command: string): boolean {
  return /\b(calendario|calendar|agenda)\b/i.test(command);
}

function cleanNaturalQuery(value: string): string {
  return value
    .trim()
    .replace(/^(?:de|del|sobre|acerca\s+de)\s+/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}
