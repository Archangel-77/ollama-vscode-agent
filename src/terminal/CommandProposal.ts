import * as vscode from 'vscode';
import { ChatMessage } from '../ollama/OllamaClient';

const MAX_COMMAND_CHARS = 400;
const MAX_SELECTION_CHARS = 1200;

const INTERNAL_MARKERS = [
  '<command>',
  '</command>',
  '<summary>',
  '</summary>',
  '<previous-response>',
  '</previous-response>'
];

const DANGEROUS_COMMAND_PATTERN =
  /\b(rm\s+-rf|remove-item\b.*-recurse.*-force|del\s+\/[sq]|format\s+[a-z]:|shutdown\b|restart-computer\b|stop-computer\b|diskpart\b|mkfs\b|dd\s+if=|git\s+reset\s+--hard\b|git\s+clean\b.*-f|reg\s+delete\b)\b/i;

export interface CommandTarget {
  shell: 'powershell';
  workingDirectory?: vscode.Uri;
  workingDirectoryLabel: string;
  activeFile?: string;
  selectionText?: string;
}

export interface ParsedCommandProposal {
  summary: string;
  command: string;
}

export interface PendingCommand {
  id: string;
  summary: string;
  command: string;
  cwd?: vscode.Uri;
  cwdLabel: string;
}

export function getCommandTarget(): CommandTarget {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  const workspaceFolder = document
    ? vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0]
    : vscode.workspace.workspaceFolders?.[0];

  const selectionText =
    editor && document && !editor.selection.isEmpty
      ? limitText(document.getText(editor.selection), MAX_SELECTION_CHARS)
      : undefined;

  return {
    shell: 'powershell',
    workingDirectory: workspaceFolder?.uri,
    workingDirectoryLabel: workspaceFolder?.name ?? 'Default terminal directory',
    activeFile:
      document && document.uri.scheme === 'file'
        ? vscode.workspace.asRelativePath(document.uri, false)
        : undefined,
    selectionText
  };
}

export function buildCommandProposalMessages(
  target: CommandTarget,
  prompt: string,
  contextBlocks: Array<string | undefined>,
  groundingWarnings: string[]
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are suggesting exactly one Windows PowerShell command for VS Code.',
        'Return JSON only. Do not use markdown fences or commentary.',
        'Schema: {"summary":"one short sentence","command":"pytest tests/test_api.py"}',
        'Prefer project-local commands that run from the provided working directory.',
        'Do not include cd or Set-Location; the terminal working directory is handled separately.',
        'Do not suggest destructive commands, file deletion, machine shutdown, disk tools, or hard git resets.',
        'If the user asks to inspect, test, lint, or run the project, prefer the smallest reasonable workspace-local command.'
      ].join(' ')
    }
  ];

  for (const warning of groundingWarnings) {
    messages.push({
      role: 'system',
      content: warning
    });
  }

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
    content: buildCommandUserPrompt(target, prompt)
  });

  return messages;
}

export function buildCommandRepairMessages(
  target: CommandTarget,
  prompt: string,
  rawResponse: string,
  contextBlocks: Array<string | undefined>,
  groundingWarnings: string[],
  repairReason?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Rewrite the previous response into valid JSON only.',
        'Do not use markdown fences or commentary.',
        'Schema: {"summary":"one short sentence","command":"pytest tests/test_api.py"}',
        'Return exactly one safe PowerShell command.',
        'Do not include cd or Set-Location.',
        'Do not suggest destructive commands.'
      ].join(' ')
    }
  ];

  for (const warning of groundingWarnings) {
    messages.push({
      role: 'system',
      content: warning
    });
  }

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
      buildCommandUserPrompt(target, prompt),
      repairReason ? `Why the previous response was rejected:\n${repairReason}` : undefined,
      ['<previous-response>', rawResponse, '</previous-response>'].join('\n')
    ]
      .filter((section): section is string => Boolean(section))
      .join('\n\n')
  });

  return messages;
}

export function parseCommandProposalResponse(rawText: string): ParsedCommandProposal {
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

  throw new Error('The model did not return a valid terminal command proposal.');
}

export function validateCommandProposal(proposal: ParsedCommandProposal): string | undefined {
  const command = proposal.command.trim();
  if (!command) {
    return 'The proposal did not include a terminal command.';
  }

  if (command.length > MAX_COMMAND_CHARS) {
    return `The proposed command is too long (${command.length} characters).`;
  }

  if (/\r|\n/.test(command)) {
    return 'The proposal returned a multi-line command instead of one terminal command.';
  }

  if (INTERNAL_MARKERS.some((marker) => command.includes(marker))) {
    return 'The proposed command still contains internal prompt markers.';
  }

  if (/^\s*(cd|set-location)\b/i.test(command)) {
    return 'The command should not change directories directly.';
  }

  if (DANGEROUS_COMMAND_PATTERN.test(command)) {
    return 'The proposal suggested a destructive command, which is not allowed.';
  }

  return undefined;
}

export function createPendingCommand(
  target: CommandTarget,
  proposal: ParsedCommandProposal
): PendingCommand {
  return {
    id: `${Date.now()}`,
    summary: proposal.summary,
    command: proposal.command.trim(),
    cwd: target.workingDirectory,
    cwdLabel: target.workingDirectoryLabel
  };
}

function buildCommandUserPrompt(target: CommandTarget, prompt: string): string {
  const sections = [
    `Instruction:\n${prompt}`,
    `Shell: ${target.shell}`,
    `Working directory label: ${target.workingDirectoryLabel}`
  ];

  if (target.activeFile) {
    sections.push(`Active file: ${target.activeFile}`);
  }

  if (target.selectionText) {
    sections.push(['Selection excerpt:', target.selectionText].join('\n'));
  }

  return sections.join('\n\n');
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

function parseProposalObject(parsed: unknown): ParsedCommandProposal | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const proposal = parsed as {
    summary?: unknown;
    command?: unknown;
    cmd?: unknown;
    shellCommand?: unknown;
    script?: unknown;
  };

  const command = firstString([
    proposal.command,
    proposal.cmd,
    proposal.shellCommand,
    proposal.script
  ]);
  if (typeof command !== 'string') {
    return undefined;
  }

  return {
    summary:
      typeof proposal.summary === 'string' && proposal.summary.trim()
        ? proposal.summary.trim()
        : 'Prepared a terminal command suggestion.',
    command
  };
}

function parseTaggedProposal(text: string): ParsedCommandProposal | undefined {
  const summaryMatch = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  const commandMatch = text.match(/<command>\s*([\s\S]*?)\s*<\/command>/i);
  if (!commandMatch) {
    return undefined;
  }

  return {
    summary: summaryMatch?.[1]?.trim() || 'Prepared a terminal command suggestion.',
    command: commandMatch[1].trim()
  };
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n...[truncated]`;
}
