import { existsSync } from 'fs';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { PendingCommand } from './CommandProposal';

const MAX_CAPTURED_OUTPUT_CHARS = 16000;
const MAX_CONTEXT_OUTPUT_CHARS = 6000;

export interface CommandExecutionResult {
  command: string;
  shellPath: string;
  cwdLabel: string;
  cwdPath: string;
  output: string;
  exitCode: number;
  failed: boolean;
  startedAt: number;
  finishedAt: number;
}

export async function runManagedCommand(
  pendingCommand: PendingCommand
): Promise<CommandExecutionResult> {
  const shellPath = resolveShellPath();
  const cwdPath =
    pendingCommand.cwd?.fsPath ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    process.cwd();

  return new Promise<CommandExecutionResult>((resolve) => {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();
    let started = false;
    let childProcess: ReturnType<typeof spawn> | undefined;
    let capturedOutput = '';
    const startedAt = Date.now();

    const terminal = vscode.window.createTerminal({
      name: 'Local Agent',
      pty: {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open: () => {
          if (started) {
            return;
          }

          started = true;
          write(writeEmitter, `PS ${cwdPath}> ${pendingCommand.command}\r\n`);
          childProcess = spawn(
            shellPath,
            ['-NoLogo', '-NoProfile', '-Command', pendingCommand.command],
            {
              cwd: cwdPath,
              env: process.env,
              windowsHide: true
            }
          );

          childProcess.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            capturedOutput = appendOutput(capturedOutput, text);
            write(writeEmitter, normalizeTerminalText(text));
          });

          childProcess.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            capturedOutput = appendOutput(capturedOutput, text);
            write(writeEmitter, normalizeTerminalText(text));
          });

          childProcess.on('error', (error) => {
            const message = `${error.message}\n`;
            capturedOutput = appendOutput(capturedOutput, message);
            write(writeEmitter, normalizeTerminalText(message));
          });

          childProcess.on('close', (code) => {
            const exitCode = typeof code === 'number' ? code : 1;
            write(writeEmitter, `\r\n[Process exited with code ${exitCode}]\r\n`);
            closeEmitter.fire(exitCode);
            resolve({
              command: pendingCommand.command,
              shellPath,
              cwdLabel: pendingCommand.cwdLabel,
              cwdPath,
              output: stripAnsi(capturedOutput).trim(),
              exitCode,
              failed: exitCode !== 0,
              startedAt,
              finishedAt: Date.now()
            });
          });
        },
        close: () => {
          if (childProcess && !childProcess.killed) {
            childProcess.kill();
          }
        }
      }
    });

    terminal.show(true);
  });
}

export function buildCommandFailureContextBlock(
  result: CommandExecutionResult | undefined
): string | undefined {
  if (!result) {
    return undefined;
  }

  const output = result.output
    ? truncateOutput(result.output, MAX_CONTEXT_OUTPUT_CHARS)
    : '[no output captured]';

  return [
    'Last approved terminal command result for this turn only.',
    `<terminal-command shell="${escapeXml(result.shellPath)}" cwd="${escapeXml(result.cwdPath)}" exitCode="${result.exitCode}" failed="${String(result.failed)}">`,
    result.command,
    output,
    '</terminal-command>'
  ].join('\n');
}

function resolveShellPath(): string {
  const pwshPath = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  if (existsSync(pwshPath)) {
    return pwshPath;
  }

  return 'powershell.exe';
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function write(emitter: vscode.EventEmitter<string>, text: string): void {
  emitter.fire(text);
}

function appendOutput(existing: string, next: string): string {
  const combined = `${existing}${next}`;
  if (combined.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return combined;
  }

  return combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS);
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `[truncated]\n${text.slice(text.length - maxChars)}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
