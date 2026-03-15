import * as vscode from 'vscode';

const DEFAULT_EXCLUDE_GLOB =
  '**/{node_modules,.git,out,dist,build,.next,coverage,target,bin,obj,venv,.venv,__pycache__,.pytest_cache,.mypy_cache,.ruff_cache,.tox}/**';
const MAX_QUERY_TERMS = 5;
const MAX_CANDIDATE_FILES = 250;
const MAX_CONTEXT_FILES = 4;
const MAX_EXCERPT_CHARS = 1600;
const MAX_LIST_DISPLAY = 50;
const MAX_LIST_CANDIDATES = 300;
const MAX_EDIT_TARGET_FILES = 3;
const MAX_EDIT_TARGET_CHARS = 40000;

const STOP_WORDS = new Set([
  'about',
  'after',
  'agent',
  'also',
  'because',
  'build',
  'class',
  'code',
  'context',
  'create',
  'debug',
  'does',
  'edit',
  'error',
  'file',
  'files',
  'from',
  'function',
  'help',
  'local',
  'list',
  'make',
  'model',
  'more',
  'need',
  'name',
  'names',
  'open',
  'path',
  'paths',
  'please',
  'prompt',
  'question',
  'show',
  'should',
  'tell',
  'them',
  'this',
  'those',
  'these',
  'using',
  'what',
  'when',
  'where',
  'which',
  'with',
  'work',
  'workspace'
]);

export interface WorkspaceContextState {
  includeWorkspace: boolean;
}

export interface WorkspaceContextSummary {
  workspace: {
    enabled: boolean;
    available: boolean;
    label: string;
    detail: string;
  };
}

export interface CapturedWorkspaceContext {
  promptBlock?: string;
  notices: string[];
}

export interface WorkspaceFileListMatch {
  requested: string;
  glob: string;
  paths: string[];
  truncated: boolean;
}

export interface WorkspaceEditCandidate {
  uri: vscode.Uri;
  path: string;
  text: string;
  matchedQueries: string[];
}

interface FileHit {
  uri: vscode.Uri;
  path: string;
  score: number;
  matchedQueries: Set<string>;
}

export function getWorkspaceContextSummary(
  state: WorkspaceContextState
): WorkspaceContextSummary {
  const folders = vscode.workspace.workspaceFolders ?? [];

  return {
    workspace: {
      enabled: state.includeWorkspace,
      available: folders.length > 0,
      label: 'Workspace',
      detail:
        folders.length === 0
          ? 'No workspace folder open'
          : folders.length === 1
            ? folders[0].name
            : `${folders.length} workspace folders`
    }
  };
}

