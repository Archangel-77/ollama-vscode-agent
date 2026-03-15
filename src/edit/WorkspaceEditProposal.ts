import * as vscode from 'vscode';
import { ChatMessage } from '../ollama/OllamaClient';
import {
  createPendingNewFile,
  createPendingEdit,
  EditOperation,
  EditTarget,
  FailureFixStyle,
  PendingEdit,
  validateEditProposal
} from './EditProposal';

const MAX_TARGET_FILES = 4;
const INTERNAL_MARKERS = [
  '<available-files>',
  '</available-files>',
  '<file>',
  '</file>',
  '<numbered-file>',
  '</numbered-file>',
  '<selection>',
  '</selection>',
  '<previous-response>',
  '</previous-response>'
];
const CREATE_FILE_PATTERN =
  /\b(create|add|new)\b[\s\S]{0,80}\b(file|module|script|component)\b|\b(create|add|new)\b[\s\S]{0,40}\b[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+\b/i;

export interface ParsedWorkspaceEditProposal {
  summary: string;
  files: Array<{
    path: string;
    summary: string;
    create: boolean;
    content?: string;
    operations: EditOperation[];
  }>;
}

export interface PendingEditSet {
  id: string;
  summary: string;
  files: PendingEdit[];
}

export function buildWorkspaceEditProposalMessages(
  targets: EditTarget[],
  prompt: string,
  contextBlocks: Array<string | undefined> = []
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are editing a bounded set of existing files inside VS Code.',
        'Follow the user instruction literally and do not substitute a different kind of change.',
        'Return JSON only. Do not use markdown fences or extra commentary.',
        'Schema: {"summary":"one short sentence","files":[{"path":"src/example.ts","summary":"one short sentence","operations":[{"startLine":4,"endLine":4,"replacement":"# comment\\ndef foo(x):\\n    return x"}]},{"path":"main.py","summary":"create the entry point","create":true,"content":"import os\\nfrom pathlib import Path\\n\\n\\ndef main():\\n    pass\\n"}]}',
        'Paths must exactly match the provided file paths.',
        'Line numbers are 1-based and refer to the numbered file for that specific path.',
        'Each operation replaces the inclusive line range startLine..endLine with replacement.',
        'To insert content above a line, replace that line with your inserted lines followed by the original line.',
        'Only include files that actually change.',
        'If the instruction explicitly asks to create a new file, use create:true and content for that file and do not include operations for it.',
        'For new files, paths must be relative to the workspace root.',
        'Do not rename files.',
        'Use as few operations as possible and preserve untouched lines exactly.',
        'Do not rewrite a whole file unless the instruction explicitly requires it.',
        'Do not add imports, type annotations, refactors, or behavioral changes unless the instruction explicitly asks for them.',
        'If the instruction asks for comments, docstrings, or documentation, add comments/docstrings rather than type annotations.',
        'If no file needs changes, return files: [].'
      ].join(' ')
    }
  ];

  for (const contextBlock of contextBlocks) {
    if (!contextBlock) {
      continue;
    }

    messages.push({
      role: 'system',
      content: contextBlock
    });
  }

  messages.push({
    role: 'user',
    content: buildWorkspaceEditUserPrompt(targets, prompt)
  });

  return messages;
}

export function buildWorkspaceEditRepairMessages(
  targets: EditTarget[],
  prompt: string,
  rawResponse: string,
  repairReason?: string,
  contextBlocks: Array<string | undefined> = []
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Rewrite the previous response into valid JSON only.',
        'Do not use markdown fences or commentary.',
        'Schema: {"summary":"one short sentence","files":[{"path":"src/example.ts","summary":"one short sentence","operations":[{"startLine":4,"endLine":4,"replacement":"# comment\\ndef foo(x):\\n    return x"}]},{"path":"main.py","summary":"create the entry point","create":true,"content":"import os\\nfrom pathlib import Path\\n\\n\\ndef main():\\n    pass\\n"}]}',
        'Paths must exactly match the provided file paths.',
        'Use targeted patch operations instead of whole-file rewrites unless the instruction explicitly asks for a full rewrite.',
        'Follow the original instruction literally and do not substitute a different change type.',
        'If comments or docstrings were requested, do not replace them with type annotations.',
        'If the instruction explicitly asks to create a new file, use create:true and content for that file.'
      ].join(' ')
    }
  ];

  for (const contextBlock of contextBlocks) {
    if (!contextBlock) {
      continue;
    }

    messages.push({
      role: 'system',
      content: contextBlock
    });
  }

  messages.push({
    role: 'user',
    content: [
      buildWorkspaceEditUserPrompt(targets, prompt),
      repairReason ? `Why the previous response was rejected:\n${repairReason}` : undefined,
      ['<previous-response>', rawResponse, '</previous-response>'].join('\n')
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n')
  });

  return messages;
}

