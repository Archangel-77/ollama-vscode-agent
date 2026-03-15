import * as vscode from 'vscode';
import { ChatMessage } from '../ollama/OllamaClient';

const MAX_EDIT_FILE_CHARS = 40000;
const MAX_PATCH_OPERATIONS = 8;

export type FailureFixStyle =
  | 'minimal'
  | 'validateInput'
  | 'preserveTypes'
  | 'noExceptionSwallowing';

export interface EditTarget {
  documentUri: vscode.Uri;
  relativePath: string;
  language: string;
  originalText: string;
  version: number;
  selection?: {
    text: string;
    startLine: number;
    endLine: number;
  };
}

export interface EditOperation {
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface ParsedEditProposal {
  summary: string;
  operations: EditOperation[];
}

export interface PendingEdit {
  id: string;
  isNewFile: boolean;
  documentUri: vscode.Uri;
  relativePath: string;
  language: string;
  summary: string;
  originalText: string;
  proposedText: string;
  originalVersion: number;
  stats: {
    originalLines: number;
    proposedLines: number;
    deltaLines: number;
  };
}

const INTERNAL_MARKERS = [
  '<original-file>',
  '</original-file>',
  '<numbered-file>',
  '</numbered-file>',
  '<updated-file>',
  '</updated-file>',
  '<previous-response>',
  '</previous-response>',
  '<selection>',
  '</selection>'
];

const LARGE_DELETION_PATTERN =
  /\b(delete|remove|drop|strip|trim|reduce|shorten|minify|condense|rewrite from scratch|replace entire|replace whole)\b/i;

const FULL_REWRITE_PATTERN =
  /\b(rewrite|refactor entire|replace whole|replace entire|regenerate|rewrite from scratch|full file)\b/i;

const LITERAL_RETURN_PATTERN =
  /^\s*return\s+(?:-?\d+(?:\.\d+)?|None|null|undefined|true|false|f?(["']).*?\1|`[^`]*`|\[\]|\{\})\s*$/gm;

const PYTHON_EXCEPTION_FALLBACK_PATTERN =
  /^\s*except[^\n]*:\s*(?:\n[ \t]+(?:return\b|pass\b|continue\b|break\b))/gm;

const JS_EXCEPTION_FALLBACK_PATTERN =
  /\bcatch\s*\([^)]*\)\s*\{[\s\S]{0,200}?\b(?:return|break|continue)\b/gm;

const PYTHON_VALIDATION_GUARD_PATTERN =
  /^\s*if\b[^\n]*:\s*(?:\n[ \t]+(?:raise\b|return\b))/gm;

const JS_VALIDATION_GUARD_PATTERN =
  /\bif\s*\([^)]*\)\s*\{[\s\S]{0,160}?\b(?:throw|return)\b/gm;

export function buildFailureFixStyleContextBlock(style: FailureFixStyle): string {
  switch (style) {
    case 'validateInput':
      return [
        'Failure-fix policy: prefer input or precondition validation before the failing operation.',
        'Preserve existing function signatures and return types when possible.',
        'Do not add broad exception handlers or fallback values unless the instruction explicitly asks for graceful degradation.'
      ].join(' ');
    case 'preserveTypes':
      return [
        'Failure-fix policy: preserve existing function signatures and return types while fixing the reported issue.',
        'Do not replace numeric, object, or exception behavior with fallback strings, None/null, booleans, or sentinel values just to silence the failure.',
        'If handling is required, keep the result shape compatible with existing callers.'
      ].join(' ');
    case 'noExceptionSwallowing':
      return [
        'Failure-fix policy: do not swallow exceptions or turn them into silent fallback values.',
        'Prefer validating before the failure or re-raising with clear intent if validation is impossible.',
        'Avoid broad try/except or try/catch wrappers unless the instruction explicitly asks for graceful degradation.'
      ].join(' ');
    case 'minimal':
    default:
      return [
        'Failure-fix policy: prefer the smallest code change that resolves the reported issue.',
        'Preserve behavior, signatures, imports, and control flow unless the failure explicitly requires changing them.',
        'Avoid unnecessary refactors, helpers, or fallback behavior.'
      ].join(' ');
  }
}

export function getActiveEditTarget(): EditTarget {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('Open a file in the editor before proposing an edit.');
  }

  const document = editor.document;
  const originalText = document.getText();
  if (originalText.length > MAX_EDIT_FILE_CHARS) {
    throw new Error(
      `The active file is too large for the first edit workflow (${originalText.length} characters, limit ${MAX_EDIT_FILE_CHARS}).`
    );
  }

  const selection =
    editor.selection.isEmpty
      ? undefined
      : {
          text: document.getText(editor.selection),
          startLine: editor.selection.start.line + 1,
          endLine: editor.selection.end.line + 1
        };

  return {
    documentUri: document.uri,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    language: document.languageId || 'plaintext',
    originalText,
    version: document.version,
    selection
  };
}

export function buildEditProposalMessages(
  target: EditTarget,
  prompt: string,
  contextBlocks: Array<string | undefined> = []
): ChatMessage[] {
  const sections = [
    `Instruction:\n${prompt}`,
    `Target file: ${target.relativePath}`,
    `Language: ${target.language}`
  ];

  if (target.selection) {
    sections.push(
      [
        `Focus selection: lines ${target.selection.startLine}-${target.selection.endLine}`,
        '<selection>',
        target.selection.text,
        '</selection>'
      ].join('\n')
    );
  }

  sections.push(
    ['<numbered-file>', renderNumberedFile(target.originalText), '</numbered-file>'].join('\n')
  );

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are editing exactly one file inside VS Code.',
        'Follow the user instruction literally and do not substitute a different kind of change.',
        'Return JSON only. Do not use markdown fences or extra commentary.',
        'Schema: {"summary":"one short sentence","operations":[{"startLine":4,"endLine":4,"replacement":"# comment\\ndef foo(x):\\n    return x"}]}',
        'Line numbers are 1-based and refer to <numbered-file>.',
        'Each operation replaces the inclusive line range startLine..endLine with replacement.',
        'To insert content above a line, replace that line with your inserted lines followed by the original line.',
        'Use as few operations as possible and preserve all untouched lines exactly.',
        'Do not rewrite the entire file unless the instruction explicitly requires it.',
        'Do not add imports, type annotations, refactors, or behavioral changes unless the instruction explicitly asks for them.',
        'If the instruction asks for comments, docstrings, or documentation, add comments/docstrings rather than type annotations.',
        'If no change is needed, return operations: [].'
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
    content: sections.join('\n\n')
  });

  return messages;
}

export function buildEditRepairMessages(
  target: EditTarget,
  prompt: string,
  rawResponse: string,
  repairReason?: string,
  contextBlocks: Array<string | undefined> = []
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Rewrite the previous edit response into valid JSON only.',
        'Do not use markdown fences or commentary.',
        'Schema: {"summary":"one short sentence","operations":[{"startLine":4,"endLine":4,"replacement":"# comment\\ndef foo(x):\\n    return x"}]}',
        'Line numbers are 1-based and refer to <numbered-file>.',
        'Use targeted patch operations instead of rewriting the whole file unless the instruction explicitly asked for a full rewrite.',
        'Follow the original instruction literally and do not substitute a different change type.',
        'If comments or docstrings were requested, do not replace them with type annotations.'
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
      `Instruction:\n${prompt}`,
      `Target file: ${target.relativePath}`,
      repairReason ? `Why the previous response was rejected:\n${repairReason}` : undefined,
      ['<numbered-file>', renderNumberedFile(target.originalText), '</numbered-file>'].join('\n'),
      ['<previous-response>', rawResponse, '</previous-response>'].join('\n')
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n')
  });

  return messages;
}