export async function captureWorkspaceContext(
  prompt: string,
  state: WorkspaceContextState
): Promise<CapturedWorkspaceContext> {
  if (!state.includeWorkspace) {
    return { notices: [] };
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return {
      notices: ['Workspace context was requested, but no workspace folder is open.']
    };
  }

  const queries = extractQueries(prompt);
  const requestedFileLists = await collectRequestedFileLists(prompt);
  const sections: string[] = [];
  const notices: string[] = [];

  if (requestedFileLists.length > 0) {
    for (const match of requestedFileLists) {
      sections.push(
        [
          `<workspace-file-list requested="${match.requested}" glob="${match.glob}" count="${match.paths.length}" truncated="${String(
            match.truncated
          )}">`,
          match.paths.join('\n'),
          '</workspace-file-list>'
        ].join('\n')
      );
    }

    notices.push(
      `Included exact workspace file matches for: ${requestedFileLists
        .map((match) => match.requested)
        .join(', ')}.`
    );
  }

  if (queries.length === 0) {
    return sections.length > 0
      ? {
          promptBlock: [
            'Workspace context for this turn only.',
            ...sections
          ].join('\n\n'),
          notices
        }
      : {
          notices: ['Workspace context is enabled, but the prompt did not contain useful search terms.']
        };
  }

  const fileHits = new Map<string, FileHit>();
  const candidateFiles = await vscode.workspace.findFiles(
    '**/*',
    DEFAULT_EXCLUDE_GLOB,
    MAX_CANDIDATE_FILES
  );

  for (const uri of candidateFiles) {
    const path = vscode.workspace.asRelativePath(uri, false);
    if (!isLikelyTextFile(path)) {
      continue;
    }

    const text = await readTextFile(uri);
    if (!text) {
      continue;
    }

    const lowerText = text.toLowerCase();
    const lowerPath = path.toLowerCase();
    const matchedQueries = queries.filter((query) => {
      const lowerQuery = query.toLowerCase();
      return lowerText.includes(lowerQuery) || lowerPath.includes(lowerQuery);
    });

    if (matchedQueries.length === 0) {
      continue;
    }

    fileHits.set(uri.toString(), {
      uri,
      path,
      score: scoreFile(path, text, matchedQueries),
      matchedQueries: new Set<string>(matchedQueries)
    });
  }

  const topHits = [...fileHits.values()]
    .sort((left, right) => {
      if (right.matchedQueries.size !== left.matchedQueries.size) {
        return right.matchedQueries.size - left.matchedQueries.size;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.path.localeCompare(right.path);
    })
    .slice(0, MAX_CONTEXT_FILES);

  if (topHits.length === 0) {
    return sections.length > 0
      ? {
          promptBlock: [
            'Workspace context for this turn only.',
            ...sections
          ].join('\n\n'),
          notices
        }
      : {
          notices: [`Workspace search found no matches for: ${queries.join(', ')}.`]
        };
  }

  for (const hit of topHits) {
    const excerpt = await buildFileExcerpt(hit);
    sections.push(
      [
        `<workspace-file path="${hit.path}" matchedQueries="${[...hit.matchedQueries].join(', ')}" truncated="${String(
          excerpt.truncated
        )}" startLine="${excerpt.startLine}" endLine="${excerpt.endLine}">`,
        excerpt.text,
        '</workspace-file>'
      ].join('\n')
    );
  }

  return {
    promptBlock: [
      'Workspace context for this turn only.',
      `Search queries used: ${queries.join(', ')}.`,
      ...sections
    ].join('\n\n'),
    notices: [
      ...notices,
      `Included workspace context from ${topHits.length} file${topHits.length === 1 ? '' : 's'} using: ${queries.join(', ')}.`
    ]
  };
}

export async function collectRequestedFileLists(
  text: string
): Promise<WorkspaceFileListMatch[]> {
  const results = await collectFilePatternMatches(text);

  if (results.length === 0 && isGenericFileListRequest(text)) {
    const uris = await vscode.workspace.findFiles(
      '**/*',
      DEFAULT_EXCLUDE_GLOB,
      MAX_LIST_CANDIDATES + 1
    );
    const filteredPaths = uris
      .map((uri) => vscode.workspace.asRelativePath(uri, false))
      .filter((path) => !shouldHideFromGenericFileList(path))
      .sort((left, right) => left.localeCompare(right));

    if (filteredPaths.length > 0) {
      results.push({
        requested: 'workspace files',
        glob: '**/*',
        paths: filteredPaths.slice(0, MAX_LIST_DISPLAY),
        truncated: filteredPaths.length > MAX_LIST_DISPLAY
      });
    }
  }

  return dedupeRequestedLists(results);
}

export async function collectWorkspaceEditCandidates(
  prompt: string,
  options?: {
    maxFiles?: number;
    excludePaths?: string[];
    maxChars?: number;
  }
): Promise<WorkspaceEditCandidate[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return [];
  }

  const queries = extractQueries(prompt);
  if (queries.length === 0) {
    return [];
  }

  const maxFiles = options?.maxFiles ?? MAX_EDIT_TARGET_FILES;
  const maxChars = options?.maxChars ?? MAX_EDIT_TARGET_CHARS;
  const excludedPaths = new Set((options?.excludePaths ?? []).map(normalizeWorkspacePath));
  const fileHits = new Map<string, FileHit & { text: string }>();
  const candidateFiles = await vscode.workspace.findFiles(
    '**/*',
    DEFAULT_EXCLUDE_GLOB,
    MAX_CANDIDATE_FILES
  );

  for (const uri of candidateFiles) {
    const path = vscode.workspace.asRelativePath(uri, false);
    if (excludedPaths.has(normalizeWorkspacePath(path)) || !isLikelyTextFile(path)) {
      continue;
    }

    const text = await readTextFile(uri);
    if (!text || text.length > maxChars) {
      continue;
    }

    const lowerText = text.toLowerCase();
    const lowerPath = path.toLowerCase();
    const matchedQueries = queries.filter((query) => {
      const lowerQuery = query.toLowerCase();
      return lowerText.includes(lowerQuery) || lowerPath.includes(lowerQuery);
    });

    if (matchedQueries.length === 0) {
      continue;
    }

    fileHits.set(uri.toString(), {
      uri,
      path,
      text,
      score: scoreFile(path, text, matchedQueries),
      matchedQueries: new Set<string>(matchedQueries)
    });
  }

  return [...fileHits.values()]
    .sort((left, right) => {
      if (right.matchedQueries.size !== left.matchedQueries.size) {
        return right.matchedQueries.size - left.matchedQueries.size;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.path.localeCompare(right.path);
    })
    .slice(0, maxFiles)
    .map((hit) => ({
      uri: hit.uri,
      path: hit.path,
      text: hit.text,
      matchedQueries: [...hit.matchedQueries]
    }));
}

export function formatWorkspaceFileListReply(matches: WorkspaceFileListMatch[]): string {
  if (matches.length === 0) {
    return 'I did not find matching files in the current workspace.';
  }

  const sections = matches.map((match) => {
    const header =
      match.requested === 'workspace files'
        ? `Workspace files${match.truncated ? ' (showing first 50)' : ''}:`
        : `Matches for ${match.requested}${match.truncated ? ' (showing first 50)' : ''}:`;

    return [header, ...match.paths.map((path) => `- ${path}`)].join('\n');
  });

  return sections.join('\n\n');
}

export function isDirectFileListRequest(prompt: string): boolean {
  return extractFilePatterns(prompt).length > 0 || isGenericFileListRequest(prompt);
}

export function isReferentialFileListRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase().trim();

  return (
    /\b(name|list|show|enumerate|repeat)\b/.test(normalized) &&
    /\b(them|those|these|the files|the paths)\b/.test(normalized)
  );
}

