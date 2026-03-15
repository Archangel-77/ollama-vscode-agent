import * as vscode from 'vscode';
import {
  captureProblemsContext,
  getProblemsContextSummary,
  getWorkspaceProblemsNotice,
  ProblemsContextState,
  ProblemsContextSummary,
  shouldAutoIncludeProblemsContext,
  shouldWarnAboutMissingProblemsContext
} from '../diagnostics/ProblemsContext';
import {
  captureEditorContext,
  EditorContextState,
  EditorContextSummary,
  getEditorContextSummary
} from '../context/EditorContext';
import {
  captureWorkspaceContext,
  collectRequestedFileLists,
  collectWorkspaceEditCandidates,
  formatWorkspaceFileListReply,
  getWorkspaceContextSummary,
  isDirectFileListRequest,
  isReferentialFileListRequest,
  shouldAutoIncludeWorkspaceContext,
  WorkspaceFileListMatch,
  WorkspaceContextState,
  WorkspaceContextSummary
} from '../context/WorkspaceContext';
import {
  buildFailureFixStyleContextBlock,
  buildEditProposalMessages,
  buildEditRepairMessages,
  createPendingEdit,
  EditTarget,
  FailureFixStyle,
  getActiveEditTarget,
  parseEditProposalResponse,
  PendingEdit,
  validateEditProposal
} from '../edit/EditProposal';
import {
  buildWorkspaceEditProposalMessages,
  buildWorkspaceEditRepairMessages,
  createPendingEditSet,
  parseWorkspaceEditProposalResponse,
  PendingEditSet
} from '../edit/WorkspaceEditProposal';
import { ChatMessage, OllamaClient } from '../ollama/OllamaClient';
import {
  buildCommandFailureContextBlock,
  CommandExecutionResult,
  runManagedCommand
} from '../terminal/ManagedCommandRunner';
import {
  buildCommandProposalMessages,
  buildCommandRepairMessages,
  createPendingCommand,
  getCommandTarget,
  parseCommandProposalResponse,
  PendingCommand,
  validateCommandProposal
} from '../terminal/CommandProposal';

type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'newThread' }
  | { type: 'openThread'; id: string }
  | { type: 'sendPrompt'; text: string }
  | { type: 'proposeEdit'; text: string }
  | { type: 'fixProblems'; text: string }
  | { type: 'fixLastFailure'; text: string }
  | { type: 'proposeCommand'; text: string }
  | { type: 'previewPendingEdit' }
  | { type: 'previewPendingEditFile'; path: string }
  | { type: 'openWorkspacePath'; path: string }
  | { type: 'applyPendingEdit' }
  | { type: 'rejectPendingEdit' }
  | { type: 'runPendingCommand' }
  | { type: 'rejectPendingCommand' }
  | {
      type: 'setContextEnabled';
      target: 'currentFile' | 'selection' | 'workspace' | 'problems';
      enabled: boolean;
    };

type PromptContextSummary = EditorContextSummary &
  WorkspaceContextSummary &
  ProblemsContextSummary;

type ComposerEnterBehavior = 'enter' | 'cmdIfMultiline';
type FollowUpQueueMode = 'queue' | 'steer' | 'interrupt';
type FollowUpRequestKind =
  | 'sendPrompt'
  | 'proposeEdit'
  | 'fixProblems'
  | 'fixLastFailure'
  | 'proposeCommand';

const MAX_CAPTURED_TERMINAL_OUTPUT_CHARS = 16000;

interface TrackedTerminalExecution {
  command: string;
  cwdLabel: string;
  cwdPath: string;
  startedAt: number;
  outputPromise: Promise<string>;
}

type TranscriptRole = 'assistant' | 'user' | 'system';
const SESSION_STATE_KEY = 'localAgent.session.v1';
const MAX_TASK_ARTIFACTS = 24;

type TaskArtifactKind = 'edit' | 'command' | 'failure' | 'verification';
type TaskArtifactStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'applied'
  | 'rejected'
  | 'failed'
  | 'succeeded';

interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
}

interface TaskArtifact {
  id: string;
  kind: TaskArtifactKind;
  status: TaskArtifactStatus;
  title: string;
  detail: string;
  timestamp: number;
  targets?: string[];
  command?: string;
  cwdLabel?: string;
}

interface ThreadState {
  id: string;
  title: string;
  transcript: TranscriptEntry[];
  conversation: ChatMessage[];
  artifacts: TaskArtifact[];
  createdAt: number;
  updatedAt: number;
  lastWorkspaceFileList?: WorkspaceFileListMatch[];
  pendingEditSet?: PendingEditSet;
  pendingEditUsesTerminalFailure: boolean;
  pendingCommand?: PendingCommand;
  lastRunnableCommand?: PendingCommand;
  lastCommandResult?: CommandExecutionResult;
  lastFailedCommandResult?: CommandExecutionResult;
}

interface FollowUpRequest {
  kind: FollowUpRequestKind;
  text: string;
}

interface SerializedPendingEdit {
  id: string;
  isNewFile: boolean;
  documentUri: string;
  relativePath: string;
  language: string;
  summary: string;
  originalText: string;
  proposedText: string;
  originalVersion: number;
  stats: PendingEdit['stats'];
}

interface SerializedPendingEditSet {
  id: string;
  summary: string;
  files: SerializedPendingEdit[];
}

interface SerializedPendingCommand {
  id: string;
  summary: string;
  command: string;
  cwd?: string;
  cwdLabel: string;
}

interface SerializedThreadState {
  id: string;
  title: string;
  transcript: TranscriptEntry[];
  conversation: ChatMessage[];
  artifacts: TaskArtifact[];
  createdAt: number;
  updatedAt: number;
  lastWorkspaceFileList?: WorkspaceFileListMatch[];
  pendingEditSet?: SerializedPendingEditSet;
  pendingEditUsesTerminalFailure: boolean;
  pendingCommand?: SerializedPendingCommand;
  lastRunnableCommand?: SerializedPendingCommand;
  lastCommandResult?: CommandExecutionResult;
  lastFailedCommandResult?: CommandExecutionResult;
}

interface PersistedSessionState {
  version: 1;
  activeThreadId: string;
  threads: SerializedThreadState[];
  contextState: EditorContextState;
  workspaceContextState: WorkspaceContextState;
  problemsContextState: ProblemsContextState;
}