export function parseEditProposalResponse(
  rawText: string,
  target: EditTarget
): ParsedEditProposal {
  const normalized = unwrapCodeFence(rawText.trim());
  const candidates = collectJsonCandidates(normalized);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const proposal = parseProposalObject(parsed, target);
      if (proposal) {
        return proposal;
      }
    } catch {
      continue;
    }
  }

  const tagged = parseTaggedProposal(normalized, target);
  if (tagged) {
    return tagged;
  }

  const codeBlock = extractCodeBlockProposal(normalized, target);
  if (codeBlock) {
    return codeBlock;
  }

  throw new Error('The model did not return a valid JSON edit proposal.');
}

export function createPendingEdit(
  target: EditTarget,
  proposal: ParsedEditProposal
): PendingEdit | undefined {
  const proposedText = applyOperations(target.originalText, proposal.operations);
  if (proposedText === target.originalText) {
    return undefined;
  }

  return {
    id: `${Date.now()}`,
    isNewFile: false,
    documentUri: target.documentUri,
    relativePath: target.relativePath,
    language: target.language,
    summary: proposal.summary,
    originalText: target.originalText,
    proposedText,
    originalVersion: target.version,
    stats: computeStats(target.originalText, proposedText)
  };
}

export function createPendingNewFile(
  documentUri: vscode.Uri,
  relativePath: string,
  language: string,
  proposedText: string,
  summary: string
): PendingEdit {
  return {
    id: `${Date.now()}`,
    isNewFile: true,
    documentUri,
    relativePath,
    language,
    summary,
    originalText: '',
    proposedText,
    originalVersion: -1,
    stats: {
      originalLines: 0,
      proposedLines: countLines(proposedText),
      deltaLines: countLines(proposedText)
    }
  };
}