export function parseWorkspaceEditProposalResponse(
  rawText: string
): ParsedWorkspaceEditProposal {
  const normalized = unwrapCodeFence(rawText.trim());
  const candidates = collectJsonCandidates(normalized);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const proposal = parseProposalObject(parsed);
      if (proposal) {
        return proposal;
      }
    } catch {
      continue;
    }
  }

  const tagged = parseTaggedProposal(normalized);
  if (tagged) {
    return tagged;
  }

  throw new Error('The model did not return a valid JSON workspace edit proposal.');
}

export function createPendingEditSet(
  targets: EditTarget[],
  proposal: ParsedWorkspaceEditProposal,
  prompt: string,
  workspaceRoot?: string,
  failureFixStyle: FailureFixStyle = 'minimal'
): PendingEditSet | undefined {
  if (proposal.files.length > MAX_TARGET_FILES) {
    throw new Error(`The proposal referenced too many files (${proposal.files.length}).`);
  }

  const targetMap = new Map(targets.map((target) => [normalizePath(target.relativePath), target]));
  const seenPaths = new Set<string>();
  const files: PendingEdit[] = [];

  for (const fileProposal of proposal.files) {
    const normalizedPath = normalizePath(fileProposal.path);
    if (seenPaths.has(normalizedPath)) {
      throw new Error(`The proposal referenced ${fileProposal.path} more than once.`);
    }

    const target = targetMap.get(normalizedPath);
    if (target) {
      if (
        fileProposal.operations.some((operation) =>
          INTERNAL_MARKERS.some(
            (marker) =>
              operation.replacement.includes(marker) || operation.replacement.trim() === marker
          )
        )
      ) {
        throw new Error(`The proposal for ${fileProposal.path} still contains internal markers.`);
      }

      const singleFileProposal = {
        summary: fileProposal.summary || proposal.summary,
        operations: fileProposal.operations
      };
      const validationError = validateEditProposal(
        target,
        singleFileProposal,
        prompt,
        failureFixStyle
      );
      if (validationError) {
        throw new Error(`${fileProposal.path}: ${validationError}`);
      }

      const pendingEdit = createPendingEdit(target, singleFileProposal);
      if (pendingEdit) {
        files.push(pendingEdit);
      }
    } else {
      if (!fileProposal.create || typeof fileProposal.content !== 'string') {
        throw new Error(`The proposal referenced an unknown file: ${fileProposal.path}.`);
      }

      if (!CREATE_FILE_PATTERN.test(prompt)) {
        throw new Error(
          `The proposal tried to create ${fileProposal.path}, but the instruction did not explicitly ask for a new file.`
        );
      }

      if (!workspaceRoot) {
        throw new Error(
          `The proposal tried to create ${fileProposal.path}, but no workspace root is available for new files.`
        );
      }

      const createValidationError = validateNewFileProposal(fileProposal.path, fileProposal.content);
      if (createValidationError) {
        throw new Error(`${fileProposal.path}: ${createValidationError}`);
      }

      files.push(
        createPendingNewFile(
          resolveWorkspaceFileUri(workspaceRoot, fileProposal.path),
          fileProposal.path,
          inferLanguageId(fileProposal.path),
          fileProposal.content,
          fileProposal.summary || proposal.summary
        )
      );
    }

    seenPaths.add(normalizedPath);
  }

  if (files.length === 0) {
    return undefined;
  }

  return {
    id: `${Date.now()}`,
    summary: proposal.summary,
    files
  };
}

function buildWorkspaceEditUserPrompt(targets: EditTarget[], prompt: string): string {
  return [
    `Instruction:\n${prompt}`,
    `Workspace root: ${workspaceRootLabel(targets)}`,
    `<available-files count="${targets.length}">`,
    ...targets.map(renderTargetBlock),
    '</available-files>'
  ].join('\n\n');
}

function renderTargetBlock(target: EditTarget): string {
  const lines = [
    `<file path="${target.relativePath}" language="${target.language}">`
  ];

  if (target.selection) {
    lines.push(
      [
        `<selection startLine="${target.selection.startLine}" endLine="${target.selection.endLine}">`,
        target.selection.text,
        '</selection>'
      ].join('\n')
    );
  }

  lines.push(['<numbered-file>', renderNumberedFile(target.originalText), '</numbered-file>'].join('\n'));
  lines.push('</file>');
  return lines.join('\n');
}

function renderNumberedFile(text: string): string {
  return splitFileLines(text)
    .map((line, index) => `${index + 1}| ${line}`)
    .join('\n');
}

function unwrapCodeFence(text: string): string {
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : text;
}

function collectJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  if (text.startsWith('{') && text.endsWith('}')) {
    candidates.push(text);
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  return [...new Set(candidates)];
}

function parseProposalObject(parsed: unknown): ParsedWorkspaceEditProposal | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const proposal = parsed as {
    summary?: unknown;
    files?: unknown;
    edits?: unknown;
    changes?: unknown;
  };

  const fileEntries =
    parseFileEntries(proposal.files) ??
    parseFileEntries(proposal.edits) ??
    parseFileEntries(proposal.changes);
  if (!fileEntries) {
    return undefined;
  }

  return {
    summary:
      typeof proposal.summary === 'string' && proposal.summary.trim()
        ? proposal.summary.trim()
        : 'Prepared a proposed edit set.',
    files: fileEntries
  };
}