export function shouldAutoIncludeWorkspaceContext(prompt: string): boolean {
  const normalized = prompt.toLowerCase();

  if (extractFilePatterns(prompt).length > 0) {
    return true;
  }

  if (isGenericFileListRequest(prompt)) {
    return true;
  }

  return /\b(workspace|repo|repository|project folder|project|codebase|folder)\b/.test(
    normalized
  );
}

function extractQueries(prompt: string): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const match of prompt.matchAll(/"([^"\r\n]{3,})"/g)) {
    const value = normalizeQuery(match[1]);
    if (!value || seen.has(value)) {
      continue;
    }

    seen.add(value);
    queries.push(value);
    if (queries.length >= MAX_QUERY_TERMS) {
      return queries;
    }
  }

  const tokens = prompt.match(/[A-Za-z_][A-Za-z0-9_.:-]{2,}/g) ?? [];
  for (const token of tokens) {
    const normalized = normalizeQuery(token);
    if (!normalized || seen.has(normalized) || STOP_WORDS.has(normalized.toLowerCase())) {
      continue;
    }

    seen.add(normalized);
    queries.push(normalized);
    if (queries.length >= MAX_QUERY_TERMS) {
      break;
    }
  }

  return queries;
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

async function collectFilePatternMatches(text: string): Promise<WorkspaceFileListMatch[]> {
  const requests = extractFilePatterns(text);
  const results: WorkspaceFileListMatch[] = [];

  for (const request of requests) {
    const uris = await vscode.workspace.findFiles(
      request.glob,
      DEFAULT_EXCLUDE_GLOB,
      MAX_LIST_CANDIDATES + 1
    );
    if (uris.length === 0) {
      continue;
    }

    const paths = uris
      .map((uri) => vscode.workspace.asRelativePath(uri, false))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_LIST_DISPLAY);

    results.push({
      requested: request.requested,
      glob: request.glob,
      paths,
      truncated: uris.length > MAX_LIST_DISPLAY
    });
  }

  return results;
}