export function validateEditProposal(
  target: EditTarget,
  proposal: ParsedEditProposal,
  prompt: string,
  failureFixStyle: FailureFixStyle = 'minimal'
): string | undefined {
  const operationsError = validateOperations(target.originalText, proposal.operations, prompt);
  if (operationsError) {
    return operationsError;
  }

  const proposedText = applyOperations(target.originalText, proposal.operations);
  const trimmed = proposedText.trim();
  if (!trimmed) {
    return 'The proposed file is empty.';
  }

  if (
    INTERNAL_MARKERS.some((marker) => trimmed === marker || trimmed.startsWith(`${marker}\n`))
  ) {
    return 'The proposed file still contains internal prompt markers instead of real code.';
  }

  const originalLines = countLines(target.originalText);
  const proposedLines = countLines(proposedText);
  if (
    originalLines >= 8 &&
    proposedLines <= Math.max(2, Math.floor(originalLines * 0.35)) &&
    !LARGE_DELETION_PATTERN.test(prompt)
  ) {
    return `The proposed file unexpectedly shrank from ${originalLines} lines to ${proposedLines} lines.`;
  }

  if (
    originalLines >= 8 &&
    countSharedMeaningfulLines(target.originalText, proposedText) < 2 &&
    !LARGE_DELETION_PATTERN.test(prompt)
  ) {
    return 'The proposed file does not preserve enough of the original content to be trusted.';
  }

  if (isCommentStyleRequest(prompt)) {
    const addedComments =
      countCommentArtifacts(proposedText) - countCommentArtifacts(target.originalText);
    const addedTypeHints =
      countTypeHintArtifacts(proposedText) - countTypeHintArtifacts(target.originalText);

    if (addedComments <= 0 && addedTypeHints > 0) {
      return 'The proposal added type annotations instead of comments or docstrings.';
    }

    if (addedComments <= 0) {
      return 'The proposal did not add any comment or docstring content.';
    }
  }

  const failureFixStyleError = validateFailureFixStyle(
    target.originalText,
    proposedText,
    failureFixStyle
  );
  if (failureFixStyleError) {
    return failureFixStyleError;
  }

  return undefined;
}

