import * as vscode from 'vscode';
import { ChatViewProvider } from './webview/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    vscode.commands.registerCommand('localAgent.openChat', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.localAgent');
      provider.focus();
    }),
    vscode.commands.registerCommand('localAgent.askSelection', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.localAgent');
      provider.focus();
      await provider.setSelectionContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.askCurrentFile', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.localAgent');
      provider.focus();
      await provider.setCurrentFileContextEnabled(true);
    }),
    vscode.commands.registerCommand('localAgent.askWorkspace', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.localAgent');
      provider.focus();
      await provider.setWorkspaceContextEnabled(true);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('localAgent')) {
        void provider.refreshConnectionStatus();
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
    })
  );

  void provider.refreshConnectionStatus();
  void provider.refreshEditorContext();
}

export function deactivate(): void {}
