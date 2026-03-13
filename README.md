# ollama-vscode-agent

Local-first VS Code extension that connects to Ollama for chat, grounded workspace context, reviewed code edits, and approved terminal command execution.

## Features

- Streaming chat against local Ollama models
- Current file, selection, and workspace context
- Deterministic workspace file listing for simple file queries
- Pending edit workflow with diff preview and explicit apply/reject
- Pending terminal command workflow with explicit run/reject
- Separate chat and edit model settings

## Requirements

- Windows with VS Code
- Node.js and npm
- Ollama running locally
- One or more local coding models installed in Ollama

## Development

```powershell
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host.

## Settings

- `localAgent.ollamaBaseUrl`
- `localAgent.model`
- `localAgent.editModel`
- `localAgent.allowTerminal`
