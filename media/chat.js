(function () {
  const vscode = acquireVsCodeApi();
  const transcript = document.getElementById('transcript');
  const composer = document.getElementById('composer');
  const promptInput = document.getElementById('prompt');
  const status = document.getElementById('status');
  const connection = document.getElementById('connection');
  const submitButtons = Array.from(composer.querySelectorAll('[data-submit-action]'));
  const currentFileDetail = document.getElementById('current-file-detail');
  const selectionDetail = document.getElementById('selection-detail');
  const workspaceDetail = document.getElementById('workspace-detail');
  const contextButtons = Array.from(document.querySelectorAll('[data-context-target]'));
  const pendingEditSection = document.getElementById('pending-edit');
  const pendingEditPath = document.getElementById('pending-edit-path');
  const pendingEditSummary = document.getElementById('pending-edit-summary');
  const pendingEditStats = document.getElementById('pending-edit-stats');
  const pendingEditButtons = Array.from(document.querySelectorAll('[data-pending-edit-action]'));
  const pendingCommandSection = document.getElementById('pending-command');
  const pendingCommandSummary = document.getElementById('pending-command-summary');
  const pendingCommandText = document.getElementById('pending-command-text');
  const pendingCommandCwd = document.getElementById('pending-command-cwd');
  const pendingCommandButtons = Array.from(
    document.querySelectorAll('[data-pending-command-action]')
  );
  let activeAssistantBody = null;
  let isBusy = false;

  function appendMessage(role, text) {
    const emptyState = transcript.querySelector('.empty-state');
    if (emptyState) {
      emptyState.remove();
    }

    const article = document.createElement('article');
    article.className = `message ${role}`;

    const label = document.createElement('p');
    label.className = 'message-role';
    label.textContent = role === 'assistant' ? 'Assistant' : 'System';

    const body = document.createElement('p');
    body.className = 'message-text';
    body.textContent = text;

    article.appendChild(label);
    article.appendChild(body);
    transcript.appendChild(article);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function startAssistantMessage() {
    const emptyState = transcript.querySelector('.empty-state');
    if (emptyState) {
      emptyState.remove();
    }

    const article = document.createElement('article');
    article.className = 'message assistant';

    const label = document.createElement('p');
    label.className = 'message-role';
    label.textContent = 'Assistant';

    const body = document.createElement('p');
    body.className = 'message-text';
    body.textContent = '';

    article.appendChild(label);
    article.appendChild(body);
    transcript.appendChild(article);
    transcript.scrollTop = transcript.scrollHeight;
    activeAssistantBody = body;
  }

  function appendAssistantChunk(text) {
    if (!activeAssistantBody) {
      startAssistantMessage();
    }

    activeAssistantBody.textContent += text;
    transcript.scrollTop = transcript.scrollHeight;
  }

  composer.addEventListener('submit', function (event) {
    event.preventDefault();

    if (isBusy) {
      return;
    }

    const text = promptInput.value.trim();
    if (!text) {
      return;
    }

    const submitter = event.submitter;
    const submitAction =
      submitter && submitter.dataset ? submitter.dataset.submitAction || 'chat' : 'chat';

    appendMessage('system', `You: ${text}`);
    vscode.postMessage(
      submitAction === 'edit'
        ? {
            type: 'proposeEdit',
            text
          }
        : submitAction === 'command'
          ? {
              type: 'proposeCommand',
              text
            }
          : {
              type: 'sendPrompt',
              text
            }
    );
    promptInput.value = '';
  });

  contextButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      const enabled = button.getAttribute('aria-pressed') !== 'true';
      vscode.postMessage({
        type: 'setContextEnabled',
        target: button.dataset.contextTarget,
        enabled
      });
    });
  });

  pendingEditButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      switch (button.dataset.pendingEditAction) {
        case 'preview':
          vscode.postMessage({ type: 'previewPendingEdit' });
          break;
        case 'apply':
          vscode.postMessage({ type: 'applyPendingEdit' });
          break;
        case 'reject':
          vscode.postMessage({ type: 'rejectPendingEdit' });
          break;
      }
    });
  });

  pendingCommandButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      switch (button.dataset.pendingCommandAction) {
        case 'run':
          vscode.postMessage({ type: 'runPendingCommand' });
          break;
        case 'reject':
          vscode.postMessage({ type: 'rejectPendingCommand' });
          break;
      }
    });
  });

  window.addEventListener('message', function (event) {
    const message = event.data;

    switch (message.type) {
      case 'systemMessage':
        appendMessage('system', message.text);
        break;
      case 'assistantStart':
        startAssistantMessage();
        break;
      case 'assistantChunk':
        appendAssistantChunk(message.text);
        break;
      case 'assistantEnd':
        activeAssistantBody = null;
        break;
      case 'setStatus':
        status.textContent = message.text;
        break;
      case 'setConnection':
        connection.textContent = message.text;
        break;
      case 'setContextState':
        currentFileDetail.textContent = message.context.currentFile.detail;
        selectionDetail.textContent = message.context.selection.detail;
        workspaceDetail.textContent = message.context.workspace.detail;
        syncContextButton('currentFile', message.context.currentFile);
        syncContextButton('selection', message.context.selection);
        syncContextButton('workspace', message.context.workspace);
        break;
      case 'setPendingEdit':
        syncPendingEdit(message.pendingEdit);
        break;
      case 'setPendingCommand':
        syncPendingCommand(message.pendingCommand);
        break;
      case 'setBusy':
        isBusy = message.busy;
        promptInput.disabled = message.busy;
        submitButtons.forEach(function (button) {
          button.disabled = message.busy;
        });
        contextButtons.forEach(function (button) {
          button.disabled = message.busy;
        });
        pendingEditButtons.forEach(function (button) {
          button.disabled = message.busy;
        });
        pendingCommandButtons.forEach(function (button) {
          button.disabled = message.busy;
        });
        if (!message.busy) {
          promptInput.focus();
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });

  function syncContextButton(target, state) {
    const button = contextButtons.find(function (candidate) {
      return candidate.dataset.contextTarget === target;
    });

    if (!button) {
      return;
    }

    button.setAttribute('aria-pressed', String(state.enabled));
    button.classList.toggle('active', state.enabled);
    button.classList.toggle('unavailable', !state.available);
  }

  function syncPendingEdit(pendingEdit) {
    if (!pendingEdit) {
      pendingEditSection.classList.add('hidden');
      pendingEditPath.textContent = 'No pending edit';
      pendingEditSummary.textContent = '';
      pendingEditStats.textContent = '';
      return;
    }

    pendingEditSection.classList.remove('hidden');
    pendingEditPath.textContent = pendingEdit.path;
    pendingEditSummary.textContent = pendingEdit.summary;
    pendingEditStats.textContent = pendingEdit.statsText;
  }

  function syncPendingCommand(pendingCommand) {
    if (!pendingCommand) {
      pendingCommandSection.classList.add('hidden');
      pendingCommandSummary.textContent = 'No pending terminal command';
      pendingCommandText.textContent = '';
      pendingCommandCwd.textContent = '';
      return;
    }

    pendingCommandSection.classList.remove('hidden');
    pendingCommandSummary.textContent = pendingCommand.summary;
    pendingCommandText.textContent = pendingCommand.command;
    pendingCommandCwd.textContent = `Run from: ${pendingCommand.cwdLabel}`;
  }
})();
