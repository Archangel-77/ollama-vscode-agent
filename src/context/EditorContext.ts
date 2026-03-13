import * as vscode from 'vscode';

const MAX_FILE_CHARS = 12000;
const MAX_SELECTION_CHARS = 6000;

export interface EditorContextState {
  includeCurrentFile: boolean;
  includeSelection: boolean;
}

export interface EditorContextSummary {
  currentFile: {
    enabled: boolean;
    available: boolean;
    label: string;
    detail: string;
  };
  selection: {
    enabled: boolean;
    available: boolean;
    label: string;
    detail: string;
  };
}

export interface CapturedEditorContext {
  promptBlock?: string;
  notices: string[];
}

export function getEditorContextSummary(state: EditorContextState): EditorContextSummary {
  const editor = getPreferredEditor();
  const hasEditor = Boolean(editor);
  const hasSelection = Boolean(editor && !editor.selection.isEmpty);

  return {
    currentFile: {
      enabled: state.includeCurrentFile,
      available: hasEditor,
      label: 'Current file',
      detail: hasEditor
        ? vscode.workspace.asRelativePath(editor!.document.uri, false)
        : 'No active editor'
    },
    selection: {
      enabled: state.includeSelection,
      available: hasSelection,
      label: 'Selection',
      detail: hasSelection
        ? selectionDetail(editor!)
        : hasEditor
          ? 'No selection in active editor'
          : 'No active editor'
    }
  };
}

export function captureEditorContext(state: EditorContextState): CapturedEditorContext {
  const editor = getPreferredEditor();
  if (!editor) {
    return {
      notices: buildNoEditorNotices(state)
    };
  }

  const sections: string[] = [];
  const notices: string[] = [];
  const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
  const language = editor.document.languageId || 'plaintext';

  if (state.includeCurrentFile) {
    const fullText = editor.document.getText();
    const truncatedText = truncate(fullText, MAX_FILE_CHARS);
    sections.push(
      [
        `<current-file path="${relativePath}" language="${language}" truncated="${String(
          truncatedText.truncated
        )}">`,
        truncatedText.text,
        '</current-file>'
      ].join('\n')
    );

    notices.push(
      truncatedText.truncated
        ? `Included current file: ${relativePath} (truncated to ${MAX_FILE_CHARS} characters).`
        : `Included current file: ${relativePath}.`
    );
  }

  if (state.includeSelection) {
    if (editor.selection.isEmpty) {
      notices.push('Selection context was requested, but there is no active selection.');
    } else {
      const selectionText = editor.document.getText(editor.selection);
      const truncatedText = truncate(selectionText, MAX_SELECTION_CHARS);
      sections.push(
        [
          `<selection path="${relativePath}" language="${language}" startLine="${
            editor.selection.start.line + 1
          }" endLine="${editor.selection.end.line + 1}" truncated="${String(
            truncatedText.truncated
          )}">`,
          truncatedText.text,
          '</selection>'
        ].join('\n')
      );

      notices.push(
        truncatedText.truncated
          ? `Included selected text from ${relativePath} (truncated to ${MAX_SELECTION_CHARS} characters).`
          : `Included selected text from ${relativePath}.`
      );
    }
  }

  if (sections.length === 0) {
    return { notices };
  }

  return {
    promptBlock: [
      'Editor context for this turn only.',
      'Use it as authoritative workspace context when it is relevant.',
      ...sections
    ].join('\n\n'),
    notices
  };
}

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return {
      text,
      truncated: false
    };
  }

  return {
    text: `${text.slice(0, limit)}\n\n[truncated]`,
    truncated: true
  };
}

function selectionDetail(editor: vscode.TextEditor): string {
  return `${vscode.workspace.asRelativePath(editor.document.uri, false)}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
}

function buildNoEditorNotices(state: EditorContextState): string[] {
  const notices: string[] = [];

  if (state.includeCurrentFile) {
    notices.push('Current file context was requested, but there is no active editor.');
  }

  if (state.includeSelection) {
    notices.push('Selection context was requested, but there is no active editor.');
  }

  return notices;
}

function getPreferredEditor(): vscode.TextEditor | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.uri.scheme === 'file') {
    return activeEditor;
  }

  return (
    vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === 'file') ??
    activeEditor
  );
}