function extractFilePatterns(text: string): Array<{ requested: string; glob: string }> {
  const matches: Array<{ requested: string; glob: string }> = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/(?:^|[\s"'`(])(\*\.[A-Za-z0-9]+)(?=$|[\s"'`),.?!])/g)) {
    const requested = match[1];
    const glob = `**/${requested}`;
    if (!seen.has(glob)) {
      seen.add(glob);
      matches.push({ requested, glob });
    }
  }

  for (const match of text.matchAll(/(?:^|[\s"'`(])(\.[A-Za-z0-9]+)(?=$|[\s"'`),.?!])/g)) {
    const requested = match[1];
    const glob = `**/*${requested}`;
    if (!seen.has(glob)) {
      seen.add(glob);
      matches.push({ requested, glob });
    }
  }

  return matches;
}

function isGenericFileListRequest(text: string): boolean {
  const normalized = text.toLowerCase();

  return (
    /\b(list|show|name|enumerate|which|what)\b/.test(normalized) &&
    /\b(files|file names|filenames|paths)\b/.test(normalized)
  );
}

function dedupeRequestedLists(matches: WorkspaceFileListMatch[]): WorkspaceFileListMatch[] {
  const deduped = new Map<string, WorkspaceFileListMatch>();

  for (const match of matches) {
    const key = `${match.requested}::${match.glob}`;
    if (!deduped.has(key)) {
      deduped.set(key, match);
    }
  }

  return [...deduped.values()];
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

async function readTextFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

function shouldHideFromGenericFileList(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const hiddenSuffixes = ['.db', '.sqlite', '.sqlite3', '.pyc', '.pyo', '.lock', '.log'];

  return hiddenSuffixes.some((suffix) => lowerPath.endsWith(suffix));
}

function isLikelyTextFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const ignoredExtensions = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.svg',
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.mp3',
    '.mp4',
    '.mov',
    '.avi',
    '.webm',
    '.lock'
  ];

  return !ignoredExtensions.some((extension) => lowerPath.endsWith(extension));
}

function scoreFile(path: string, text: string, matchedQueries: string[]): number {
  const lowerPath = path.toLowerCase();
  const lowerText = text.toLowerCase();
  let score = 0;

  for (const query of matchedQueries) {
    const lowerQuery = query.toLowerCase();
    if (lowerPath.includes(lowerQuery)) {
      score += 5;
    }

    const firstIndex = lowerText.indexOf(lowerQuery);
    if (firstIndex >= 0) {
      score += 10;
      score += Math.max(0, 3 - Math.floor(firstIndex / 1200));
    }
  }

  return score;
}

async function buildFileExcerpt(
  hit: FileHit
): Promise<{ text: string; truncated: boolean; startLine: number; endLine: number }> {
  try {
    const text = await readTextFile(hit.uri);
    if (!text) {
      throw new Error('Unable to decode file content.');
    }

    return excerptAroundQueries(text, [...hit.matchedQueries]);
  } catch {
    return {
      text: `${hit.path}\n[excerpt unavailable]`,
      truncated: true,
      startLine: 1,
      endLine: 1
    };
  }
}

function excerptAroundQueries(
  text: string,
  queries: string[]
): { text: string; truncated: boolean; startLine: number; endLine: number } {
  const lowerText = text.toLowerCase();
  let index = -1;

  for (const query of queries) {
    const nextIndex = lowerText.indexOf(query.toLowerCase());
    if (nextIndex >= 0 && (index === -1 || nextIndex < index)) {
      index = nextIndex;
    }
  }

  if (index === -1) {
    const excerptText = text.slice(0, MAX_EXCERPT_CHARS);
    return {
      text: appendTruncatedMarker(excerptText, excerptText.length < text.length),
      truncated: excerptText.length < text.length,
      startLine: 1,
      endLine: lineNumberAt(excerptText, excerptText.length)
    };
  }

  const start = Math.max(0, index - Math.floor(MAX_EXCERPT_CHARS / 3));
  const end = Math.min(text.length, start + MAX_EXCERPT_CHARS);
  const excerptText = text.slice(start, end);
  const truncated = start > 0 || end < text.length;

  return {
    text: appendTruncatedMarker(excerptText, truncated),
    truncated,
    startLine: lineNumberAt(text, start),
    endLine: lineNumberAt(text, end)
  };
}

function lineNumberAt(text: string, index: number): number {
  let lines = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      lines += 1;
    }
  }

  return lines;
}

function appendTruncatedMarker(text: string, truncated: boolean): string {
  return truncated ? `${text}\n\n[truncated]` : text;
}