function parseTaggedProposal(text: string): ParsedWorkspaceEditProposal | undefined {
  const summaryMatch = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  const filesMatch = text.match(/<files>\s*([\s\S]*?)\s*<\/files>/i);
  if (!filesMatch) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(filesMatch[1]) as unknown;
    const files = parseFileEntries(parsed);
    if (!files) {
      return undefined;
    }

    return {
      summary: summaryMatch?.[1]?.trim() || 'Prepared a proposed edit set.',
      files
    };
  } catch {
    return undefined;
  }
}

function parseFileEntries(
  value: unknown
): Array<{
  path: string;
  summary: string;
  create: boolean;
  content?: string;
  operations: EditOperation[];
}> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const files: Array<{
    path: string;
    summary: string;
    create: boolean;
    content?: string;
    operations: EditOperation[];
  }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return undefined;
    }

    const entry = item as {
      path?: unknown;
      file?: unknown;
      relativePath?: unknown;
      summary?: unknown;
      create?: unknown;
      content?: unknown;
      newFileText?: unknown;
      text?: unknown;
      operations?: unknown;
      edits?: unknown;
      changes?: unknown;
    };

    const path = firstString([entry.path, entry.file, entry.relativePath]);
    const operations =
      parseOperationsArray(entry.operations) ??
      parseOperationsArray(entry.edits) ??
      parseOperationsArray(entry.changes);
    const create = entry.create === true;
    const content = firstString([entry.content, entry.newFileText, entry.text]);

    if (
      typeof path !== 'string' ||
      (!operations && !(create && typeof content === 'string'))
    ) {
      return undefined;
    }

    files.push({
      path: path.trim(),
      summary:
        typeof entry.summary === 'string' && entry.summary.trim()
          ? entry.summary.trim()
          : 'Prepared a proposed edit.',
      create,
      content,
      operations: operations ?? []
    });
  }

  return files;
}

function parseOperationsArray(value: unknown): EditOperation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const operations: EditOperation[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return undefined;
    }

    const operation = item as {
      startLine?: unknown;
      endLine?: unknown;
      start?: unknown;
      end?: unknown;
      start_line?: unknown;
      end_line?: unknown;
      replacement?: unknown;
      newText?: unknown;
      text?: unknown;
      content?: unknown;
    };

    const startLine = parsePositiveInteger(
      operation.startLine ?? operation.start ?? operation.start_line
    );
    const endLine = parsePositiveInteger(
      operation.endLine ?? operation.end ?? operation.end_line ?? operation.startLine
    );
    const replacement = firstString([
      operation.replacement,
      operation.newText,
      operation.text,
      operation.content
    ]);

    if (!startLine || !endLine || typeof replacement !== 'string') {
      return undefined;
    }

    operations.push({
      startLine,
      endLine,
      replacement
    });
  }

  return operations;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function splitFileLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if ((text.endsWith('\n') || text.endsWith('\r\n')) && lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function workspaceRootLabel(targets: EditTarget[]): string {
  if (targets.length === 0) {
    return 'current workspace';
  }

  const firstPath = targets[0].relativePath.split(/[\\/]/)[0];
  return firstPath || 'current workspace';
}

function validateNewFileProposal(path: string, content: string): string | undefined {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return 'The new file path is empty.';
  }

  if (
    normalizedPath.startsWith('/') ||
    normalizedPath.startsWith('\\') ||
    /^[A-Za-z]:/.test(normalizedPath)
  ) {
    return 'New file paths must be relative to the workspace root.';
  }

  if (normalizedPath.split(/[\\/]/).includes('..')) {
    return 'New file paths cannot escape the workspace root.';
  }

  if (!content.trim()) {
    return 'The new file content is empty.';
  }

  if (INTERNAL_MARKERS.some((marker) => content.includes(marker))) {
    return 'The new file content still contains internal prompt markers.';
  }

  return undefined;
}

function resolveWorkspaceFileUri(workspaceRoot: string, relativePath: string): vscode.Uri {
  const baseUri = vscode.Uri.file(workspaceRoot);
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return vscode.Uri.joinPath(baseUri, ...segments);
}

function inferLanguageId(path: string): string {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.py')) {
    return 'python';
  }

  if (lowerPath.endsWith('.ts')) {
    return 'typescript';
  }

  if (lowerPath.endsWith('.tsx')) {
    return 'typescriptreact';
  }

  if (lowerPath.endsWith('.js')) {
    return 'javascript';
  }

  if (lowerPath.endsWith('.jsx')) {
    return 'javascriptreact';
  }

  if (lowerPath.endsWith('.json')) {
    return 'json';
  }

  if (lowerPath.endsWith('.md')) {
    return 'markdown';
  }

  if (lowerPath.endsWith('.html')) {
    return 'html';
  }

  if (lowerPath.endsWith('.css')) {
    return 'css';
  }

  return 'plaintext';
}
