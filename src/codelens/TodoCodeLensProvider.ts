import * as vscode from 'vscode';

const TODO_PATTERN =
  /^\s*(?:#|\/\/|\/\*+|\*|<!--|;|--)\s*(TODO|FIXME)\s*:?\s*(.+?)\s*$/gim;

export interface TodoCodeLensArgs {
  uri: string;
  line: number;
  comment: string;
}

export class TodoCodeLensProvider implements vscode.CodeLensProvider {
  public provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const text = document.getText();
    const lenses: vscode.CodeLens[] = [];
    let match: RegExpExecArray | null;

    while ((match = TODO_PATTERN.exec(text)) !== null) {
      if (token.isCancellationRequested) {
        break;
      }

      const index = match.index;
      const position = document.positionAt(index);
      const range = new vscode.Range(position, position);
      const comment = match[2].trim();

      lenses.push(
        new vscode.CodeLens(range, {
          title: 'Implement with Local Agent',
          command: 'localAgent.implementTodo',
          arguments: [
            {
              uri: document.uri.toString(),
              line: position.line,
              comment
            } satisfies TodoCodeLensArgs
          ]
        })
      );
    }

    return lenses;
  }
}