function renderNumberedFile(text: string): string {
  const lines = splitFileLines(text);
  return lines.map((line, index) => `${index + 1}| ${line}`).join('\n');
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

function parseProposalObject(
  parsed: unknown,
  target: EditTarget
): ParsedEditProposal | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const proposal = parsed as {
    summary?: unknown;
    operations?: unknown;
    edits?: unknown;
    changes?: unknown;
    updatedText?: unknown;
    content?: unknown;
    fileText?: unknown;
  };

  const summary =
    typeof proposal.summary === 'string' && proposal.summary.trim()
      ? proposal.summary.trim()
      : 'Prepared a proposed edit.';

  const operations =
    parseOperationsArray(proposal.operations) ??
    parseOperationsArray(proposal.edits) ??
    parseOperationsArray(proposal.changes);

  if (operations) {
    return {
      summary,
      operations
    };
  }

  const fullText = firstString([
    proposal.updatedText,
    proposal.content,
    proposal.fileText
  ]);
  if (typeof fullText === 'string') {
    return {
      summary,
      operations: [buildFullReplacementOperation(target.originalText, fullText)]
    };
  }

  return undefined;
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

function parseTaggedProposal(text: string, target: EditTarget): ParsedEditProposal | undefined {
  const summaryMatch = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  const operationsMatch = text.match(/<operations>\s*([\s\S]*?)\s*<\/operations>/i);

  if (operationsMatch) {
    try {
      const parsed = JSON.parse(operationsMatch[1]);
      const operations = parseOperationsArray(parsed);
      if (operations) {
        return {
          summary: summaryMatch?.[1]?.trim() || 'Prepared a proposed edit.',
          operations
        };
      }
    } catch {
      return undefined;
    }
  }

  const updatedTextMatch = text.match(/<updated-file>\s*([\s\S]*?)\s*<\/updated-file>/i);
  if (!updatedTextMatch) {
    return undefined;
  }

  return {
    summary: summaryMatch?.[1]?.trim() || 'Prepared a proposed edit.',
    operations: [buildFullReplacementOperation(target.originalText, updatedTextMatch[1])]
  };
}

function extractCodeBlockProposal(
  text: string,
  target: EditTarget
): ParsedEditProposal | undefined {
  const codeBlocks = [...text.matchAll(/```(?:[A-Za-z0-9_-]+)?\s*([\s\S]*?)```/g)];
  if (codeBlocks.length !== 1) {
    return undefined;
  }

  const candidate = codeBlocks[0][1].trim();
  if (!candidate) {
    return undefined;
  }

  const minimumLength = Math.max(120, Math.floor(target.originalText.length * 0.6));
  if (candidate.length < minimumLength) {
    return undefined;
  }

  return {
    summary: inferSummaryFromRawText(text),
    operations: [buildFullReplacementOperation(target.originalText, candidate)]
  };
}

function buildFullReplacementOperation(originalText: string, updatedText: string): EditOperation {
  return {
    startLine: 1,
    endLine: countLines(originalText),
    replacement: updatedText
  };
}

function validateOperations(
  originalText: string,
  operations: EditOperation[],
  prompt: string
): string | undefined {
  if (operations.length === 0) {
    return undefined;
  }

  if (operations.length > MAX_PATCH_OPERATIONS && !FULL_REWRITE_PATTERN.test(prompt)) {
    return `The proposal returned too many patch operations (${operations.length}).`;
  }

  const lineCount = countLines(originalText);
  const sorted = [...operations].sort((left, right) => {
    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }

    return left.endLine - right.endLine;
  });

  let previousEnd = 0;
  for (const operation of sorted) {
    if (operation.startLine < 1 || operation.endLine < operation.startLine) {
      return 'The proposal returned an invalid line range.';
    }

    if (operation.endLine > lineCount) {
      return `The proposal referenced lines outside the file (${operation.startLine}-${operation.endLine}).`;
    }

    if (operation.startLine <= previousEnd) {
      return 'The proposal returned overlapping patch operations.';
    }

    if (
      INTERNAL_MARKERS.some(
        (marker) =>
          operation.replacement.trim() === marker ||
          operation.replacement.includes(`${marker}\n`) ||
          operation.replacement.includes(`\n${marker}`)
      )
    ) {
      return 'The proposal still contains internal prompt markers instead of code.';
    }

    previousEnd = operation.endLine;
  }

  if (
    sorted.length === 1 &&
    sorted[0].startLine === 1 &&
    sorted[0].endLine === lineCount &&
    !FULL_REWRITE_PATTERN.test(prompt)
  ) {
    return 'The proposal rewrote the whole file instead of returning a targeted patch.';
  }

  return undefined;
}

function applyOperations(originalText: string, operations: EditOperation[]): string {
  if (operations.length === 0) {
    return originalText;
  }

  const lineEnding = detectLineEnding(originalText);
  const hadTrailingLineEnding = endsWithLineEnding(originalText);
  const lines = splitFileLines(originalText);
  const sorted = [...operations].sort((left, right) => {
    if (left.startLine !== right.startLine) {
      return right.startLine - left.startLine;
    }

    return right.endLine - left.endLine;
  });

  for (const operation of sorted) {
    const replacementLines = splitReplacementLines(operation.replacement);
    lines.splice(
      operation.startLine - 1,
      operation.endLine - operation.startLine + 1,
      ...replacementLines
    );
  }

  let result = lines.join(lineEnding);
  if (hadTrailingLineEnding && !result.endsWith(lineEnding)) {
    result += lineEnding;
  }

  return result;
}

function splitFileLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (endsWithLineEnding(text) && lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function splitReplacementLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  return normalized.split('\n');
}

function detectLineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function endsWithLineEnding(text: string): boolean {
  return text.endsWith('\n') || text.endsWith('\r\n');
}

function inferSummaryFromRawText(text: string): string {
  const firstNonEmptyLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('```'));

  if (!firstNonEmptyLine) {
    return 'Prepared a proposed edit.';
  }

  return firstNonEmptyLine.length > 120
    ? 'Prepared a proposed edit.'
    : firstNonEmptyLine;
}

function isCommentStyleRequest(prompt: string): boolean {
  return /\b(comment|comments|docstring|docstrings|document|documentation|annotate with comments)\b/i.test(
    prompt
  );
}

function validateFailureFixStyle(
  originalText: string,
  proposedText: string,
  failureFixStyle: FailureFixStyle
): string | undefined {
  if (failureFixStyle === 'minimal') {
    return undefined;
  }

  const newLiteralReturns =
    countPatternMatches(proposedText, LITERAL_RETURN_PATTERN) -
    countPatternMatches(originalText, LITERAL_RETURN_PATTERN);
  const newExceptionFallbackHandlers =
    countPatternMatches(proposedText, PYTHON_EXCEPTION_FALLBACK_PATTERN) +
    countPatternMatches(proposedText, JS_EXCEPTION_FALLBACK_PATTERN) -
    countPatternMatches(originalText, PYTHON_EXCEPTION_FALLBACK_PATTERN) -
    countPatternMatches(originalText, JS_EXCEPTION_FALLBACK_PATTERN);
  const newValidationGuards =
    countPatternMatches(proposedText, PYTHON_VALIDATION_GUARD_PATTERN) +
    countPatternMatches(proposedText, JS_VALIDATION_GUARD_PATTERN) -
    countPatternMatches(originalText, PYTHON_VALIDATION_GUARD_PATTERN) -
    countPatternMatches(originalText, JS_VALIDATION_GUARD_PATTERN);

  if (failureFixStyle === 'preserveTypes' && newLiteralReturns > 0) {
    return 'The proposal appears to change return-value types while fixing the failure. Preserve existing return types instead of returning fallback literals.';
  }

  if (failureFixStyle === 'noExceptionSwallowing' && newExceptionFallbackHandlers > 0) {
    return 'The proposal added a new exception handler that swallows the failure with a fallback path. Fix the cause or re-raise instead.';
  }

  if (
    failureFixStyle === 'validateInput' &&
    newExceptionFallbackHandlers > 0 &&
    newValidationGuards <= 0
  ) {
    return 'The proposal handled the failure after the fact with a new exception fallback. Prefer validating inputs or preconditions before the failing operation.';
  }

  return undefined;
}

function countPatternMatches(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const matches = text.match(matcher);
  return matches?.length ?? 0;
}

function countCommentArtifacts(text: string): number {
  const lineComments = (text.match(/^\s*(#|\/\/|\* )/gm) ?? []).length;
  const blockComments = (text.match(/("""|'''|\/\*)/g) ?? []).length;
  return lineComments + blockComments;
}

function countTypeHintArtifacts(text: string): number {
  const returnHints = (text.match(/->\s*[A-Za-z_][A-Za-z0-9_.\[\], ]*/g) ?? []).length;
  const parameterHints = (
    text.match(/\b[A-Za-z_][A-Za-z0-9_]*\s*:\s*[A-Za-z_][A-Za-z0-9_.\[\], ]*/g) ?? []
  ).length;

  return returnHints + parameterHints;
}

function countSharedMeaningfulLines(originalText: string, proposedText: string): number {
  const originalLines = normalizeMeaningfulLines(originalText);
  const proposedLines = new Set(normalizeMeaningfulLines(proposedText));
  let shared = 0;

  for (const line of originalLines) {
    if (proposedLines.has(line)) {
      shared += 1;
    }
  }

  return shared;
}

function normalizeMeaningfulLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line) => line.length >= 6);
}

function computeStats(originalText: string, proposedText: string): PendingEdit['stats'] {
  const originalLines = countLines(originalText);
  const proposedLines = countLines(proposedText);

  return {
    originalLines,
    proposedLines,
    deltaLines: proposedLines - originalLines
  };
}

function countLines(text: string): number {
  const lines = splitFileLines(text);
  return Math.max(1, lines.length);
}
