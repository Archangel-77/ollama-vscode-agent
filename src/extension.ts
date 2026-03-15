import * as vscode from 'vscode';
import { TodoCodeLensArgs, TodoCodeLensProvider } from './codelens/TodoCodeLensProvider';
import { ChatViewProvider } from './webview/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri, context.workspaceState);
  const openSidebar = async (): Promise<void> => {
    const preferSecondary = vscode.workspace
      .getConfiguration('localAgent')
      .get<boolean>('preferSecondarySidebar', false);

    if (preferSecondary) {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.localAgentSecondary');
      } catch {
        await vscode.commands.executeCommand('workbench.view.extension.localAgent');
      }
    } else {
      await vscode.commands.executeCommand('workbench.view.extension.localAgent');
    }

    provider.focus();
  };
  const todoCodeLensProvider = new TodoCodeLensProvider();

  const openCommandMenu = async (): Promise<void> => {
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: 'New Thread',
          description: 'Start a fresh Local Agent thread',
          run: async () => {
            await openSidebar();
            await provider.startNewThread();
          }
        },
        {
          label: 'Open Chat',
          description: 'Focus the Local Agent sidebar',
          run: async () => {
            await openSidebar();
          }
        },
        {
          label: 'Add Selection to Thread',
          description: 'Use the current selection as context',
          run: async () => {
            await openSidebar();
            await provider.setSelectionContextEnabled(true);
          }
        },
        {
          label: 'Add File to Thread',
          description: 'Use the current file as context',
          run: async () => {
            await openSidebar();
            await provider.setCurrentFileContextEnabled(true);
          }
        },
        {
          label: 'Ask About Workspace',
          description: 'Enable workspace context',
          run: async () => {
            await openSidebar();
            await provider.setWorkspaceContextEnabled(true);
          }
        },
        {
          label: 'Find In Thread',
          description: 'Search inside the current Local Agent transcript',
          run: async () => {
            await openSidebar();
            await provider.showFindInThread();
          }
        },
        {
          label: 'Fix Problems',
          description: 'Prepare a reviewed fix from current diagnostics',
          run: async () => {
            await openSidebar();
            await provider.setProblemsContextEnabled(true);
            await provider.proposeProblemFix();
          }
        },
        {
          label: 'Fix Last Failure',
          description: 'Prepare a reviewed fix from captured terminal output',
          run: async () => {
            await openSidebar();
            await provider.proposeLastFailureFix();
          }
        },
        {
          label: 'Settings',
          description: 'Open Local Agent settings',
          run: async () => {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:local-agent localAgent'
            );
          }
        }
      ],
      {
        title: 'Local Agent Command Menu',
        placeHolder: 'Choose a Local Agent action'
      }
    );

    if (!picked) {
      return;
    }

    await picked.run();
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.secondaryViewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    }),
    vscode.commands.registerCommand('localAgent.openChat', async () => {
      await openSidebar();
    }),
    vscode.commands.registerCommand('localAgent.openCommandMenu', async () => {
      await openCommandMenu();
    }),
    vscode.commands.registerCommand('localAgent.findInThread', async () => {
      await openSidebar();
      await provider.showFindInThread();
    }),
    vscode.commands.registerCommand(
      'localAgent.implementTodo',
      async (args?: TodoCodeLensArgs) => {
        if (!args?.uri || typeof args.line !== 'number') {
          return;
        }

        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
        const editor = await vscode.window.showTextDocument(document, {
          preview: false
        });
        const line = Math.max(0, Math.min(args.line, document.lineCount - 1));
        const lineRange = document.lineAt(line).range;
        editor.selection = new vscode.Selection(lineRange.start, lineRange.end);
        editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

        await openSidebar();
        await provider.setCurrentFileContextEnabled(true);
        await provider.setSelectionContextEnabled(true);
        await provider.proposeReviewedEdit(
          `Implement this TODO exactly and keep the change scoped to the selected comment and surrounding code:\n${args.comment}`
        );
      }
    ),
    vscode.commands.registerCommand('localAgent.newThread', async () => {
      await openSidebar();
      await provider.startNewThread();
    }),
    vscode.commands.registerCommand('localAgent.askSelection', async () => {
      await openSidebar();
      await provider.setSelectionContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.addSelectionToThread', async () => {
      await openSidebar();
      await provider.setSelectionContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.askCurrentFile', async () => {
      await openSidebar();
      await provider.setCurrentFileContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.addFileToThread', async () => {
      await openSidebar();
      await provider.setCurrentFileContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.askWorkspace', async () => {
      await openSidebar();
      await provider.setWorkspaceContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.askProblems', async () => {
      await openSidebar();
      await provider.setProblemsContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.fixProblems', async () => {
      await openSidebar();
      await provider.setProblemsContextEnabled(true);
      await provider.proposeProblemFix();
    }),
    vscode.commands.registerCommand('localAgent.fixLastFailure', async () => {
      await openSidebar();
      await provider.proposeLastFailureFix();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('localAgent')) {
        void provider.refreshConnectionStatus();
        void provider.refreshUiPreferences();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void provider.refreshEditorContext();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      void provider.refreshEditorContext();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document === event.document) {
        void provider.refreshEditorContext();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.refreshEditorContext();
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      void provider.refreshEditorContext();
    }),
    vscode.window.onDidStartTerminalShellExecution((event) => {
      provider.trackTerminalExecutionStart(event);
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      void provider.trackTerminalExecutionEnd(event);
    }),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      {
        provideCodeLenses(document, token) {
          if (
            !vscode.workspace
              .getConfiguration('localAgent')
              .get<boolean>('commentCodeLensEnabled', true)
          ) {
            return [];
          }

          return todoCodeLensProvider.provideCodeLenses(document, token);
        }
      }
    )
  );

  void provider.refreshConnectionStatus();
  void provider.refreshEditorContext();
  void provider.refreshUiPreferences();

  if (vscode.workspace.getConfiguration('localAgent').get<boolean>('openOnStartup', false)) {
    void openSidebar();
  }
}

export function deactivate(): void {}