type ExtensionToWebviewMessage =
  | { type: 'systemMessage'; text: string }
  | { type: 'resetTranscript' }
  | { type: 'hydrateTranscript'; entries: TranscriptEntry[] }
  | { type: 'showFindInThread' }
  | { type: 'setStatus'; text: string }
  | { type: 'setBusy'; busy: boolean }
  | { type: 'setComposerBehavior'; behavior: ComposerEnterBehavior }
  | { type: 'setConnection'; text: string }
  | { type: 'setTaskHistory'; artifacts: TaskArtifact[] }
  | {
      type: 'setThreads';
      threads: Array<{
        id: string;
        title: string;
        preview: string;
        active: boolean;
      }>;
    }
  | { type: 'setContextState'; context: PromptContextSummary }
  | {
      type: 'setPendingEdit';
      pendingEdit:
        | {
            title: string;
            summary: string;
            statsText: string;
            files: Array<{
              path: string;
              summary: string;
              statsText: string;
            }>;
          }
        | null;
    }
  | { type: 'assistantStart' }
  | { type: 'assistantChunk'; text: string }
  | { type: 'assistantEnd' }
  | {
      type: 'setPendingCommand';
      pendingCommand:
        | {
            summary: string;
            command: string;
            cwdLabel: string;
          }
        | null;
    };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localAgent.chat';
  public static readonly secondaryViewType = 'localAgent.secondaryChat';

  private readonly views = new Map<string, vscode.WebviewView>();
  private readonly conversation: ChatMessage[] = [];
  private readonly transcriptEntries: TranscriptEntry[] = [];
  private readonly taskArtifacts: TaskArtifact[] = [];
  private isBusy = false;
  private readonly contextState: EditorContextState = {
    includeCurrentFile: false,
    includeSelection: false
  };
  private readonly workspaceContextState: WorkspaceContextState = {
    includeWorkspace: false
  };
  private readonly problemsContextState: ProblemsContextState = {
    includeProblems: false
  };
  private lastWorkspaceFileList?: WorkspaceFileListMatch[];
  private pendingEditSet?: PendingEditSet;
  private pendingEditUsesTerminalFailure = false;
  private pendingCommand?: PendingCommand;
  private lastRunnableCommand?: PendingCommand;
  private lastCommandResult?: CommandExecutionResult;
  private lastFailedCommandResult?: CommandExecutionResult;
  private activeAssistantTranscript = '';
  private readonly threads: ThreadState[] = [];
  private activeThreadId!: string;
  private currentRequestAbortController?: AbortController;
  private readonly queuedFollowUps: FollowUpRequest[] = [];
  private readonly trackedTerminalExecutions = new Map<
    vscode.TerminalShellExecution,
    TrackedTerminalExecution
  >();

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento
  ) {
    if (!this.restorePersistedSession()) {
      const initialThread = this.createThread();
      this.threads.push(initialThread);
      this.activeThreadId = initialThread.id;
    }
  }

  public focus(): void {
    const preferredView = this.views.get(this.getPreferredViewType());
    const fallbackView = preferredView ?? this.views.values().next().value;
    fallbackView?.show?.(false);
  }

  public async openThread(threadId: string): Promise<void> {
    if (this.isBusy) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'Wait for the current request to finish before switching threads.'
      });
      return;
    }

    if (threadId === this.activeThreadId) {
      return;
    }

    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      return;
    }

    this.persistCurrentThreadState();
    this.activeThreadId = thread.id;
    this.loadThread(thread);
    await this.hydrateCurrentThread();
    await this.refreshTaskHistory();
    await this.refreshPendingEdit();
    await this.refreshPendingCommand();
    await this.refreshThreadList();
    await this.postMessage({
      type: 'setStatus',
      text: this.getIdleStatusText()
    });
  }

  public async startNewThread(): Promise<void> {
    if (this.isBusy) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'Wait for the current request to finish before starting a new thread.'
      });
      return;
    }

    this.persistCurrentThreadState();
    const nextThread = this.createThread();
    this.threads.unshift(nextThread);
    this.activeThreadId = nextThread.id;
    this.loadThread(nextThread);

    await this.postMessage({
      type: 'resetTranscript'
    });
    await this.refreshTaskHistory();
    await this.refreshPendingEdit();
    await this.refreshPendingCommand();
    await this.refreshThreadList();
    await this.postMessage({
      type: 'systemMessage',
      text: 'Started a new thread.'
    });
    await this.postMessage({
      type: 'setStatus',
      text: this.getIdleStatusText()
    });
  }

  private createThread(): ThreadState {
    const now = Date.now();
    return {
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'New Thread',
      transcript: [],
      conversation: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      pendingEditUsesTerminalFailure: false
    };
  }

  private getActiveThread(): ThreadState {
    const thread = this.threads.find((candidate) => candidate.id === this.activeThreadId);
    if (!thread) {
      const fallback = this.createThread();
      this.threads.unshift(fallback);
      this.activeThreadId = fallback.id;
      return fallback;
    }

    return thread;
  }

  private loadThread(thread: ThreadState): void {
    this.conversation.splice(0, this.conversation.length, ...thread.conversation);
    this.transcriptEntries.splice(0, this.transcriptEntries.length, ...thread.transcript);
    this.taskArtifacts.splice(0, this.taskArtifacts.length, ...thread.artifacts);
    this.lastWorkspaceFileList = thread.lastWorkspaceFileList;
    this.pendingEditSet = thread.pendingEditSet;
    this.pendingEditUsesTerminalFailure = thread.pendingEditUsesTerminalFailure;
    this.pendingCommand = thread.pendingCommand;
    this.lastRunnableCommand = thread.lastRunnableCommand;
    this.lastCommandResult = thread.lastCommandResult;
    this.lastFailedCommandResult = thread.lastFailedCommandResult;
    this.activeAssistantTranscript = '';
  }

  private persistCurrentThreadState(): void {
    const thread = this.getActiveThread();
    thread.conversation = [...this.conversation];
    thread.transcript = this.transcriptEntries.map((entry) => ({ ...entry }));
    thread.artifacts = this.taskArtifacts.map((artifact) => this.cloneTaskArtifact(artifact));
    thread.lastWorkspaceFileList = this.lastWorkspaceFileList;
    thread.pendingEditSet = this.pendingEditSet;
    thread.pendingEditUsesTerminalFailure = this.pendingEditUsesTerminalFailure;
    thread.pendingCommand = this.pendingCommand;
    thread.lastRunnableCommand = this.lastRunnableCommand;
    thread.lastCommandResult = this.lastCommandResult;
    thread.lastFailedCommandResult = this.lastFailedCommandResult;
    thread.updatedAt = Date.now();
    thread.title = this.deriveThreadTitle(thread);
    void this.saveSessionState();
  }

  private restorePersistedSession(): boolean {
    const persisted = this.workspaceState.get<PersistedSessionState>(SESSION_STATE_KEY);
    if (!persisted || persisted.version !== 1 || !Array.isArray(persisted.threads)) {
      return false;
    }

    const restoredThreads = persisted.threads
      .map((thread) => this.deserializeThreadState(thread))
      .filter((thread): thread is ThreadState => Boolean(thread));

    if (restoredThreads.length === 0) {
      return false;
    }

    this.contextState.includeCurrentFile = Boolean(
      persisted.contextState?.includeCurrentFile
    );
    this.contextState.includeSelection = Boolean(persisted.contextState?.includeSelection);
    this.workspaceContextState.includeWorkspace = Boolean(
      persisted.workspaceContextState?.includeWorkspace
    );
    this.problemsContextState.includeProblems = Boolean(
      persisted.problemsContextState?.includeProblems
    );

    this.threads.splice(0, this.threads.length, ...restoredThreads);
    this.activeThreadId = restoredThreads.some(
      (thread) => thread.id === persisted.activeThreadId
    )
      ? persisted.activeThreadId
      : restoredThreads[0].id;
    this.loadThread(this.getActiveThread());
    return true;
  }

  private async saveSessionState(): Promise<void> {
    const persisted: PersistedSessionState = {
      version: 1,
      activeThreadId: this.activeThreadId,
      threads: this.threads.map((thread) => this.serializeThreadState(thread)),
      contextState: {
        includeCurrentFile: this.contextState.includeCurrentFile,
        includeSelection: this.contextState.includeSelection
      },
      workspaceContextState: {
        includeWorkspace: this.workspaceContextState.includeWorkspace
      },
      problemsContextState: {
        includeProblems: this.problemsContextState.includeProblems
      }
    };

    await this.workspaceState.update(SESSION_STATE_KEY, persisted);
  }

  private serializeThreadState(thread: ThreadState): SerializedThreadState {
    return {
      id: thread.id,
      title: thread.title,
      transcript: thread.transcript.map((entry) => ({ ...entry })),
      conversation: thread.conversation.map((message) => ({ ...message })),
      artifacts: thread.artifacts.map((artifact) => this.cloneTaskArtifact(artifact)),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      lastWorkspaceFileList: thread.lastWorkspaceFileList?.map((match) => ({
        requested: match.requested,
        glob: match.glob,
        paths: [...match.paths],
        truncated: match.truncated
      })),
      pendingEditSet: this.serializePendingEditSet(thread.pendingEditSet),
      pendingEditUsesTerminalFailure: thread.pendingEditUsesTerminalFailure,
      pendingCommand: this.serializePendingCommand(thread.pendingCommand),
      lastRunnableCommand: this.serializePendingCommand(thread.lastRunnableCommand),
      lastCommandResult: thread.lastCommandResult
        ? { ...thread.lastCommandResult }
        : undefined,
      lastFailedCommandResult: thread.lastFailedCommandResult
        ? { ...thread.lastFailedCommandResult }
        : undefined
    };
  }

  private deserializeThreadState(thread: SerializedThreadState): ThreadState | undefined {
    if (!thread?.id || !Array.isArray(thread.transcript) || !Array.isArray(thread.conversation)) {
      return undefined;
    }

    const artifacts = (Array.isArray(thread.artifacts) ? thread.artifacts : [])
      .map((artifact) => this.deserializeTaskArtifact(artifact))
      .filter((artifact): artifact is TaskArtifact => Boolean(artifact));

    return {
      id: thread.id,
      title: typeof thread.title === 'string' && thread.title.trim() ? thread.title : 'New Thread',
      transcript: thread.transcript
        .filter((entry) => entry && typeof entry.text === 'string')
        .map((entry) => ({
          role:
            entry.role === 'assistant' || entry.role === 'user' || entry.role === 'system'
              ? entry.role
              : 'assistant',
          text: entry.text
        })),
      conversation: thread.conversation
        .filter(
          (message) =>
            message &&
            (message.role === 'assistant' || message.role === 'user' || message.role === 'system') &&
            typeof message.content === 'string'
        )
        .map((message) => ({
          role: message.role,
          content: message.content
        })),
      artifacts,
      createdAt: Number.isFinite(thread.createdAt) ? thread.createdAt : Date.now(),
      updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : Date.now(),
      lastWorkspaceFileList: thread.lastWorkspaceFileList?.map((match) => ({
        requested: match.requested,
        glob: match.glob,
        paths: Array.isArray(match.paths) ? [...match.paths] : [],
        truncated: Boolean(match.truncated)
      })),
      pendingEditSet: this.deserializePendingEditSet(thread.pendingEditSet),
      pendingEditUsesTerminalFailure: Boolean(thread.pendingEditUsesTerminalFailure),
      pendingCommand: this.deserializePendingCommand(thread.pendingCommand),
      lastRunnableCommand: this.deserializePendingCommand(thread.lastRunnableCommand),
      lastCommandResult: thread.lastCommandResult
        ? { ...thread.lastCommandResult }
        : undefined,
      lastFailedCommandResult: thread.lastFailedCommandResult
        ? { ...thread.lastFailedCommandResult }
        : undefined
    };
  }

  private cloneTaskArtifact(artifact: TaskArtifact): TaskArtifact {
    return {
      ...artifact,
      targets: artifact.targets ? [...artifact.targets] : undefined
    };
  }

  private deserializeTaskArtifact(artifact: TaskArtifact | undefined): TaskArtifact | undefined {
    if (
      !artifact?.id ||
      typeof artifact.title !== 'string' ||
      typeof artifact.detail !== 'string' ||
      !Number.isFinite(artifact.timestamp)
    ) {
      return undefined;
    }

    if (
      artifact.kind !== 'edit' &&
      artifact.kind !== 'command' &&
      artifact.kind !== 'failure' &&
      artifact.kind !== 'verification'
    ) {
      return undefined;
    }

    if (
      artifact.status !== 'pending' &&
      artifact.status !== 'queued' &&
      artifact.status !== 'running' &&
      artifact.status !== 'applied' &&
      artifact.status !== 'rejected' &&
      artifact.status !== 'failed' &&
      artifact.status !== 'succeeded'
    ) {
      return undefined;
    }

    return {
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      title: artifact.title,
      detail: artifact.detail,
      timestamp: artifact.timestamp,
      targets: Array.isArray(artifact.targets)
        ? artifact.targets.filter((target): target is string => typeof target === 'string')
        : undefined,
      command: typeof artifact.command === 'string' ? artifact.command : undefined,
      cwdLabel: typeof artifact.cwdLabel === 'string' ? artifact.cwdLabel : undefined
    };
  }

  private serializePendingEditSet(
    pendingEditSet: PendingEditSet | undefined
  ): SerializedPendingEditSet | undefined {
    if (!pendingEditSet) {
      return undefined;
    }

    return {
      id: pendingEditSet.id,
      summary: pendingEditSet.summary,
      files: pendingEditSet.files.map((pendingEdit) => ({
        id: pendingEdit.id,
        isNewFile: pendingEdit.isNewFile,
        documentUri: pendingEdit.documentUri.toString(),
        relativePath: pendingEdit.relativePath,
        language: pendingEdit.language,
        summary: pendingEdit.summary,
        originalText: pendingEdit.originalText,
        proposedText: pendingEdit.proposedText,
        originalVersion: pendingEdit.originalVersion,
        stats: { ...pendingEdit.stats }
      }))
    };
  }

  private deserializePendingEditSet(
    pendingEditSet: SerializedPendingEditSet | undefined
  ): PendingEditSet | undefined {
    if (!pendingEditSet?.id || !Array.isArray(pendingEditSet.files)) {
      return undefined;
    }

    const files = pendingEditSet.files
      .filter(
        (pendingEdit) =>
          pendingEdit &&
          typeof pendingEdit.documentUri === 'string' &&
          typeof pendingEdit.relativePath === 'string' &&
          typeof pendingEdit.language === 'string' &&
          typeof pendingEdit.summary === 'string' &&
          typeof pendingEdit.originalText === 'string' &&
          typeof pendingEdit.proposedText === 'string'
      )
      .map(
        (pendingEdit): PendingEdit => ({
          id: pendingEdit.id,
          isNewFile: Boolean(pendingEdit.isNewFile),
          documentUri: vscode.Uri.parse(pendingEdit.documentUri),
          relativePath: pendingEdit.relativePath,
          language: pendingEdit.language,
          summary: pendingEdit.summary,
          originalText: pendingEdit.originalText,
          proposedText: pendingEdit.proposedText,
          originalVersion: pendingEdit.originalVersion,
          stats: {
            originalLines: pendingEdit.stats.originalLines,
            proposedLines: pendingEdit.stats.proposedLines,
            deltaLines: pendingEdit.stats.deltaLines
          }
        })
      );

    if (files.length === 0) {
      return undefined;
    }

    return {
      id: pendingEditSet.id,
      summary: pendingEditSet.summary,
      files
    };
  }

  private serializePendingCommand(
    pendingCommand: PendingCommand | undefined
  ): SerializedPendingCommand | undefined {
    if (!pendingCommand) {
      return undefined;
    }

    return {
      id: pendingCommand.id,
      summary: pendingCommand.summary,
      command: pendingCommand.command,
      cwd: pendingCommand.cwd?.toString(),
      cwdLabel: pendingCommand.cwdLabel
    };
  }

  private deserializePendingCommand(
    pendingCommand: SerializedPendingCommand | undefined
  ): PendingCommand | undefined {
    if (
      !pendingCommand?.id ||
      typeof pendingCommand.summary !== 'string' ||
      typeof pendingCommand.command !== 'string' ||
      typeof pendingCommand.cwdLabel !== 'string'
    ) {
      return undefined;
    }

    return {
      id: pendingCommand.id,
      summary: pendingCommand.summary,
      command: pendingCommand.command,
      cwd: pendingCommand.cwd ? vscode.Uri.parse(pendingCommand.cwd) : undefined,
      cwdLabel: pendingCommand.cwdLabel
    };
  }

  private deriveThreadTitle(thread: ThreadState): string {
    const firstUserEntry = thread.transcript.find((entry) => entry.role === 'user');
    if (!firstUserEntry) {
      return 'New Thread';
    }

    const normalized = firstUserEntry.text.replace(/\s+/g, ' ').trim();
    return normalized.length > 34 ? `${normalized.slice(0, 33)}…` : normalized;
  }

  private buildThreadPreview(thread: ThreadState): string {
    const recentEntry = [...thread.transcript]
      .reverse()
      .find((entry) => entry.role !== 'system' && entry.text.trim().length > 0);
    if (!recentEntry) {
      return 'Empty thread';
    }

    const normalized = recentEntry.text.replace(/\s+/g, ' ').trim();
    return normalized.length > 52 ? `${normalized.slice(0, 51)}…` : normalized;
  }

  private async refreshThreadList(): Promise<void> {
    this.persistCurrentThreadState();
    await this.postMessage({
      type: 'setThreads',
      threads: [...this.threads]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((thread) => ({
          id: thread.id,
          title: thread.title,
          preview: this.buildThreadPreview(thread),
          active: thread.id === this.activeThreadId
        }))
    });
  }

  private async refreshTaskHistory(): Promise<void> {
    await this.postMessage({
      type: 'setTaskHistory',
      artifacts: this.taskArtifacts.map((artifact) => this.cloneTaskArtifact(artifact))
    });
  }

  private async hydrateCurrentThread(): Promise<void> {
    await this.postMessage({
      type: 'resetTranscript'
    });

    if (this.transcriptEntries.length === 0) {
      return;
    }

    await this.postMessage({
      type: 'hydrateTranscript',
      entries: this.transcriptEntries
    });
  }

  private async addTaskArtifact(
    artifact: Omit<TaskArtifact, 'id' | 'timestamp'> & { timestamp?: number }
  ): Promise<void> {
    this.taskArtifacts.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: artifact.timestamp ?? Date.now(),
      ...artifact,
      targets: artifact.targets ? [...artifact.targets] : undefined
    });

    if (this.taskArtifacts.length > MAX_TASK_ARTIFACTS) {
      this.taskArtifacts.length = MAX_TASK_ARTIFACTS;
    }

    this.persistCurrentThreadState();
    await this.refreshTaskHistory();
  }

  private recordTranscriptEntry(role: TranscriptRole, text: string): void {
    if (role === 'system') {
      return;
    }

    if (!text.trim()) {
      return;
    }

    this.transcriptEntries.push({ role, text });
    this.persistCurrentThreadState();
  }

  private getUserTranscriptText(action: 'chat' | 'edit' | 'fixProblems' | 'fixLastFailure' | 'command', text: string): string {
    const trimmed = text.trim();
    if (trimmed) {
      return trimmed;
    }

    switch (action) {
      case 'fixProblems':
        return 'Fix current workspace problems';
      case 'fixLastFailure':
        return 'Fix last terminal failure';
      default:
        return '';
    }
  }

  public async setCurrentFileContextEnabled(enabled: boolean): Promise<void> {
    this.contextState.includeCurrentFile = enabled;
    void this.saveSessionState();
    await this.refreshEditorContext();
    await this.postMessage({
      type: 'systemMessage',
      text: enabled ? 'Current file context enabled.' : 'Current file context disabled.'
    });
  }

  public async setSelectionContextEnabled(enabled: boolean): Promise<void> {
    this.contextState.includeSelection = enabled;
    void this.saveSessionState();
    await this.refreshEditorContext();
    await this.postMessage({
      type: 'systemMessage',
      text: enabled ? 'Selection context enabled.' : 'Selection context disabled.'
    });
  }

  public async setWorkspaceContextEnabled(enabled: boolean): Promise<void> {
    this.workspaceContextState.includeWorkspace = enabled;
    void this.saveSessionState();
    await this.refreshEditorContext();
    await this.postMessage({
      type: 'systemMessage',
      text: enabled ? 'Workspace context enabled.' : 'Workspace context disabled.'
    });
  }

  public async setProblemsContextEnabled(enabled: boolean): Promise<void> {
    this.problemsContextState.includeProblems = enabled;
    void this.saveSessionState();
    await this.refreshEditorContext();
    await this.postMessage({
      type: 'systemMessage',
      text: enabled ? 'Problems context enabled.' : 'Problems context disabled.'
    });
  }

  public async proposeProblemFix(prompt = ''): Promise<void> {
    await this.handleFixProblems(prompt);
  }

  public async proposeLastFailureFix(prompt = ''): Promise<void> {
    await this.handleFixLastFailure(prompt);
  }

  public async proposeReviewedEdit(prompt: string): Promise<void> {
    await this.handleProposeEdit(prompt);
  }

  public async showFindInThread(): Promise<void> {
    await this.postMessage({
      type: 'showFindInThread'
    });
  }

  public async refreshUiPreferences(): Promise<void> {
    await this.postMessage({
      type: 'setComposerBehavior',
      behavior: this.getComposerEnterBehavior()
    });
  }

  public trackTerminalExecutionStart(
    event: vscode.TerminalShellExecutionStartEvent
  ): void {
    const command = event.execution.commandLine.value.trim();
    if (!command) {
      return;
    }

    const cwdUri = event.execution.cwd;
    const cwdPath = cwdUri?.fsPath ?? '';
    const cwdLabel =
      (cwdUri && vscode.workspace.getWorkspaceFolder(cwdUri)?.name) || event.terminal.name;

    this.trackedTerminalExecutions.set(event.execution, {
      command,
      cwdLabel,
      cwdPath,
      startedAt: Date.now(),
      outputPromise: this.captureTerminalExecutionOutput(event.execution)
    });
  }

  public async trackTerminalExecutionEnd(
    event: vscode.TerminalShellExecutionEndEvent
  ): Promise<void> {
    const tracked = this.trackedTerminalExecutions.get(event.execution);
    if (!tracked) {
      return;
    }

    this.trackedTerminalExecutions.delete(event.execution);

    const output = await tracked.outputPromise;
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : 1;
    const result: CommandExecutionResult = {
      command: tracked.command,
      shellPath: event.terminal.name,
      cwdLabel: tracked.cwdLabel,
      cwdPath: tracked.cwdPath,
      output,
      exitCode,
      failed: exitCode !== 0,
      startedAt: tracked.startedAt,
      finishedAt: Date.now()
    };

    this.lastCommandResult = result;
    if (this.isRerunnableTerminalCommand(event.execution.commandLine)) {
      this.lastRunnableCommand = this.createRunnableCommandFromExecution(result);
    }
    this.persistCurrentThreadState();

    if (result.failed) {
      this.lastFailedCommandResult = result;
      this.persistCurrentThreadState();
      await this.addTaskArtifact({
        kind: 'failure',
        status: 'failed',
        title: 'Terminal command failed',
        detail: `${result.command} exited with code ${result.exitCode} in ${result.cwdLabel}.`,
        command: result.command,
        cwdLabel: result.cwdLabel
      });
      await this.postMessage({
        type: 'systemMessage',
        text: `Captured failed terminal output from ${result.cwdLabel}: ${result.command} (exit code ${result.exitCode}). Use Fix Last Failure to prepare a reviewed fix.`
      });
      return;
    }

    if (
      this.lastFailedCommandResult &&
      this.isSameTerminalCommand(this.lastFailedCommandResult, result)
    ) {
      this.lastFailedCommandResult = undefined;
      this.persistCurrentThreadState();
      await this.addTaskArtifact({
        kind: 'verification',
        status: 'succeeded',
        title: 'Terminal rerun succeeded',
        detail: `${result.command} completed successfully in ${result.cwdLabel}.`,
        command: result.command,
        cwdLabel: result.cwdLabel
      });
      await this.postMessage({
        type: 'systemMessage',
        text: `Captured successful terminal rerun from ${result.cwdLabel}: ${result.command}`
      });
    }
  }

  public async refreshConnectionStatus(): Promise<void> {
    const config = this.getConfig();
    const client = new OllamaClient(config.baseUrl);

    try {
      const models = await client.listModels();
      if (models.length === 0) {
        await this.postMessage({
          type: 'setConnection',
          text: `Connected to ${config.baseUrl}, but no models are installed.`
        });
        await this.postMessage({
          type: 'setStatus',
          text: 'No models'
        });
        return;
      }

      const selectedModel = this.resolveModel(models, config.model);
      const editModel = this.resolveEditModel(models, config);
      await this.postMessage({
        type: 'setConnection',
        text: `Connected to ${config.baseUrl} | chat: ${selectedModel} | edit: ${editModel}`
      });
      await this.postMessage({
        type: 'setStatus',
        text: this.isBusy ? 'Streaming' : this.getIdleStatusText()
      });
    } catch (error) {
      const message = getErrorMessage(error);
      await this.postMessage({
        type: 'setConnection',
        text: `Ollama unavailable at ${config.baseUrl}. ${message}`
      });
      await this.postMessage({
        type: 'setStatus',
        text: 'Disconnected'
      });
    }
  }

  public async refreshEditorContext(): Promise<void> {
    await this.postMessage({
      type: 'setContextState',
      context: {
        ...getEditorContextSummary(this.contextState),
        ...getWorkspaceContextSummary(this.workspaceContextState),
        ...getProblemsContextSummary(this.problemsContextState)
      }
    });
  }

  public async refreshPendingEdit(): Promise<void> {
    this.persistCurrentThreadState();
    await this.postMessage({
      type: 'setPendingEdit',
      pendingEdit: this.pendingEditSet
        ? {
            title: this.getPendingEditSetTitle(this.pendingEditSet),
            summary: this.pendingEditSet.summary,
            statsText: this.formatPendingEditSetStats(this.pendingEditSet),
            files: this.pendingEditSet.files.map((pendingEdit) => ({
              path: pendingEdit.relativePath,
              summary: pendingEdit.summary,
              statsText: this.formatPendingEditStats(pendingEdit)
            }))
          }
        : null
    });
  }

  public async refreshPendingCommand(): Promise<void> {
    this.persistCurrentThreadState();
    await this.postMessage({
      type: 'setPendingCommand',
      pendingCommand: this.pendingCommand
        ? {
            summary: this.pendingCommand.summary,
            command: this.pendingCommand.command,
            cwdLabel: this.pendingCommand.cwdLabel
          }
        : null
    });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.views.set(webviewView.viewType, webviewView);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.views.delete(webviewView.viewType);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshUiPreferences();
      }
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.refreshThreadList();
        await this.hydrateCurrentThread();
        if (this.transcriptEntries.length === 0) {
          await this.postMessage({
            type: 'systemMessage',
            text: 'Local Agent is ready. Start Ollama locally to enable streamed chat.'
          });
        }
        await this.refreshUiPreferences();
        await this.refreshConnectionStatus();
        await this.refreshEditorContext();
        await this.refreshTaskHistory();
        await this.refreshPendingEdit();
        await this.refreshPendingCommand();
        return;
      case 'newThread':
        await this.startNewThread();
        return;
      case 'openThread':
        await this.openThread(message.id);
        return;
      case 'previewPendingEdit':
        await this.previewPendingEdit();
        return;
      case 'previewPendingEditFile':
        await this.previewPendingEditFile(message.path);
        return;
      case 'openWorkspacePath':
        await this.openWorkspacePath(message.path);
        return;
      case 'applyPendingEdit':
        await this.applyPendingEdit();
        return;
      case 'rejectPendingEdit':
        await this.rejectPendingEdit();
        return;
      case 'runPendingCommand':
        await this.runPendingCommand();
        return;
      case 'rejectPendingCommand':
        await this.rejectPendingCommand();
        return;
      case 'setContextEnabled':
        if (message.target === 'currentFile') {
          this.contextState.includeCurrentFile = message.enabled;
        } else if (message.target === 'selection') {
          this.contextState.includeSelection = message.enabled;
        } else if (message.target === 'problems') {
          this.problemsContextState.includeProblems = message.enabled;
        } else {
          this.workspaceContextState.includeWorkspace = message.enabled;
        }

        void this.saveSessionState();
        await this.refreshEditorContext();
        return;
      case 'proposeEdit':
        if (
          this.isBusy &&
          (await this.handleBusyFollowUp({
            kind: 'proposeEdit',
            text: message.text
          }))
        ) {
          return;
        }
        this.recordTranscriptEntry('user', this.getUserTranscriptText('edit', message.text));
        await this.refreshThreadList();
        await this.handleProposeEdit(message.text);
        return;
      case 'fixProblems':
        if (
          this.isBusy &&
          (await this.handleBusyFollowUp({
            kind: 'fixProblems',
            text: message.text
          }))
        ) {
          return;
        }
        this.recordTranscriptEntry(
          'user',
          this.getUserTranscriptText('fixProblems', message.text)
        );
        await this.refreshThreadList();
        await this.handleFixProblems(message.text);
        return;
      case 'fixLastFailure':
        if (
          this.isBusy &&
          (await this.handleBusyFollowUp({
            kind: 'fixLastFailure',
            text: message.text
          }))
        ) {
          return;
        }
        this.recordTranscriptEntry(
          'user',
          this.getUserTranscriptText('fixLastFailure', message.text)
        );
        await this.refreshThreadList();
        await this.handleFixLastFailure(message.text);
        return;
      case 'proposeCommand':
        if (
          this.isBusy &&
          (await this.handleBusyFollowUp({
            kind: 'proposeCommand',
            text: message.text
          }))
        ) {
          return;
        }
        this.recordTranscriptEntry('user', this.getUserTranscriptText('command', message.text));
        await this.refreshThreadList();
        await this.handleProposeCommand(message.text);
        return;
      case 'sendPrompt': {
        const prompt = message.text.trim();
        if (!prompt) {
          return;
        }

        if (this.isBusy) {
          await this.handleBusyFollowUp({
            kind: 'sendPrompt',
            text: prompt
          });
          return;
        }

        this.recordTranscriptEntry('user', this.getUserTranscriptText('chat', prompt));
        await this.refreshThreadList();

        await this.handleSendPrompt(prompt);
        return;
      }
    }
  }

  private async handleSendPrompt(prompt: string): Promise<void> {
    if (await this.tryHandlePendingActionPrompt(prompt)) {
      return;
    }

    if (this.shouldAutoRouteToLastFailure(prompt)) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'Using the last captured terminal failure to prepare a reviewed edit proposal.'
      });
      await this.handleFixLastFailure(prompt);
      return;
    }

    if (this.shouldAutoRouteToEditProposal(prompt)) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'This prompt looks like an edit request. Preparing a reviewed edit proposal instead of plain chat.'
      });
      await this.handleProposeEdit(prompt);
      return;
    }

    this.isBusy = true;
    this.currentRequestAbortController = new AbortController();
    await this.postMessage({
      type: 'setBusy',
      busy: true
    });
    await this.postMessage({
      type: 'setStatus',
      text: 'Connecting'
    });

    try {
      const config = this.getConfig();
      const client = new OllamaClient(config.baseUrl);
      const models = await client.listModels(this.currentRequestAbortController.signal);

      if (models.length === 0) {
        throw new Error('No Ollama models are installed yet.');
      }

      const selectedModel = this.resolveModel(models, config.model);
      await this.postMessage({
        type: 'setConnection',
        text: `Connected to ${config.baseUrl} using ${selectedModel}`
      });
      await this.postMessage({
        type: 'setStatus',
        text: 'Streaming'
      });

      const editorContextState = this.getEffectiveEditorContextState(prompt);
      if (editorContextState.includeCurrentFile && !this.contextState.includeCurrentFile) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Current file context was auto-enabled for this prompt.'
        });
      }
      if (editorContextState.includeSelection && !this.contextState.includeSelection) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Selection context was auto-enabled for this prompt.'
        });
      }

      const editorContext = captureEditorContext(editorContextState);
      for (const notice of editorContext.notices) {
        await this.postMessage({
          type: 'systemMessage',
          text: notice
        });
      }

      const directFileListReply = await this.buildDirectFileListReply(prompt);
      const userMessage: ChatMessage = { role: 'user', content: prompt };
      if (directFileListReply) {
        await this.postMessage({
          type: 'assistantStart'
        });
        await this.postMessage({
          type: 'assistantChunk',
          text: directFileListReply
        });
        await this.postMessage({
          type: 'assistantEnd'
        });

        this.conversation.push(userMessage, {
          role: 'assistant',
          content: directFileListReply
        });
        this.persistCurrentThreadState();
        await this.postMessage({
          type: 'setStatus',
          text: this.getIdleStatusText()
        });
        await this.refreshThreadList();
        return;
      }

      await this.postMessage({
        type: 'assistantStart'
      });

      const workspaceSeed = this.buildWorkspaceQuerySeed(prompt);
      const useWorkspaceContext =
        this.workspaceContextState.includeWorkspace ||
        shouldAutoIncludeWorkspaceContext(workspaceSeed);
      const useProblemsContext =
        this.problemsContextState.includeProblems ||
        shouldAutoIncludeProblemsContext(workspaceSeed);

      if (useWorkspaceContext && !this.workspaceContextState.includeWorkspace) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Workspace context was auto-enabled for this prompt.'
        });
      }
      if (useProblemsContext && !this.problemsContextState.includeProblems) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Problems context was auto-enabled for this prompt.'
        });
      }

      const workspaceContext = await captureWorkspaceContext(workspaceSeed, {
        includeWorkspace: useWorkspaceContext
      });
      for (const notice of workspaceContext.notices) {
        await this.postMessage({
          type: 'systemMessage',
          text: notice
        });
      }
      const problemsContext = captureProblemsContext(workspaceSeed, {
        includeProblems: useProblemsContext
      });
      for (const notice of problemsContext.notices) {
        await this.postMessage({
          type: 'systemMessage',
          text: notice
        });
      }
      const terminalFailureContext = buildCommandFailureContextBlock(
        this.getRelevantTerminalResult(prompt)
      );
      if (terminalFailureContext) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Included captured terminal output for this prompt.'
        });
      }

      const messages = this.buildRequestMessages(
        userMessage,
        [
          editorContext.promptBlock,
          workspaceContext.promptBlock,
          problemsContext.promptBlock,
          terminalFailureContext
        ],
        this.buildGroundingWarnings(
          prompt,
          editorContext.promptBlock,
          editorContextState,
          workspaceContext.promptBlock,
          useWorkspaceContext,
          problemsContext.promptBlock,
          useProblemsContext
        )
      );
      let assistantContent = '';

      await client.streamChat(
        selectedModel,
        messages,
        async (text) => {
          assistantContent += text;
          await this.postMessage({
            type: 'assistantChunk',
            text
          });
        },
        this.currentRequestAbortController.signal
      );

      this.conversation.push(userMessage, {
        role: 'assistant',
        content: assistantContent
      });
      this.persistCurrentThreadState();
      await this.postMessage({
        type: 'assistantEnd'
      });
      await this.postMessage({
        type: 'setStatus',
        text: this.getIdleStatusText()
      });
      await this.refreshThreadList();
    } catch (error) {
      if (this.isAbortError(error)) {
        await this.postMessage({
          type: 'assistantEnd'
        });
        return;
      }

      await this.postMessage({
        type: 'systemMessage',
        text: getErrorMessage(error)
      });
      await this.postMessage({
        type: 'setStatus',
        text: 'Error'
      });
      await this.refreshConnectionStatus();
    } finally {
      this.currentRequestAbortController = undefined;
      this.isBusy = false;
      await this.postMessage({
        type: 'setBusy',
        busy: false
      });
      await this.processQueuedFollowUps();
    }
  }

  private getPreferredViewType(): string {
    return vscode.workspace.getConfiguration('localAgent').get<boolean>(
      'preferSecondarySidebar',
      false
    )
      ? ChatViewProvider.secondaryViewType
      : ChatViewProvider.viewType;
  }

  private getFollowUpQueueMode(): FollowUpQueueMode {
    const mode = vscode.workspace
      .getConfiguration('localAgent')
      .get<string>('followUpQueueMode', 'queue');

    switch (mode) {
      case 'steer':
      case 'interrupt':
        return mode;
      default:
        return 'queue';
    }
  }

  private describeFollowUpRequest(request: FollowUpRequest): string {
    const trimmed = request.text.trim();
    switch (request.kind) {
      case 'proposeEdit':
        return trimmed ? `edit request: ${trimmed}` : 'edit request';
      case 'fixProblems':
        return trimmed ? `problem fix request: ${trimmed}` : 'problem fix request';
      case 'fixLastFailure':
        return trimmed ? `last-failure fix request: ${trimmed}` : 'last-failure fix request';
      case 'proposeCommand':
        return trimmed ? `command request: ${trimmed}` : 'command request';
      case 'sendPrompt':
      default:
        return trimmed ? `prompt: ${trimmed}` : 'prompt';
    }
  }

  private toUserTranscriptAction(
    kind: FollowUpRequestKind
  ): 'chat' | 'edit' | 'fixProblems' | 'fixLastFailure' | 'command' {
    switch (kind) {
      case 'proposeEdit':
        return 'edit';
      case 'fixProblems':
        return 'fixProblems';
      case 'fixLastFailure':
        return 'fixLastFailure';
      case 'proposeCommand':
        return 'command';
      case 'sendPrompt':
      default:
        return 'chat';
    }
  }

  private async handleBusyFollowUp(request: FollowUpRequest): Promise<boolean> {
    const mode = this.getFollowUpQueueMode();
    const description = this.describeFollowUpRequest(request);

    if (mode === 'interrupt') {
      this.queuedFollowUps.splice(0, this.queuedFollowUps.length, request);
      if (
        this.currentRequestAbortController &&
        !this.currentRequestAbortController.signal.aborted
      ) {
        this.currentRequestAbortController.abort();
        await this.postMessage({
          type: 'systemMessage',
          text: `Interrupted the current run. The latest ${description} will start next.`
        });
        await this.postMessage({
          type: 'setStatus',
          text: 'Interrupting'
        });
        return true;
      }

      await this.postMessage({
        type: 'systemMessage',
        text: `The current run cannot be interrupted. The latest ${description} will run next.`
      });
      await this.postMessage({
        type: 'setStatus',
        text: 'Follow-up queued'
      });
      return true;
    }

    if (mode === 'steer') {
      this.queuedFollowUps.splice(0, this.queuedFollowUps.length, request);
      await this.postMessage({
        type: 'systemMessage',
        text: `Replaced any queued follow-up. The latest ${description} will run next.`
      });
      await this.postMessage({
        type: 'setStatus',
        text: 'Follow-up queued'
      });
      return true;
    }

    this.queuedFollowUps.push(request);
    await this.postMessage({
      type: 'systemMessage',
      text: `Queued follow-up: ${description}`
    });
    await this.postMessage({
      type: 'setStatus',
      text: `Queued (${this.queuedFollowUps.length})`
    });
    return true;
  }

  private async processQueuedFollowUps(): Promise<void> {
    if (this.isBusy || this.queuedFollowUps.length === 0) {
      return;
    }

    const nextRequest = this.queuedFollowUps.shift();
    if (!nextRequest) {
      return;
    }

    const userText = this.getUserTranscriptText(
      this.toUserTranscriptAction(nextRequest.kind),
      nextRequest.text
    );
    if (userText) {
      this.recordTranscriptEntry('user', userText);
      await this.refreshThreadList();
    }

    await this.postMessage({
      type: 'systemMessage',
      text: `Running queued follow-up: ${this.describeFollowUpRequest(nextRequest)}`
    });
    await this.executeFollowUpRequest(nextRequest);
  }

  private async executeFollowUpRequest(request: FollowUpRequest): Promise<void> {
    switch (request.kind) {
      case 'proposeEdit':
        await this.handleProposeEdit(request.text);
        return;
      case 'fixProblems':
        await this.handleFixProblems(request.text);
        return;
      case 'fixLastFailure':
        await this.handleFixLastFailure(request.text);
        return;
      case 'proposeCommand':
        await this.handleProposeCommand(request.text);
        return;
      case 'sendPrompt':
      default:
        await this.handleSendPrompt(request.text);
        return;
    }
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError')
    );
  }

  private async handleProposeEdit(
    rawPrompt: string,
    options?: { forceProblems?: boolean; terminalFailure?: CommandExecutionResult }
  ): Promise<void> {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'Enter an edit instruction before asking for a proposal.'
      });
      return;
    }

    if (this.isBusy) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'A request is already in progress.'
      });
      return;
    }

    this.isBusy = true;
    this.currentRequestAbortController = new AbortController();
    await this.postMessage({
      type: 'setBusy',
      busy: true
    });
    await this.postMessage({
      type: 'setStatus',
      text: 'Drafting edit'
    });

    try {
      const config = this.getConfig();
      const client = new OllamaClient(config.baseUrl);
      const models = await client.listModels(this.currentRequestAbortController.signal);
      if (models.length === 0) {
        throw new Error('No Ollama models are installed yet.');
      }

      const { targets, autoIncludedWorkspaceFiles, workspaceRoot } =
        await this.resolveEditTargets(prompt);
      const selectedModel = this.resolveEditModel(models, config);
      await this.postMessage({
        type: 'setConnection',
        text: `Connected to ${config.baseUrl} | chat: ${this.resolveModel(models, config.model)} | edit: ${selectedModel}`
      });
      await this.postMessage({
        type: 'systemMessage',
        text: `Using edit model ${selectedModel}.`
      });
      if (autoIncludedWorkspaceFiles > 0) {
        await this.postMessage({
          type: 'systemMessage',
          text: `Included ${autoIncludedWorkspaceFiles} related workspace file${autoIncludedWorkspaceFiles === 1 ? '' : 's'} in this edit proposal.`
        });
      }

      const problemsSeed = this.buildWorkspaceQuerySeed(prompt);
      const useProblemsContext =
        options?.forceProblems === true ||
        this.problemsContextState.includeProblems ||
        shouldAutoIncludeProblemsContext(problemsSeed);
      if (useProblemsContext && !this.problemsContextState.includeProblems) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Problems context was auto-enabled for this edit proposal.'
        });
      }
      const problemsContext = captureProblemsContext(problemsSeed, {
        includeProblems: useProblemsContext
      });
      for (const notice of problemsContext.notices) {
        await this.postMessage({
          type: 'systemMessage',
          text: notice
        });
      }
      const terminalFailureContext = buildCommandFailureContextBlock(
        options?.terminalFailure ?? this.getRelevantTerminalResult(prompt)
      );
      const failureFixStyleContext =
        terminalFailureContext || problemsContext.promptBlock
          ? buildFailureFixStyleContextBlock(config.failureFixStyle)
          : undefined;
      if (terminalFailureContext) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Included captured terminal output in this edit proposal.'
        });
      }

      let responseText = '';
      const usingWorkspaceEditSet = targets.length > 1 || this.isFileCreationRequest(prompt);
      await client.streamChat(
        selectedModel,
        usingWorkspaceEditSet
          ? buildWorkspaceEditProposalMessages(targets, prompt, [
              problemsContext.promptBlock,
              terminalFailureContext,
              failureFixStyleContext
            ])
          : buildEditProposalMessages(targets[0], prompt, [
              problemsContext.promptBlock,
              terminalFailureContext,
              failureFixStyleContext
            ]),
        async (text) => {
          responseText += text;
        },
        this.currentRequestAbortController.signal
      );

      let pendingEditSet;
      try {
        pendingEditSet = usingWorkspaceEditSet
          ? createPendingEditSet(
              targets,
              parseWorkspaceEditProposalResponse(responseText),
              prompt,
              workspaceRoot,
              config.failureFixStyle
            )
          : this.buildSinglePendingEditSet(
              targets[0],
              responseText,
              prompt,
              config.failureFixStyle
            );
      } catch (error) {
        const repairReason =
          error instanceof Error ? error.message : 'The proposal format was invalid.';
        await this.postMessage({
          type: 'systemMessage',
          text: 'The model returned an invalid edit proposal. Trying a repair pass.'
        });
        await this.postMessage({
          type: 'setStatus',
          text: 'Repairing proposal'
        });

        let repairedResponseText = '';
        await client.streamChat(
          selectedModel,
          usingWorkspaceEditSet
            ? buildWorkspaceEditRepairMessages(
                targets,
                prompt,
                responseText,
                repairReason,
                [
                  problemsContext.promptBlock,
                  terminalFailureContext,
                  failureFixStyleContext
                ]
              )
            : buildEditRepairMessages(
                targets[0],
                prompt,
                responseText,
                repairReason,
                [
                  problemsContext.promptBlock,
                  terminalFailureContext,
                  failureFixStyleContext
                ]
              ),
          async (text) => {
            repairedResponseText += text;
          },
          this.currentRequestAbortController.signal
        );

        pendingEditSet = usingWorkspaceEditSet
          ? createPendingEditSet(
              targets,
              parseWorkspaceEditProposalResponse(repairedResponseText),
              prompt,
              workspaceRoot,
              config.failureFixStyle
            )
          : this.buildSinglePendingEditSet(
              targets[0],
              repairedResponseText,
              prompt,
              config.failureFixStyle
            );
      }

      const userMessage: ChatMessage = { role: 'user', content: `Propose edit: ${prompt}` };

      if (!pendingEditSet) {
        const assistantMessage = 'The proposed edit did not change the file.';
        this.pendingEditSet = undefined;
        this.pendingEditUsesTerminalFailure = false;
        await this.refreshPendingEdit();
        await this.postMessage({
          type: 'assistantStart'
        });
        await this.postMessage({
          type: 'assistantChunk',
          text: assistantMessage
        });
        await this.postMessage({
          type: 'assistantEnd'
        });
        this.conversation.push(userMessage, {
          role: 'assistant',
          content: assistantMessage
        });
        this.persistCurrentThreadState();
        await this.postMessage({
          type: 'setStatus',
          text: this.getIdleStatusText()
        });
        await this.refreshThreadList();
        return;
      }

      this.pendingEditSet = pendingEditSet;
      this.pendingEditUsesTerminalFailure = Boolean(terminalFailureContext);
      await this.refreshPendingEdit();
      await this.addTaskArtifact({
        kind: 'edit',
        status: 'pending',
        title:
          pendingEditSet.files.length === 1
            ? 'Prepared reviewed edit'
            : `Prepared reviewed change set (${pendingEditSet.files.length} files)`,
        detail: pendingEditSet.summary,
        targets: pendingEditSet.files.map((pendingEdit) => pendingEdit.relativePath)
      });
      const fileCount = pendingEditSet.files.length;
      const header =
        fileCount === 1
          ? `Prepared a pending edit for ${pendingEditSet.files[0].relativePath}.`
          : `Prepared a pending change set for ${fileCount} files.`;
      const applyGuidance =
        fileCount === 1
          ? 'The file has not changed yet. Review it in the pending edit panel, then click Apply to write it.'
          : 'The files have not changed yet. Review them in the pending edit panel, then click Apply to write them.';
      await this.postMessage({
        type: 'assistantStart'
      });
      await this.postMessage({
        type: 'assistantChunk',
        text: `${header}\n${pendingEditSet.summary}\n\n${applyGuidance}`
      });
      await this.postMessage({
        type: 'assistantEnd'
      });
      this.conversation.push(userMessage, {
        role: 'assistant',
        content: `${header} ${pendingEditSet.summary} ${applyGuidance}`
      });
      this.persistCurrentThreadState();
      await this.postMessage({
        type: 'systemMessage',
        text:
          fileCount === 1
            ? 'Use Preview, Apply, or Reject in the pending edit panel.'
            : 'Use Preview on individual files, then Apply or Reject in the pending edit panel.'
      });
      await this.postMessage({
        type: 'setStatus',
        text: this.getIdleStatusText()
      });
      await this.refreshThreadList();
    } catch (error) {
      if (this.isAbortError(error)) {
        return;
      }

      await this.postMessage({
        type: 'systemMessage',
        text: getErrorMessage(error)
      });
      await this.postMessage({
        type: 'setStatus',
        text: 'Error'
      });
      await this.refreshConnectionStatus();
    } finally {
      this.currentRequestAbortController = undefined;
      this.isBusy = false;
      await this.postMessage({
        type: 'setBusy',
        busy: false
      });
      await this.processQueuedFollowUps();
    }
  }

  private async handleFixProblems(rawPrompt: string): Promise<void> {
    const prompt =
      rawPrompt.trim() ||
      'Fix the current workspace problems without changing behavior unless the diagnostics require it.';
    const problemsContext = captureProblemsContext(prompt, {
      includeProblems: true
    });

    if (!problemsContext.promptBlock || problemsContext.counts.total === 0) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There are no workspace problems available to fix right now.'
      });
      return;
    }

    await this.postMessage({
      type: 'systemMessage',
      text: 'Preparing a reviewed edit proposal grounded in current workspace problems.'
    });
    await this.handleProposeEdit(prompt, {
      forceProblems: true
    });
  }

  private async handleFixLastFailure(rawPrompt: string): Promise<void> {
    if (!this.lastFailedCommandResult) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no captured failed command output yet. Run a command in the integrated terminal first.'
      });
      return;
    }

    const prompt =
      rawPrompt.trim() ||
      'Fix the last failed command using its captured terminal output without changing behavior unless the failure requires it.';
    await this.postMessage({
      type: 'systemMessage',
      text: 'Preparing a reviewed edit proposal grounded in the last captured terminal failure.'
    });
    await this.handleProposeEdit(prompt, {
      terminalFailure: this.lastFailedCommandResult
    });
  }

  private async handleProposeCommand(rawPrompt: string): Promise<void> {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'Enter a command request before asking for a terminal suggestion.'
      });
      return;
    }

    if (this.isBusy) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'A request is already in progress.'
      });
      return;
    }

    const config = this.getConfig();
    if (!config.allowTerminal) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'Terminal suggestions are disabled in localAgent.allowTerminal.'
      });
      return;
    }

    this.isBusy = true;
    this.currentRequestAbortController = new AbortController();
    await this.postMessage({
      type: 'setBusy',
      busy: true
    });
    await this.postMessage({
      type: 'setStatus',
      text: 'Drafting command'
    });

    try {
      const client = new OllamaClient(config.baseUrl);
      const models = await client.listModels(this.currentRequestAbortController.signal);
      if (models.length === 0) {
        throw new Error('No Ollama models are installed yet.');
      }

      const target = getCommandTarget();
      const selectedModel = this.resolveModel(models, config.model);
      const editModel = this.resolveEditModel(models, config);
      await this.postMessage({
        type: 'setConnection',
        text: `Connected to ${config.baseUrl} | chat: ${selectedModel} | edit: ${editModel}`
      });
      await this.postMessage({
        type: 'systemMessage',
        text: `Using chat model ${selectedModel} for terminal suggestion.`
      });

      const editorContextState = this.getEffectiveEditorContextState(prompt);
      if (editorContextState.includeCurrentFile && !this.contextState.includeCurrentFile) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Current file context was auto-enabled for this command request.'
        });
      }
      if (editorContextState.includeSelection && !this.contextState.includeSelection) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Selection context was auto-enabled for this command request.'
        });
      }

      const editorContext = captureEditorContext(editorContextState);
      for (const notice of editorContext.notices) {
        await this.postMessage({
          type: 'systemMessage',
          text: notice
        });
      }

      const workspaceSeed = this.buildWorkspaceQuerySeed(prompt);
      const useWorkspaceContext =
        this.workspaceContextState.includeWorkspace ||
        shouldAutoIncludeWorkspaceContext(workspaceSeed);
      const useProblemsContext =
        this.problemsContextState.includeProblems ||
        shouldAutoIncludeProblemsContext(workspaceSeed);

      if (useWorkspaceContext && !this.workspaceContextState.includeWorkspace) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Workspace context was auto-enabled for this command request.'
        });
      }
      if (useProblemsContext && !this.problemsContextState.includeProblems) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Problems context was auto-enabled for this command request.'
        });
      }

      const workspaceContext = await captureWorkspaceContext(workspaceSeed, {
        includeWorkspace: useWorkspaceContext
      });
      for (const notice of workspaceContext.notices) {
        await this.postMessage({
          type: 'systemMessage',
          text: notice
        });
      }
      const problemsContext = captureProblemsContext(workspaceSeed, {
        includeProblems: useProblemsContext
      });
      for (const notice of problemsContext.notices) {
        await this.postMessage({
          type: 'systemMessage',
          text: notice
        });
      }

      const contextBlocks = [
        editorContext.promptBlock,
        workspaceContext.promptBlock,
        problemsContext.promptBlock
      ];
      const groundingWarnings = this.buildGroundingWarnings(
        prompt,
        editorContext.promptBlock,
        editorContextState,
        workspaceContext.promptBlock,
        useWorkspaceContext,
        problemsContext.promptBlock,
        useProblemsContext
      );

      let responseText = '';
      await client.streamChat(
        selectedModel,
        buildCommandProposalMessages(target, prompt, contextBlocks, groundingWarnings),
        async (text) => {
          responseText += text;
        },
        this.currentRequestAbortController.signal
      );

      let proposal;
      try {
        proposal = parseCommandProposalResponse(responseText);
        const validationError = validateCommandProposal(proposal);
        if (validationError) {
          throw new Error(validationError);
        }
      } catch (error) {
        const repairReason =
          error instanceof Error ? error.message : 'The proposal format was invalid.';
        await this.postMessage({
          type: 'systemMessage',
          text: 'The model returned an invalid terminal command proposal. Trying a repair pass.'
        });
        await this.postMessage({
          type: 'setStatus',
          text: 'Repairing command'
        });

        let repairedResponseText = '';
        await client.streamChat(
          selectedModel,
          buildCommandRepairMessages(
            target,
            prompt,
            responseText,
            contextBlocks,
            groundingWarnings,
            repairReason
          ),
          async (text) => {
            repairedResponseText += text;
          },
          this.currentRequestAbortController.signal
        );

        proposal = parseCommandProposalResponse(repairedResponseText);
        const repairedValidationError = validateCommandProposal(proposal);
        if (repairedValidationError) {
          throw new Error(repairedValidationError);
        }
      }

      this.pendingCommand = createPendingCommand(target, proposal);
      await this.refreshPendingCommand();
      await this.addTaskArtifact({
        kind: 'command',
        status: 'pending',
        title: 'Prepared terminal command',
        detail: this.pendingCommand.summary,
        command: this.pendingCommand.command,
        cwdLabel: this.pendingCommand.cwdLabel
      });

      const userMessage: ChatMessage = { role: 'user', content: `Suggest command: ${prompt}` };
      const assistantMessage = [
        `Prepared a pending terminal command.`,
        this.pendingCommand.summary,
        `Command: ${this.pendingCommand.command}`,
        `Run from: ${this.pendingCommand.cwdLabel}`,
        'The command has not run yet. Use Run In Terminal in the pending command panel to execute it.'
      ].join('\n');

      await this.postMessage({
        type: 'assistantStart'
      });
      await this.postMessage({
        type: 'assistantChunk',
        text: assistantMessage
      });
      await this.postMessage({
        type: 'assistantEnd'
      });
      this.conversation.push(userMessage, {
        role: 'assistant',
        content: assistantMessage
      });
      this.persistCurrentThreadState();
      await this.postMessage({
        type: 'systemMessage',
        text: 'Use Run or Reject in the pending command panel.'
      });
      await this.postMessage({
        type: 'setStatus',
        text: this.getIdleStatusText()
      });
      await this.refreshThreadList();
    } catch (error) {
      if (this.isAbortError(error)) {
        return;
      }

      await this.postMessage({
        type: 'systemMessage',
        text: getErrorMessage(error)
      });
      await this.postMessage({
        type: 'setStatus',
        text: 'Error'
      });
      await this.refreshConnectionStatus();
    } finally {
      this.currentRequestAbortController = undefined;
      this.isBusy = false;
      await this.postMessage({
        type: 'setBusy',
        busy: false
      });
      await this.processQueuedFollowUps();
    }
  }

  private async previewPendingEdit(): Promise<void> {
    if (!this.pendingEditSet || this.pendingEditSet.files.length === 0) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending edit to preview.'
      });
      return;
    }

    await this.previewPendingEditFile(this.pendingEditSet.files[0].relativePath);
  }

  private async previewPendingEditFile(path: string): Promise<void> {
    const pendingEdit = this.findPendingEditByPath(path);
    if (!pendingEdit) {
      await this.postMessage({
        type: 'systemMessage',
        text: `There is no pending edit for ${path}.`
      });
      return;
    }

    const originalPreviewUri = pendingEdit.isNewFile
      ? (
          await vscode.workspace.openTextDocument({
            language: pendingEdit.language,
            content: ''
          })
        ).uri
      : pendingEdit.documentUri;
    const previewDocument = await vscode.workspace.openTextDocument({
      language: pendingEdit.language,
      content: pendingEdit.proposedText
    });

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalPreviewUri,
      previewDocument.uri,
      pendingEdit.isNewFile
        ? `${pendingEdit.relativePath} (Local Agent New File Proposal)`
        : `${pendingEdit.relativePath} (Local Agent Proposal)`
    );
  }

  private async openWorkspacePath(path: string): Promise<void> {
    const uri = await this.resolveWorkspacePathUri(path);
    if (!uri) {
      await this.postMessage({
        type: 'systemMessage',
        text: `Could not resolve ${path} in the current workspace.`
      });
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false
    });
  }

  private async applyPendingEdit(): Promise<void> {
    if (!this.pendingEditSet || this.pendingEditSet.files.length === 0) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending edit to apply.'
      });
      return;
    }

    const shouldQueueRerun =
      this.pendingEditUsesTerminalFailure &&
      Boolean(this.lastFailedCommandResult) &&
      Boolean(this.lastRunnableCommand) &&
      !this.pendingCommand;

    const changedFiles: string[] = [];
    const documents = await Promise.all(
      this.pendingEditSet.files.map(async (pendingEdit) => {
        if (!pendingEdit.isNewFile) {
          return vscode.workspace.openTextDocument(pendingEdit.documentUri);
        }

        try {
          return await vscode.workspace.openTextDocument(pendingEdit.documentUri);
        } catch {
          return vscode.workspace.openTextDocument({
            language: pendingEdit.language,
            content: ''
          });
        }
      })
    );

    for (let index = 0; index < this.pendingEditSet.files.length; index += 1) {
      const pendingEdit = this.pendingEditSet.files[index];
      const document = documents[index];
      if (pendingEdit.isNewFile) {
        if (document.getText().length > 0) {
          changedFiles.push(pendingEdit.relativePath);
        }
        continue;
      }

      if (
        document.version !== pendingEdit.originalVersion ||
        document.getText() !== pendingEdit.originalText
      ) {
        changedFiles.push(pendingEdit.relativePath);
      }
    }

    if (changedFiles.length > 0) {
      await this.postMessage({
        type: 'systemMessage',
        text:
          changedFiles.length === 1
            ? `The target file changed after the proposal was generated: ${changedFiles[0]}. Reject this edit and generate a new one.`
            : `Some target files changed after the proposal was generated: ${changedFiles.join(', ')}. Reject this edit and generate a new one.`
      });
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    for (let index = 0; index < this.pendingEditSet.files.length; index += 1) {
      const pendingEdit = this.pendingEditSet.files[index];
      const document = documents[index];
      if (pendingEdit.isNewFile) {
        edit.createFile(pendingEdit.documentUri, {
          ignoreIfExists: false
        });
        edit.insert(
          pendingEdit.documentUri,
          new vscode.Position(0, 0),
          pendingEdit.proposedText
        );
      } else {
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, pendingEdit.proposedText);
      }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'VS Code rejected the pending edit.'
      });
      return;
    }

    const appliedPaths = this.pendingEditSet.files.map((pendingEdit) => pendingEdit.relativePath);
    await this.postMessage({
      type: 'systemMessage',
      text:
        appliedPaths.length === 1
          ? `Applied pending edit to ${appliedPaths[0]}.`
          : `Applied pending edit set to ${appliedPaths.length} files: ${appliedPaths.join(', ')}.`
    });
    await this.addTaskArtifact({
      kind: 'edit',
      status: 'applied',
      title:
        appliedPaths.length === 1
          ? 'Applied reviewed edit'
          : `Applied change set (${appliedPaths.length} files)`,
      detail: this.pendingEditSet.summary,
      targets: appliedPaths
    });
    this.pendingEditSet = undefined;
    this.pendingEditUsesTerminalFailure = false;
    await this.refreshPendingEdit();
    if (shouldQueueRerun && this.lastRunnableCommand) {
      this.pendingCommand = this.createRerunPendingCommand(this.lastRunnableCommand);
      await this.refreshPendingCommand();
      await this.addTaskArtifact({
        kind: 'verification',
        status: 'queued',
        title: 'Prepared verification rerun',
        detail: `Ready to rerun ${this.pendingCommand.command} in ${this.pendingCommand.cwdLabel}.`,
        command: this.pendingCommand.command,
        cwdLabel: this.pendingCommand.cwdLabel
      });
      await this.postMessage({
        type: 'systemMessage',
        text: 'Prepared a rerun of the last failed command. Use Run In Terminal to verify the applied fix.'
      });
    }
    await this.postProblemsNotice();
    await this.postMessage({
      type: 'setStatus',
      text: this.getIdleStatusText()
    });
  }

  private async rejectPendingEdit(): Promise<void> {
    if (!this.pendingEditSet || this.pendingEditSet.files.length === 0) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending edit to reject.'
      });
      return;
    }

    const paths = this.pendingEditSet.files.map((pendingEdit) => pendingEdit.relativePath);
    const summary = this.pendingEditSet.summary;
    this.pendingEditSet = undefined;
    this.pendingEditUsesTerminalFailure = false;
    await this.refreshPendingEdit();
    await this.addTaskArtifact({
      kind: 'edit',
      status: 'rejected',
      title:
        paths.length === 1
          ? 'Rejected reviewed edit'
          : `Rejected change set (${paths.length} files)`,
      detail: summary,
      targets: paths
    });
    await this.postMessage({
      type: 'systemMessage',
      text:
        paths.length === 1
          ? `Rejected pending edit for ${paths[0]}.`
          : `Rejected pending edit set for ${paths.length} files.`
    });
    await this.postMessage({
      type: 'setStatus',
      text: this.getIdleStatusText()
    });
  }

  private async runPendingCommand(): Promise<void> {
    if (!this.pendingCommand) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending terminal command to run.'
      });
      return;
    }

    const config = this.getConfig();
    if (!config.allowTerminal) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'Terminal execution is disabled in localAgent.allowTerminal.'
      });
      return;
    }

    if (this.isBusy) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'A request is already in progress.'
      });
      return;
    }

    this.isBusy = true;
    await this.postMessage({
      type: 'setBusy',
      busy: true
    });
    await this.postMessage({
      type: 'setStatus',
      text: 'Running command'
    });

    const command = this.pendingCommand.command;
    const cwdLabel = this.pendingCommand.cwdLabel;
    const pendingCommand = this.pendingCommand;
    this.pendingCommand = undefined;
    this.lastRunnableCommand = {
      ...pendingCommand,
      id: `${Date.now()}`
    };
    await this.refreshPendingCommand();
    await this.addTaskArtifact({
      kind: 'command',
      status: 'running',
      title: 'Ran terminal command',
      detail: `Running ${command} in ${cwdLabel}.`,
      command,
      cwdLabel
    });

    try {
      const result = await runManagedCommand(pendingCommand);
      this.lastCommandResult = result;
      if (result.failed) {
        this.lastFailedCommandResult = result;
        await this.addTaskArtifact({
          kind: 'command',
          status: 'failed',
          title: 'Command failed',
          detail: `${command} exited with code ${result.exitCode} in ${cwdLabel}.`,
          command,
          cwdLabel
        });
        await this.postMessage({
          type: 'systemMessage',
          text: `Captured failed command output from ${cwdLabel}: ${command} (exit code ${result.exitCode}). Use Fix Last Failure to ground the next edit proposal.`
        });
      } else {
        this.lastFailedCommandResult = undefined;
        await this.addTaskArtifact({
          kind: 'command',
          status: 'succeeded',
          title: 'Command completed',
          detail: `${command} completed successfully in ${cwdLabel}.`,
          command,
          cwdLabel
        });
        await this.postMessage({
          type: 'systemMessage',
          text: `Command completed successfully from ${cwdLabel}: ${command}`
        });
      }

      this.persistCurrentThreadState();
      await this.postProblemsNotice();
      await this.postMessage({
        type: 'setStatus',
        text: this.getIdleStatusText()
      });
    } finally {
      this.isBusy = false;
      await this.postMessage({
        type: 'setBusy',
        busy: false
      });
      await this.processQueuedFollowUps();
    }
  }

  private async rejectPendingCommand(): Promise<void> {
    if (!this.pendingCommand) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending terminal command to reject.'
      });
      return;
    }

    const command = this.pendingCommand.command;
    const cwdLabel = this.pendingCommand.cwdLabel;
    this.pendingCommand = undefined;
    await this.refreshPendingCommand();
    await this.addTaskArtifact({
      kind: 'command',
      status: 'rejected',
      title: 'Rejected terminal command',
      detail: `Did not run ${command} from ${cwdLabel}.`,
      command,
      cwdLabel
    });
    await this.postMessage({
      type: 'systemMessage',
      text: `Rejected pending terminal command: ${command}`
    });
    await this.postMessage({
      type: 'setStatus',
      text: this.getIdleStatusText()
    });
  }

  private async postMessage(message: ExtensionToWebviewMessage): Promise<void> {
    if (message.type === 'systemMessage') {
      this.recordTranscriptEntry('system', message.text);
    } else if (message.type === 'assistantStart') {
      this.activeAssistantTranscript = '';
    } else if (message.type === 'assistantChunk') {
      this.activeAssistantTranscript += message.text;
    } else if (message.type === 'assistantEnd') {
      if (this.activeAssistantTranscript.trim()) {
        this.recordTranscriptEntry('assistant', this.activeAssistantTranscript);
      }
      this.activeAssistantTranscript = '';
    }

    if (this.views.size === 0) {
      return;
    }

    for (const view of this.views.values()) {
      await view.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Local Agent</title>
  </head>
  <body>
    <div class="app">
      <aside class="thread-rail" aria-label="Threads">
        <div class="thread-rail-header">
          <div>
            <p class="eyebrow">Threads</p>
            <h2 class="thread-rail-title">Session</h2>
          </div>
          <button id="new-thread-button" type="button" class="topbar-button subtle">New</button>
        </div>
        <div id="thread-list" class="thread-list"></div>
      </aside>

      <div class="main-panel">
        <header class="topbar">
          <div class="topbar-main">
            <p class="eyebrow">Local Agent</p>
            <h1>Chat</h1>
            <p id="connection" class="connection">Checking local Ollama...</p>
          </div>
          <div class="topbar-actions">
            <button id="find-thread-button" type="button" class="topbar-button subtle">Find</button>
            <span id="status" class="status">Booting</span>
          </div>
        </header>

        <section id="find-bar" class="find-bar hidden" aria-label="Find in thread">
          <input
            id="find-input"
            type="search"
            class="find-input"
            placeholder="Find in thread"
          />
          <span id="find-count" class="find-count">0 / 0</span>
          <div class="find-actions">
            <button id="find-prev-button" type="button" class="topbar-button subtle">Prev</button>
            <button id="find-next-button" type="button" class="topbar-button subtle">Next</button>
            <button id="find-close-button" type="button" class="topbar-button subtle">Close</button>
          </div>
        </section>

        <section class="workspace-strip" aria-label="Workspace tools">
          <section class="context-panel" aria-label="Prompt context">
            <button type="button" class="context-chip" data-context-target="currentFile">
              <span class="context-chip-title">Current file</span>
              <span id="current-file-detail" class="context-chip-detail">No active editor</span>
            </button>
            <button type="button" class="context-chip" data-context-target="selection">
              <span class="context-chip-title">Selection</span>
              <span id="selection-detail" class="context-chip-detail">No active editor</span>
            </button>
            <button type="button" class="context-chip" data-context-target="workspace">
              <span class="context-chip-title">Workspace</span>
              <span id="workspace-detail" class="context-chip-detail">No workspace folder open</span>
            </button>
            <button type="button" class="context-chip" data-context-target="problems">
              <span class="context-chip-title">Problems</span>
              <span id="problems-detail" class="context-chip-detail">No problems</span>
            </button>
          </section>

          <section id="pending-edit" class="pending-edit hidden" aria-label="Pending edit">
            <div class="pending-edit-header">
              <p class="pending-edit-eyebrow">Pending Edit</p>
              <h2 id="pending-edit-path" class="pending-edit-path">No pending edit</h2>
            </div>
            <p id="pending-edit-summary" class="pending-edit-summary"></p>
            <p id="pending-edit-stats" class="pending-edit-stats"></p>
            <div id="pending-edit-files" class="pending-edit-files"></div>
            <div class="pending-edit-actions">
              <button type="button" data-pending-edit-action="apply">Apply</button>
              <button type="button" data-pending-edit-action="reject" class="subtle">Reject</button>
            </div>
          </section>

          <section id="pending-command" class="pending-command hidden" aria-label="Pending terminal command">
            <div class="pending-edit-header">
              <p class="pending-edit-eyebrow">Pending Command</p>
              <h2 id="pending-command-summary" class="pending-edit-path">No pending terminal command</h2>
            </div>
            <pre id="pending-command-text" class="pending-command-text"></pre>
            <p id="pending-command-cwd" class="pending-edit-stats"></p>
            <div class="pending-edit-actions">
              <button type="button" data-pending-command-action="run">Run In Terminal</button>
              <button type="button" data-pending-command-action="reject" class="subtle">Reject</button>
            </div>
          </section>

          <section id="task-history" class="task-history hidden" aria-label="Run history">
            <div class="pending-edit-header">
              <p class="pending-edit-eyebrow">Run History</p>
              <h2 id="task-history-title" class="pending-edit-path">No recent runs</h2>
            </div>
            <div id="task-history-list" class="task-history-list"></div>
          </section>
        </section>

        <main id="transcript" class="transcript" aria-live="polite">
          <section class="empty-state">
            <h2>Ask, edit, run, review</h2>
            <p>Use chat for repo questions, reviewed edits, terminal suggestions, and failure-driven fixes.</p>
          </section>
        </main>

        <form id="composer" class="composer">
          <section id="action-dock" class="action-dock hidden" aria-label="Quick actions">
            <div class="action-dock-copy">
              <p id="action-dock-eyebrow" class="pending-edit-eyebrow">Quick Actions</p>
              <p id="action-dock-title" class="action-dock-title">No pending action</p>
            </div>
            <div class="action-dock-actions">
              <button id="action-dock-primary" type="button">Apply</button>
              <button id="action-dock-secondary" type="button" class="subtle">Reject</button>
            </div>
          </section>

          <textarea
            id="prompt"
            rows="5"
            placeholder="Ask the local agent something..."
          ></textarea>
          <div class="composer-footer">
            <p id="composer-hint" class="composer-hint">Enter sends for single-line prompts. Shift+Enter adds a new line.</p>
            <div class="composer-actions">
              <button type="submit" data-submit-action="chat">Send</button>
              <button type="submit" data-submit-action="edit" class="subtle">Propose Edit</button>
              <button type="submit" data-submit-action="fixProblems" class="subtle">Fix Problems</button>
              <button type="submit" data-submit-action="fixLastFailure" class="subtle">Fix Last Failure</button>
              <button type="submit" data-submit-action="command" class="subtle">Suggest Command</button>
            </div>
          </div>
        </form>
      </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private getConfig(): {
    baseUrl: string;
    model: string;
    editModel: string;
    failureFixStyle: FailureFixStyle;
    allowTerminal: boolean;
    openOnStartup: boolean;
    composerEnterBehavior: ComposerEnterBehavior;
  } {
    const configuration = vscode.workspace.getConfiguration('localAgent');
    return {
      baseUrl: configuration.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434'),
      model: configuration.get<string>('model', '').trim(),
      editModel: configuration.get<string>('editModel', '').trim(),
      failureFixStyle: this.getFailureFixStyle(),
      allowTerminal: configuration.get<boolean>('allowTerminal', true),
      openOnStartup: configuration.get<boolean>('openOnStartup', false),
      composerEnterBehavior: this.getComposerEnterBehavior()
    };
  }

  private getFailureFixStyle(): FailureFixStyle {
    const style = vscode.workspace
      .getConfiguration('localAgent')
      .get<string>('failureFixStyle', 'preserveTypes');

    switch (style) {
      case 'minimal':
      case 'validateInput':
      case 'preserveTypes':
      case 'noExceptionSwallowing':
        return style;
      default:
        return 'preserveTypes';
    }
  }

  private getComposerEnterBehavior(): ComposerEnterBehavior {
    const behavior = vscode.workspace
      .getConfiguration('localAgent')
      .get<string>('composerEnterBehavior', 'cmdIfMultiline');

    return behavior === 'enter' ? 'enter' : 'cmdIfMultiline';
  }

  private resolveModel(models: string[], configuredModel: string): string {
    if (!configuredModel) {
      return models[0];
    }

    return models.includes(configuredModel) ? configuredModel : models[0];
  }

  private resolveEditModel(
    models: string[],
    config: { model: string; editModel: string }
  ): string {
    if (config.editModel && models.includes(config.editModel)) {
      return config.editModel;
    }

    const chatModel = this.resolveModel(models, config.model);
    if (this.isSuitableEditModel(chatModel)) {
      return chatModel;
    }

    const ranked = [...models]
      .filter((model) => !/embed/i.test(model))
      .sort((left, right) => this.scoreEditModel(right) - this.scoreEditModel(left));

    return ranked[0] ?? chatModel;
  }

  private isSuitableEditModel(model: string): boolean {
    const size = this.extractModelSizeB(model);
    if (size !== undefined) {
      return size >= 6;
    }

    return /(coder|code|deepseek)/i.test(model) && !/embed/i.test(model);
  }

  private scoreEditModel(model: string): number {
    let score = 0;
    const lower = model.toLowerCase();
    const size = this.extractModelSizeB(model);

    if (/embed/.test(lower)) {
      return -1000;
    }

    if (/coder|code|deepseek/.test(lower)) {
      score += 60;
    }

    if (size !== undefined) {
      if (size >= 6 && size <= 8) {
        score += 60;
      } else if (size > 8 && size <= 16) {
        score += 55;
      } else if (size >= 3) {
        score += 30;
      }
    }

    if (/qwen/.test(lower)) {
      score += 5;
    }

    return score;
  }

  private extractModelSizeB(model: string): number | undefined {
    const match = model.match(/(\d+(?:\.\d+)?)b\b/i);
    if (!match) {
      return undefined;
    }

    const size = Number.parseFloat(match[1]);
    return Number.isFinite(size) ? size : undefined;
  }

  private buildRequestMessages(
    userMessage: ChatMessage,
    contextBlocks: Array<string | undefined>,
    groundingWarnings: string[]
  ): ChatMessage[] {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a local coding assistant inside VS Code. Answer clearly, use any provided context, and never invent file names, search results, code, or workspace facts that are not grounded in the provided context.'
      },
      ...this.conversation
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

    messages.push(userMessage);
    return messages;
  }

  private buildWorkspaceQuerySeed(currentPrompt: string): string {
    const recentUserMessages = this.conversation
      .filter((message) => message.role === 'user')
      .slice(-2)
      .map((message) => message.content);

    return [currentPrompt, ...recentUserMessages].join('\n');
  }

  private async buildDirectFileListReply(prompt: string): Promise<string | undefined> {
    if (isReferentialFileListRequest(prompt) && this.lastWorkspaceFileList) {
      return formatWorkspaceFileListReply(this.lastWorkspaceFileList);
    }

    if (!isDirectFileListRequest(prompt)) {
      return undefined;
    }

    const matches = await collectRequestedFileLists(prompt);
    if (matches.length === 0) {
      this.lastWorkspaceFileList = undefined;
      return 'I did not find matching files in the current workspace.';
    }

    this.lastWorkspaceFileList = matches;
    return formatWorkspaceFileListReply(matches);
  }

  private async resolveEditTargets(prompt: string): Promise<{
    targets: EditTarget[];
    autoIncludedWorkspaceFiles: number;
    workspaceRoot?: string;
  }> {
    const targets: EditTarget[] = [];
    const seenPaths = new Set<string>();
    let activeTarget: EditTarget | undefined;
    const workspaceSeed = this.buildWorkspaceQuerySeed(prompt);
    const useWorkspaceContext =
      this.workspaceContextState.includeWorkspace ||
      shouldAutoIncludeWorkspaceContext(workspaceSeed) ||
      this.isFileCreationRequest(prompt);

    try {
      activeTarget = getActiveEditTarget();
      targets.push(activeTarget);
      seenPaths.add(this.normalizeWorkspacePath(activeTarget.relativePath));
    } catch (error) {
      if (!useWorkspaceContext) {
        throw error;
      }
    }

    if (useWorkspaceContext) {
      const candidates = await collectWorkspaceEditCandidates(workspaceSeed, {
        excludePaths: activeTarget ? [activeTarget.relativePath] : []
      });

      for (const candidate of candidates) {
        const normalizedPath = this.normalizeWorkspacePath(candidate.path);
        if (seenPaths.has(normalizedPath)) {
          continue;
        }

        const document = await vscode.workspace.openTextDocument(candidate.uri);
        targets.push({
          documentUri: document.uri,
          relativePath: candidate.path,
          language: document.languageId || 'plaintext',
          originalText: document.getText(),
          version: document.version
        });
        seenPaths.add(normalizedPath);
      }
    }

    if (targets.length === 0) {
      if (this.isFileCreationRequest(prompt) && vscode.workspace.workspaceFolders?.length) {
        return {
          targets,
          autoIncludedWorkspaceFiles: 0,
          workspaceRoot: vscode.workspace.workspaceFolders[0].uri.fsPath
        };
      }

      throw new Error(
        'Open a file in the editor or use a workspace-scoped edit prompt so the agent can gather target files.'
      );
    }

    const primaryWorkspaceFolder =
      vscode.workspace.getWorkspaceFolder(targets[0].documentUri) ??
      vscode.workspace.workspaceFolders?.[0];

    return {
      targets,
      autoIncludedWorkspaceFiles: Math.max(0, targets.length - (activeTarget ? 1 : 0)),
      workspaceRoot: primaryWorkspaceFolder?.uri.fsPath
    };
  }

  private buildSinglePendingEditSet(
    target: EditTarget,
    responseText: string,
    prompt: string,
    failureFixStyle: FailureFixStyle = 'minimal'
  ): PendingEditSet | undefined {
    const proposal = parseEditProposalResponse(responseText, target);
    const validationError = validateEditProposal(target, proposal, prompt, failureFixStyle);
    if (validationError) {
      throw new Error(validationError);
    }

    const pendingEdit = createPendingEdit(target, proposal);
    if (!pendingEdit) {
      return undefined;
    }

    return {
      id: pendingEdit.id,
      summary: pendingEdit.summary,
      files: [pendingEdit]
    };
  }

  private findPendingEditByPath(path: string): PendingEdit | undefined {
    const normalizedPath = this.normalizeWorkspacePath(path);
    return this.pendingEditSet?.files.find(
      (pendingEdit) =>
        this.normalizeWorkspacePath(pendingEdit.relativePath) === normalizedPath
    );
  }

  private async resolveWorkspacePathUri(path: string): Promise<vscode.Uri | undefined> {
    const pendingEdit = this.findPendingEditByPath(path);
    if (pendingEdit) {
      return pendingEdit.documentUri;
    }

    const normalizedPath = this.normalizeWorkspacePath(path);
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of workspaceFolders) {
      const candidate = vscode.Uri.joinPath(folder.uri, path);
      try {
        await vscode.workspace.fs.stat(candidate);
        return candidate;
      } catch {
        continue;
      }
    }

    if (workspaceFolders.length === 1) {
      return vscode.Uri.joinPath(workspaceFolders[0].uri, path);
    }

    const matches = await vscode.workspace.findFiles(`**/${path.replace(/\\/g, '/')}`, undefined, 2);
    if (matches.length > 0) {
      const exactMatch = matches.find(
        (candidate) =>
          this.normalizeWorkspacePath(vscode.workspace.asRelativePath(candidate, false)) ===
          normalizedPath
      );
      return exactMatch ?? matches[0];
    }

    return undefined;
  }

  private formatPendingEditStats(pendingEdit: PendingEdit): string {
    if (pendingEdit.isNewFile) {
      return `new file | 0 lines -> ${pendingEdit.stats.proposedLines} lines (+${pendingEdit.stats.proposedLines}).`;
    }

    const deltaPrefix = pendingEdit.stats.deltaLines > 0 ? '+' : '';

    return `${pendingEdit.stats.originalLines} lines -> ${pendingEdit.stats.proposedLines} lines (${deltaPrefix}${pendingEdit.stats.deltaLines}).`;
  }

  private formatPendingEditSetStats(pendingEditSet: PendingEditSet): string {
    const originalLines = pendingEditSet.files.reduce(
      (total, pendingEdit) => total + pendingEdit.stats.originalLines,
      0
    );
    const proposedLines = pendingEditSet.files.reduce(
      (total, pendingEdit) => total + pendingEdit.stats.proposedLines,
      0
    );
    const deltaLines = proposedLines - originalLines;
    const deltaPrefix = deltaLines > 0 ? '+' : '';

    return `${pendingEditSet.files.length} file${pendingEditSet.files.length === 1 ? '' : 's'} | ${originalLines} lines -> ${proposedLines} lines (${deltaPrefix}${deltaLines}).`;
  }

  private getPendingEditSetTitle(pendingEditSet: PendingEditSet): string {
    return pendingEditSet.files.length === 1
      ? pendingEditSet.files[0].relativePath
      : `${pendingEditSet.files.length} files`;
  }

  private buildGroundingWarnings(
    prompt: string,
    editorContext?: string,
    editorContextState?: EditorContextState,
    workspaceContext?: string,
    usedWorkspaceContext = false,
    problemsContext?: string,
    usedProblemsContext = false
  ): string[] {
    const warnings: string[] = [];

    if (usedWorkspaceContext && !workspaceContext) {
      warnings.push(
        'No grounded workspace results were found for this turn. If the user asks for exact file names or repository facts, say that you cannot verify them from the current context.'
      );
    }

    if (
      (editorContextState?.includeCurrentFile || editorContextState?.includeSelection) &&
      !editorContext
    ) {
      warnings.push(
        'Requested editor context was not available for this turn. Do not claim details from the active file or selection unless they were explicitly provided.'
      );
    }

    if (
      usedProblemsContext &&
      !problemsContext &&
      shouldWarnAboutMissingProblemsContext(prompt)
    ) {
      warnings.push(
        'No workspace diagnostics were available for this turn. If the user asks you to fix current problems, say that you cannot verify any active diagnostics from the current context.'
      );
    }

    return warnings;
  }

  private getIdleStatusText(): string {
    if (this.pendingEditSet && this.pendingCommand) {
      return 'Pending approvals';
    }

    if (this.pendingEditSet) {
      return 'Pending edit';
    }

    if (this.pendingCommand) {
      return 'Pending command';
    }

    return 'Idle';
  }

  private createRerunPendingCommand(command: PendingCommand): PendingCommand {
    return {
      id: `${Date.now()}`,
      summary: 'Rerun the last failed command to verify the applied fix.',
      command: command.command,
      cwd: command.cwd,
      cwdLabel: command.cwdLabel
    };
  }

  private normalizeWorkspacePath(path: string): string {
    return path.replace(/\\/g, '/').toLowerCase();
  }

  private async postProblemsNotice(): Promise<void> {
    const notice = getWorkspaceProblemsNotice();
    if (!notice) {
      return;
    }

    await this.postMessage({
      type: 'systemMessage',
      text: notice
    });
  }

  private shouldAutoRouteToEditProposal(prompt: string): boolean {
    return (
      this.isFileCreationRequest(prompt) ||
      this.isProblemFixRequest(prompt) ||
      (this.isDirectApplyFixRequest(prompt) && this.hasEditableContext())
    );
  }

  private hasEditableContext(): boolean {
    return Boolean(this.getPreferredFileEditor() || this.lastFailedCommandResult);
  }

  private getEffectiveEditorContextState(prompt: string): EditorContextState {
    return {
      includeCurrentFile:
        this.contextState.includeCurrentFile || this.shouldAutoIncludeCurrentFileContext(prompt),
      includeSelection:
        this.contextState.includeSelection || this.shouldAutoIncludeSelectionContext(prompt)
    };
  }

  private shouldAutoRouteToLastFailure(prompt: string): boolean {
    return Boolean(this.lastFailedCommandResult) && this.isLastFailureRequest(prompt);
  }

  private async tryHandlePendingActionPrompt(prompt: string): Promise<boolean> {
    if (this.pendingEditSet) {
      if (this.isPendingEditPreviewRequest(prompt)) {
        await this.previewPendingEdit();
        return true;
      }

      if (this.isPendingEditApplyRequest(prompt)) {
        await this.applyPendingEdit();
        return true;
      }

      if (this.isPendingEditRejectRequest(prompt)) {
        await this.rejectPendingEdit();
        return true;
      }
    }

    if (this.pendingCommand) {
      if (this.isPendingCommandRunRequest(prompt)) {
        await this.runPendingCommand();
        return true;
      }

      if (this.isPendingCommandRejectRequest(prompt)) {
        await this.rejectPendingCommand();
        return true;
      }
    }

    return false;
  }

  private shouldAutoIncludeCurrentFileContext(prompt: string): boolean {
    const editor = this.getPreferredFileEditor();
    if (!editor) {
      return false;
    }

    const normalizedPrompt = prompt.toLowerCase();
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/');
    const baseName = relativePath.split('/').pop() ?? relativePath;

    if (
      /\b(open|opened|active|current|this)\s+file\b/i.test(prompt) ||
      /\b(open|opened|active|current|this)\s+code\b/i.test(prompt) ||
      /\b(read|show|inspect|analyze|explain|review|summarize|look at)\b[\s\S]{0,40}\b(file|code)\b/i.test(
        prompt
      ) ||
      /\bcan you read\b[\s\S]{0,40}\b(file|code)\b/i.test(prompt)
    ) {
      return true;
    }

    return (
      normalizedPrompt.includes(relativePath.toLowerCase()) ||
      normalizedPrompt.includes(baseName.toLowerCase())
    );
  }

  private shouldAutoIncludeSelectionContext(prompt: string): boolean {
    return /\b(selection|selected|highlighted)\b|\bthis snippet\b|\bthese lines\b/i.test(prompt);
  }

  private isFileCreationRequest(prompt: string): boolean {
    return /\b(create|add|new)\b[\s\S]{0,80}\b(file|module|script|component)\b|\b(create|add|new)\b[\s\S]{0,40}\b[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+\b/i.test(
      prompt
    );
  }

  private isProblemFixRequest(prompt: string): boolean {
    return /\b(?:fix|resolve|address)\b[\s\S]{0,80}\b(problem|problems|error|errors|warning|warnings|diagnostic|diagnostics|failure|failures|failing|test|tests)\b/i.test(
      prompt
    );
  }

  private isDirectApplyFixRequest(prompt: string): boolean {
    return /^\s*(?:apply|use|make|do)\b[\s\S]{0,24}\b(?:fix|fixes|change|changes|edit|edits|patch|patches)\b/i.test(
      prompt
    );
  }

  private isLastFailureRequest(prompt: string): boolean {
    return /\b(last|recent|latest)\b[\s\S]{0,20}\b(failure|error|command)\b|\bfix\b[\s\S]{0,20}\b(last|recent|latest)\b[\s\S]{0,20}\b(failure|error)\b/i.test(
      prompt
    );
  }

  private isPendingEditPreviewRequest(prompt: string): boolean {
    return /^\s*(preview|show|open|view)(?:\s+the)?(?:\s+pending)?(?:\s+(?:edit(?:s)?|diff(?:s)?|patch(?:es)?|change(?:s)?|fix(?:es)?|proposal(?:s)?))?(?:\s+for)?(?:\s+(?:it|them|this|that))?\s*$/i.test(
      prompt
    );
  }

  private isPendingEditApplyRequest(prompt: string): boolean {
    return /^\s*(apply|accept|use)(?:\s+the)?(?:\s+pending)?(?:\s+(?:edit(?:s)?|patch(?:es)?|change(?:s)?|fix(?:es)?|proposal(?:s)?))?(?:\s+for)?(?:\s+(?:it|them|this|that))?\s*$/i.test(
      prompt
    );
  }

  private isPendingEditRejectRequest(prompt: string): boolean {
    return /^\s*(reject|discard|cancel)(?:\s+the)?(?:\s+pending)?(?:\s+(?:edit(?:s)?|patch(?:es)?|change(?:s)?|fix(?:es)?|proposal(?:s)?))?(?:\s+for)?(?:\s+(?:it|them|this|that))?\s*$/i.test(
      prompt
    );
  }

  private isPendingCommandRunRequest(prompt: string): boolean {
    return /^\s*(run|execute)(?:\s+the)?(?:\s+pending)?(?:\s+(?:command(?:s)?|terminal command(?:s)?))?(?:\s+for)?(?:\s+(?:it|them|this|that))?\s*$/i.test(
      prompt
    );
  }

  private isPendingCommandRejectRequest(prompt: string): boolean {
    return /^\s*(reject|discard|cancel)(?:\s+the)?(?:\s+pending)?(?:\s+(?:command(?:s)?|terminal command(?:s)?))?(?:\s+for)?(?:\s+(?:it|them|this|that))?\s*$/i.test(
      prompt
    );
  }

  private isTerminalReadRequest(prompt: string): boolean {
    return /\bterminal\b|\bconsole\b|\btraceback\b|\bstderr\b|\bstdout\b|\bcommand output\b|\blast command\b/i.test(
      prompt
    );
  }

  private getRelevantTerminalResult(prompt: string): CommandExecutionResult | undefined {
    if (this.isLastFailureRequest(prompt)) {
      return this.lastFailedCommandResult;
    }

    if (this.isTerminalReadRequest(prompt)) {
      return this.lastCommandResult ?? this.lastFailedCommandResult;
    }

    return undefined;
  }

  private createRunnableCommandFromExecution(
    result: CommandExecutionResult
  ): PendingCommand {
    return {
      id: `${Date.now()}`,
      summary: 'Rerun the last terminal command.',
      command: result.command,
      cwd: result.cwdPath ? vscode.Uri.file(result.cwdPath) : undefined,
      cwdLabel: result.cwdLabel
    };
  }

  private isRerunnableTerminalCommand(
    commandLine: vscode.TerminalShellExecutionCommandLine
  ): boolean {
    return (
      commandLine.isTrusted ||
      commandLine.confidence >= vscode.TerminalShellExecutionCommandLineConfidence.Medium
    );
  }

  private isSameTerminalCommand(
    left: CommandExecutionResult,
    right: CommandExecutionResult
  ): boolean {
    return left.command === right.command && left.cwdPath === right.cwdPath;
  }

  private async captureTerminalExecutionOutput(
    execution: vscode.TerminalShellExecution
  ): Promise<string> {
    let output = '';

    try {
      for await (const chunk of execution.read()) {
        output = this.appendCapturedTerminalOutput(output, chunk);
      }
    } catch {
      return this.stripCapturedTerminalOutput(output);
    }

    return this.stripCapturedTerminalOutput(output);
  }

  private appendCapturedTerminalOutput(existing: string, next: string): string {
    const combined = `${existing}${next}`;
    if (combined.length <= MAX_CAPTURED_TERMINAL_OUTPUT_CHARS) {
      return combined;
    }

    return combined.slice(combined.length - MAX_CAPTURED_TERMINAL_OUTPUT_CHARS);
  }

  private stripCapturedTerminalOutput(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
  }

  private getPreferredFileEditor(): vscode.TextEditor | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      return activeEditor;
    }

    return (
      vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === 'file') ??
      activeEditor
    );
  }
}

function getNonce(): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 32; index += 1) {
    nonce += charset.charAt(Math.floor(Math.random() * charset.length));
  }

  return nonce;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error.';
}
