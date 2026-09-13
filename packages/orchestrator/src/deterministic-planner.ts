import { createPlan, type JanusPlan, type PlannedToolStep } from './plan.js';

interface GitHubTarget {
  owner: string;
  repo: string;
  path?: string;
  ref?: string;
}

export function deterministicPlan(command: string): JanusPlan | null {
  const github = parseGitHubTarget(command);
  if (github) return githubPlan(command, github);
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
