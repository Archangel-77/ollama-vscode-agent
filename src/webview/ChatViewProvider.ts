import * as vscode from 'vscode';
import {
  captureEditorContext,
  EditorContextState,
  EditorContextSummary,
  getEditorContextSummary
} from '../context/EditorContext';
import {
  captureWorkspaceContext,
  collectRequestedFileLists,
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
  buildEditProposalMessages,
  buildEditRepairMessages,
  createPendingEdit,
  getActiveEditTarget,
  parseEditProposalResponse,
  PendingEdit,
  validateEditProposal
} from '../edit/EditProposal';
import { ChatMessage, OllamaClient } from '../ollama/OllamaClient';
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
  | { type: 'sendPrompt'; text: string }
  | { type: 'proposeEdit'; text: string }
  | { type: 'proposeCommand'; text: string }
  | { type: 'previewPendingEdit' }
  | { type: 'applyPendingEdit' }
  | { type: 'rejectPendingEdit' }
  | { type: 'runPendingCommand' }
  | { type: 'rejectPendingCommand' }
  | {
      type: 'setContextEnabled';
      target: 'currentFile' | 'selection' | 'workspace';
      enabled: boolean;
    };

type PromptContextSummary = EditorContextSummary & WorkspaceContextSummary;

type ExtensionToWebviewMessage =
  | { type: 'systemMessage'; text: string }
  | { type: 'setStatus'; text: string }
  | { type: 'setBusy'; busy: boolean }
  | { type: 'setConnection'; text: string }
  | { type: 'setContextState'; context: PromptContextSummary }
  | {
      type: 'setPendingEdit';
      pendingEdit:
        | {
            path: string;
            summary: string;
            statsText: string;
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

  private view?: vscode.WebviewView;
  private readonly conversation: ChatMessage[] = [];
  private isBusy = false;
  private readonly contextState: EditorContextState = {
    includeCurrentFile: false,
    includeSelection: false
  };
  private readonly workspaceContextState: WorkspaceContextState = {
    includeWorkspace: false
  };
  private lastWorkspaceFileList?: WorkspaceFileListMatch[];
  private pendingEdit?: PendingEdit;
  private pendingCommand?: PendingCommand;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public focus(): void {
    this.view?.show?.(false);
  }

  public async setCurrentFileContextEnabled(enabled: boolean): Promise<void> {
    this.contextState.includeCurrentFile = enabled;
    await this.refreshEditorContext();
    await this.postMessage({
      type: 'systemMessage',
      text: enabled ? 'Current file context enabled.' : 'Current file context disabled.'
    });
  }

  public async setSelectionContextEnabled(enabled: boolean): Promise<void> {
    this.contextState.includeSelection = enabled;
    await this.refreshEditorContext();
    await this.postMessage({
      type: 'systemMessage',
      text: enabled ? 'Selection context enabled.' : 'Selection context disabled.'
    });
  }

  public async setWorkspaceContextEnabled(enabled: boolean): Promise<void> {
    this.workspaceContextState.includeWorkspace = enabled;
    await this.refreshEditorContext();
    await this.postMessage({
      type: 'systemMessage',
      text: enabled ? 'Workspace context enabled.' : 'Workspace context disabled.'
    });
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
        ...getWorkspaceContextSummary(this.workspaceContextState)
      }
    });
  }

  public async refreshPendingEdit(): Promise<void> {
    await this.postMessage({
      type: 'setPendingEdit',
      pendingEdit: this.pendingEdit
        ? {
            path: this.pendingEdit.relativePath,
            summary: this.pendingEdit.summary,
            statsText: this.formatPendingEditStats(this.pendingEdit)
          }
        : null
    });
  }

  public async refreshPendingCommand(): Promise<void> {
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
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postMessage({
          type: 'systemMessage',
          text: 'Local Agent is ready. Start Ollama locally to enable streamed chat.'
        });
        await this.refreshConnectionStatus();
        await this.refreshEditorContext();
        await this.refreshPendingEdit();
        await this.refreshPendingCommand();
        return;
      case 'previewPendingEdit':
        await this.previewPendingEdit();
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
        } else {
          this.workspaceContextState.includeWorkspace = message.enabled;
        }

        await this.refreshEditorContext();
        return;
      case 'proposeEdit':
        await this.handleProposeEdit(message.text);
        return;
      case 'proposeCommand':
        await this.handleProposeCommand(message.text);
        return;
      case 'sendPrompt': {
        const prompt = message.text.trim();
        if (!prompt) {
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
          text: 'Connecting'
        });

        try {
          const config = this.getConfig();
          const client = new OllamaClient(config.baseUrl);
          const models = await client.listModels();

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

          const editorContext = captureEditorContext(this.contextState);
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
            await this.postMessage({
              type: 'setStatus',
              text: this.getIdleStatusText()
            });
            return;
          }

          await this.postMessage({
            type: 'assistantStart'
          });

          const workspaceSeed = this.buildWorkspaceQuerySeed(prompt);
          const useWorkspaceContext =
            this.workspaceContextState.includeWorkspace ||
            shouldAutoIncludeWorkspaceContext(workspaceSeed);

          if (useWorkspaceContext && !this.workspaceContextState.includeWorkspace) {
            await this.postMessage({
              type: 'systemMessage',
              text: 'Workspace context was auto-enabled for this prompt.'
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

          const messages = this.buildRequestMessages(userMessage, [
            editorContext.promptBlock,
            workspaceContext.promptBlock
          ], this.buildGroundingWarnings(
            editorContext.promptBlock,
            workspaceContext.promptBlock,
            useWorkspaceContext
          ));
          let assistantContent = '';

          await client.streamChat(selectedModel, messages, async (text) => {
            assistantContent += text;
            await this.postMessage({
              type: 'assistantChunk',
              text
            });
          });

          this.conversation.push(userMessage, {
            role: 'assistant',
            content: assistantContent
          });
          await this.postMessage({
            type: 'assistantEnd'
          });
          await this.postMessage({
            type: 'setStatus',
            text: this.getIdleStatusText()
          });
        } catch (error) {
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
          this.isBusy = false;
          await this.postMessage({
            type: 'setBusy',
            busy: false
          });
        }

        return;
      }
    }
  }

  private async handleProposeEdit(rawPrompt: string): Promise<void> {
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
      const models = await client.listModels();
      if (models.length === 0) {
        throw new Error('No Ollama models are installed yet.');
      }

      const target = getActiveEditTarget();
      const selectedModel = this.resolveEditModel(models, config);
      await this.postMessage({
        type: 'setConnection',
        text: `Connected to ${config.baseUrl} | chat: ${this.resolveModel(models, config.model)} | edit: ${selectedModel}`
      });
      await this.postMessage({
        type: 'systemMessage',
        text: `Using edit model ${selectedModel}.`
      });

      let responseText = '';
      await client.streamChat(
        selectedModel,
        buildEditProposalMessages(target, prompt),
        async (text) => {
          responseText += text;
        }
      );

      let proposal;
      try {
        proposal = parseEditProposalResponse(responseText, target);
        const validationError = validateEditProposal(target, proposal, prompt);
        if (validationError) {
          throw new Error(validationError);
        }
      } catch (error) {
        const repairReason =
          error instanceof Error ? error.message : 'The proposal format was invalid.';
        await this.postMessage({
          type: 'systemMessage',
          text: `The model returned an invalid edit proposal. Trying a repair pass.`
        });
        await this.postMessage({
          type: 'setStatus',
          text: 'Repairing proposal'
        });

        let repairedResponseText = '';
        await client.streamChat(
          selectedModel,
          buildEditRepairMessages(target, prompt, responseText, repairReason),
          async (text) => {
            repairedResponseText += text;
          }
        );

        proposal = parseEditProposalResponse(repairedResponseText, target);
        const repairedValidationError = validateEditProposal(target, proposal, prompt);
        if (repairedValidationError) {
          throw new Error(repairedValidationError);
        }
      }

      const pendingEdit = createPendingEdit(target, proposal);
      const userMessage: ChatMessage = { role: 'user', content: `Propose edit: ${prompt}` };

      if (!pendingEdit) {
        const assistantMessage = 'The proposed edit did not change the file.';
        this.pendingEdit = undefined;
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
        await this.postMessage({
          type: 'setStatus',
          text: this.getIdleStatusText()
        });
        return;
      }

      this.pendingEdit = pendingEdit;
      await this.refreshPendingEdit();
      await this.postMessage({
        type: 'assistantStart'
      });
      await this.postMessage({
        type: 'assistantChunk',
        text: `Prepared a pending edit for ${pendingEdit.relativePath}.\n${pendingEdit.summary}`
      });
      await this.postMessage({
        type: 'assistantEnd'
      });
      this.conversation.push(userMessage, {
        role: 'assistant',
        content: `Prepared a pending edit for ${pendingEdit.relativePath}. ${pendingEdit.summary}`
      });
      await this.postMessage({
        type: 'systemMessage',
        text: 'Use Preview Diff, Apply, or Reject in the pending edit panel.'
      });
      await this.postMessage({
        type: 'setStatus',
        text: this.getIdleStatusText()
      });
    } catch (error) {
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
      this.isBusy = false;
      await this.postMessage({
        type: 'setBusy',
        busy: false
      });
    }
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
      const models = await client.listModels();
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

      const editorContext = captureEditorContext(this.contextState);
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

      if (useWorkspaceContext && !this.workspaceContextState.includeWorkspace) {
        await this.postMessage({
          type: 'systemMessage',
          text: 'Workspace context was auto-enabled for this command request.'
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

      const contextBlocks = [editorContext.promptBlock, workspaceContext.promptBlock];
      const groundingWarnings = this.buildGroundingWarnings(
        editorContext.promptBlock,
        workspaceContext.promptBlock,
        useWorkspaceContext
      );

      let responseText = '';
      await client.streamChat(
        selectedModel,
        buildCommandProposalMessages(target, prompt, contextBlocks, groundingWarnings),
        async (text) => {
          responseText += text;
        }
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
          }
        );

        proposal = parseCommandProposalResponse(repairedResponseText);
        const repairedValidationError = validateCommandProposal(proposal);
        if (repairedValidationError) {
          throw new Error(repairedValidationError);
        }
      }

      this.pendingCommand = createPendingCommand(target, proposal);
      await this.refreshPendingCommand();

      const userMessage: ChatMessage = { role: 'user', content: `Suggest command: ${prompt}` };
      const assistantMessage = [
        `Prepared a pending terminal command.`,
        this.pendingCommand.summary,
        `Command: ${this.pendingCommand.command}`,
        `Run from: ${this.pendingCommand.cwdLabel}`
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
      await this.postMessage({
        type: 'systemMessage',
        text: 'Use Run or Reject in the pending command panel.'
      });
      await this.postMessage({
        type: 'setStatus',
        text: this.getIdleStatusText()
      });
    } catch (error) {
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
      this.isBusy = false;
      await this.postMessage({
        type: 'setBusy',
        busy: false
      });
    }
  }

  private async previewPendingEdit(): Promise<void> {
    if (!this.pendingEdit) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending edit to preview.'
      });
      return;
    }

    const previewDocument = await vscode.workspace.openTextDocument({
      language: this.pendingEdit.language,
      content: this.pendingEdit.proposedText
    });

    await vscode.commands.executeCommand(
      'vscode.diff',
      this.pendingEdit.documentUri,
      previewDocument.uri,
      `${this.pendingEdit.relativePath} (Local Agent Proposal)`
    );
  }

  private async applyPendingEdit(): Promise<void> {
    if (!this.pendingEdit) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending edit to apply.'
      });
      return;
    }

    const document = await vscode.workspace.openTextDocument(this.pendingEdit.documentUri);
    if (
      document.version !== this.pendingEdit.originalVersion ||
      document.getText() !== this.pendingEdit.originalText
    ) {
      await this.postMessage({
        type: 'systemMessage',
        text:
          'The target file changed after the proposal was generated. Reject this edit and generate a new one.'
      });
      return;
    }

    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, fullRange, this.pendingEdit.proposedText);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'VS Code rejected the pending edit.'
      });
      return;
    }

    await this.postMessage({
      type: 'systemMessage',
      text: `Applied pending edit to ${this.pendingEdit.relativePath}.`
    });
    this.pendingEdit = undefined;
    await this.refreshPendingEdit();
    await this.postMessage({
      type: 'setStatus',
      text: this.getIdleStatusText()
    });
  }

  private async rejectPendingEdit(): Promise<void> {
    if (!this.pendingEdit) {
      await this.postMessage({
        type: 'systemMessage',
        text: 'There is no pending edit to reject.'
      });
      return;
    }

    const path = this.pendingEdit.relativePath;
    this.pendingEdit = undefined;
    await this.refreshPendingEdit();
    await this.postMessage({
      type: 'systemMessage',
      text: `Rejected pending edit for ${path}.`
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

    const terminal = vscode.window.createTerminal({
      name: 'Local Agent',
      cwd: this.pendingCommand.cwd
    });
    terminal.show(true);
    terminal.sendText(this.pendingCommand.command, true);

    const command = this.pendingCommand.command;
    const cwdLabel = this.pendingCommand.cwdLabel;
    this.pendingCommand = undefined;
    await this.refreshPendingCommand();
    await this.postMessage({
      type: 'systemMessage',
      text: `Sent command to the integrated terminal from ${cwdLabel}: ${command}`
    });
    await this.postMessage({
      type: 'setStatus',
      text: this.getIdleStatusText()
    });
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
    this.pendingCommand = undefined;
    await this.refreshPendingCommand();
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
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage(message);
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
      <header class="topbar">
        <div>
          <p class="eyebrow">Local Agent</p>
          <h1>Chat</h1>
          <p id="connection" class="connection">Checking local Ollama...</p>
        </div>
        <span id="status" class="status">Booting</span>
      </header>

      <main id="transcript" class="transcript" aria-live="polite">
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
        </section>

        <section id="pending-edit" class="pending-edit hidden" aria-label="Pending edit">
          <div class="pending-edit-header">
            <p class="pending-edit-eyebrow">Pending Edit</p>
            <h2 id="pending-edit-path" class="pending-edit-path">No pending edit</h2>
          </div>
          <p id="pending-edit-summary" class="pending-edit-summary"></p>
          <p id="pending-edit-stats" class="pending-edit-stats"></p>
          <div class="pending-edit-actions">
            <button type="button" data-pending-edit-action="preview">Preview Diff</button>
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

        <section class="empty-state">
          <h2>Sidebar shell ready</h2>
          <p>Use this view as the base for streaming chat, tool activity, and approvals.</p>
        </section>
      </main>

      <form id="composer" class="composer">
        <label class="composer-label" for="prompt">Prompt</label>
        <textarea
          id="prompt"
          rows="5"
          placeholder="Ask the local agent something..."
        ></textarea>
        <div class="composer-actions">
          <button type="submit" data-submit-action="chat">Send</button>
          <button type="submit" data-submit-action="edit" class="subtle">Propose Edit</button>
          <button type="submit" data-submit-action="command" class="subtle">Suggest Command</button>
        </div>
      </form>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private getConfig(): {
    baseUrl: string;
    model: string;
    editModel: string;
    allowTerminal: boolean;
  } {
    const configuration = vscode.workspace.getConfiguration('localAgent');
    return {
      baseUrl: configuration.get<string>('ollamaBaseUrl', 'http://127.0.0.1:11434'),
      model: configuration.get<string>('model', '').trim(),
      editModel: configuration.get<string>('editModel', '').trim(),
      allowTerminal: configuration.get<boolean>('allowTerminal', true)
    };
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

  private formatPendingEditStats(pendingEdit: PendingEdit): string {
    const deltaPrefix = pendingEdit.stats.deltaLines > 0 ? '+' : '';

    return `${pendingEdit.stats.originalLines} lines -> ${pendingEdit.stats.proposedLines} lines (${deltaPrefix}${pendingEdit.stats.deltaLines}).`;
  }

  private buildGroundingWarnings(
    editorContext?: string,
    workspaceContext?: string,
    usedWorkspaceContext = false
  ): string[] {
    const warnings: string[] = [];

    if (usedWorkspaceContext && !workspaceContext) {
      warnings.push(
        'No grounded workspace results were found for this turn. If the user asks for exact file names or repository facts, say that you cannot verify them from the current context.'
      );
    }

    if (
      (this.contextState.includeCurrentFile || this.contextState.includeSelection) &&
      !editorContext
    ) {
      warnings.push(
        'Requested editor context was not available for this turn. Do not claim details from the active file or selection unless they were explicitly provided.'
      );
    }

    return warnings;
  }

  private getIdleStatusText(): string {
    if (this.pendingEdit && this.pendingCommand) {
      return 'Pending approvals';
    }

    if (this.pendingEdit) {
      return 'Pending edit';
    }

    if (this.pendingCommand) {
      return 'Pending command';
    }

    return 'Idle';
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
