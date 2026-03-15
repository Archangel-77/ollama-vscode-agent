import * as vscode from 'vscode';

const MAX_PROBLEM_ENTRIES = 24;
const MAX_MESSAGE_LENGTH = 220;

export interface ProblemsContextState {
  includeProblems: boolean;
}

export interface ProblemsContextSummary {
  problems: {
    enabled: boolean;
    available: boolean;
    label: string;
    detail: string;
  };
}

export interface CapturedProblemsContext {
  promptBlock?: string;
  notices: string[];
  counts: ProblemCounts;
}

export interface ProblemCounts {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
}

interface ProblemEntry {
  uri: vscode.Uri;
  path: string;
  diagnostic: vscode.Diagnostic;
}

export function getProblemsContextSummary(
  state: ProblemsContextState
): ProblemsContextSummary {
  const counts = collectProblemCounts();

  return {
    problems: {
      enabled: state.includeProblems,
      available: counts.total > 0,
      label: 'Problems',
      detail: counts.total === 0 ? 'No problems' : formatCounts(counts)
    }
  };
}

export function captureProblemsContext(
  prompt: string,
  state: ProblemsContextState
): CapturedProblemsContext {
  if (!state.includeProblems) {
    return {
      notices: [],
      counts: collectProblemCounts()
    };
  }

  const entries = collectProblemEntries(prompt);
  const counts = collectProblemCounts();
  if (entries.length === 0) {
    return {
      notices: ['Problems context was requested, but no workspace diagnostics are available.'],
      counts
    };
  }

  const sections = entries.map((entry) => {
    const severity = formatSeverity(entry.diagnostic.severity);
    const line = entry.diagnostic.range.start.line + 1;
    const column = entry.diagnostic.range.start.character + 1;
    const source = entry.diagnostic.source ? ` source="${escapeXml(entry.diagnostic.source)}"` : '';
    const code = formatDiagnosticCode(entry.diagnostic.code);
    const codeAttr = code ? ` code="${escapeXml(code)}"` : '';
    return [
      `<problem path="${escapeXml(entry.path)}" severity="${severity}" line="${line}" column="${column}"${source}${codeAttr}>`,
      truncateMessage(entry.diagnostic.message),
      '</problem>'
    ].join('\n');
  });

  return {
    promptBlock: [
      'Workspace problems for this turn only.',
      `Summary: ${formatCounts(counts)}.`,
      ...sections
    ].join('\n\n'),
    notices: [
      `Included ${entries.length} workspace problem${entries.length === 1 ? '' : 's'} (${formatCounts(counts)}).`
    ],
    counts
  };
}

export function shouldAutoIncludeProblemsContext(prompt: string): boolean {
  if (isExplicitProblemsPrompt(prompt)) {
    return true;
  }

  return (
    collectProblemCounts().total > 0 &&
    /\b(error|errors|problem|problems)\b/i.test(prompt)
  );
}

export function shouldWarnAboutMissingProblemsContext(prompt: string): boolean {
  return /\b(problem|problems|diagnostic|diagnostics|warning|warnings|lint|typecheck|compiler)\b/i.test(
    prompt
  );
}

function isExplicitProblemsPrompt(prompt: string): boolean {
  return /\b(diagnostic|diagnostics|warning|warnings|lint|typecheck|compiler|problem panel|problems panel|problems tab|workspace problems|workspace diagnostics|pyright|mypy|eslint|flake8|pylint|tsc)\b/i.test(
    prompt
  );
}

export function getWorkspaceProblemsNotice(): string | undefined {
  const counts = collectProblemCounts();
  if (counts.total === 0) {
    return undefined;
  }

  return `Current workspace problems: ${formatCounts(counts)}. Use Fix Problems to ground the next edit proposal.`;
}

function collectProblemCounts(): ProblemCounts {
  const diagnostics = flattenWorkspaceDiagnostics();
  let errors = 0;
  let warnings = 0;
  let infos = 0;

  for (const entry of diagnostics) {
    switch (entry.diagnostic.severity) {
      case vscode.DiagnosticSeverity.Error:
        errors += 1;
        break;
      case vscode.DiagnosticSeverity.Warning:
        warnings += 1;
        break;
      default:
        infos += 1;
        break;
    }
  }

  return {
    total: diagnostics.length,
    errors,
    warnings,
    infos
  };
}

function collectProblemEntries(prompt: string): ProblemEntry[] {
  const entries = flattenWorkspaceDiagnostics();
  if (entries.length === 0) {
    return [];
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const queryTokens = extractPromptTokens(prompt);

  return entries
    .sort((left, right) => scoreEntry(right, activeUri, queryTokens) - scoreEntry(left, activeUri, queryTokens))
    .slice(0, MAX_PROBLEM_ENTRIES);
}

function flattenWorkspaceDiagnostics(): ProblemEntry[] {
  const entries: ProblemEntry[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) {
      continue;
    }

    const path = vscode.workspace.asRelativePath(uri, false);
    for (const diagnostic of diagnostics) {
      entries.push({
        uri,
        path,
        diagnostic
      });
    }
  }

  return entries;
}

function extractPromptTokens(prompt: string): string[] {
  const matches = prompt.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) ?? [];
  return [...new Set(matches)].slice(0, 8);
}

function scoreEntry(
  entry: ProblemEntry,
  activeUri: vscode.Uri | undefined,
  queryTokens: string[]
): number {
  let score = 0;

  if (activeUri && entry.uri.toString() === activeUri.toString()) {
    score += 40;
  }

  switch (entry.diagnostic.severity) {
    case vscode.DiagnosticSeverity.Error:
      score += 30;
      break;
    case vscode.DiagnosticSeverity.Warning:
      score += 20;
      break;
    default:
      score += 10;
      break;
  }

  const haystack = `${entry.path}\n${entry.diagnostic.message}\n${entry.diagnostic.source ?? ''}`.toLowerCase();
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 5;
    }
  }

  return score;
}

function formatCounts(counts: ProblemCounts): string {
  const parts: string[] = [];
  if (counts.errors > 0) {
    parts.push(`${counts.errors} error${counts.errors === 1 ? '' : 's'}`);
  }

  if (counts.warnings > 0) {
    parts.push(`${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`);
  }

  if (counts.infos > 0) {
    parts.push(`${counts.infos} info${counts.infos === 1 ? '' : 's'}`);
  }

  return parts.join(', ') || 'no problems';
}

function formatSeverity(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    default:
      return 'hint';
  }
}

function formatDiagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
  if (!code) {
    return undefined;
  }

  if (typeof code === 'string' || typeof code === 'number') {
    return String(code);
  }

  return typeof code.value === 'string' || typeof code.value === 'number'
    ? String(code.value)
    : undefined;
}

function truncateMessage(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_MESSAGE_LENGTH)}...`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
